/**
 * Read-only, bounded telemetry for the Protractor timed-live operator view.
 *
 * This deliberately does not reuse the broad usage dashboard readers: the
 * operator view must never turn a live incident into an unbounded fleet scan.
 * Every Mongo query below is pinned to an existing index and every returned
 * value is an aggregate or timestamp -- never a credential, callback key,
 * VIN, payload, customer field, or provider error body.
 */
import type { Document } from "mongodb";
import { and, asc, desc, eq, gte, or, sql } from "drizzle-orm";
import { getDb as getMongoDb } from "@/lib/data/db";
import { getDb as getPgDb } from "@/lib/db/drizzle";
import { apiUsage } from "@/lib/db/schema/integration-ops";
import { protractorCallbackEvents } from "@/lib/db/schema/wave3";
import { getCallbackOutcomeReport } from "@/lib/data/repositories/protractor-callback-events";

const RELAY_SAMPLE_LIMIT = 50;
const QUEUE_SAMPLE_PER_EDGE = 50;
const RECENT_TELEMETRY_WINDOW_MS = 24 * 60 * 60_000;
const CALLBACK_METHODS = ["GET", "POST"] as const;
const CALLBACK_PRIORITIES = [0, 1] as const;
const STALE_RELAY_MS = 5 * 60_000;
const QUERY_MAX_MS = 2_500;

type MonitorStatus = "sampled" | "partial" | "stale" | "empty" | "error";

type RelayRow = {
  timestamp: Date;
  statusCode: number;
  latencyMs: number | null;
};

type PendingRow = {
  key: string;
  receivedAt: Date;
  objectType: string | null;
  attempts: number;
  outcomeReason: string | null;
};

export type ProtractorLiveMonitor = {
  generatedAt: string;
  scope: {
    environment: "production";
    apiUsageCanonical: "mongo" | "postgres";
    callbackCanonical: "mongo" | "postgres";
    note: string;
  };
  relay: {
    status: MonitorStatus;
    sampleLimit: number;
    sampled: number;
    newestAt: string | null;
    durationScope: "client_attempt_including_local_admission_wait";
    latencySampled: number;
    averageLatencyMs: number | null;
    p95LatencyMs: number | null;
    outcomes: Record<string, number>;
    note: string;
  };
  callbacks: {
    status: MonitorStatus;
    sampleLimit: number;
    sampled: number;
    activationCohortStatus: "available" | "not_live" | "error";
    liveActivation: QueueSample | null;
    heldBacklog: QueueSample;
    retainedContactsSampled: number;
    lastProgressAt: string | null;
    outcomes: {
      status: "sampled" | "error";
      sampleLimit: number;
      sampled: number;
      liveActivation: Record<string, number> | null;
      heldBacklog: Record<string, number>;
      note: string;
    };
    note: string;
  };
  breaker: {
    status: "sampled" | "empty" | "error";
    state: "open" | "probe" | "closed" | "unknown";
    openUntil: string | null;
    probeUntil: string | null;
    updatedAt: string | null;
    alerting: {
      transitionWiring: "present";
      deliveryStatus: "not-observable";
      note: string;
    };
  };
};

export type QueueSample = {
  pendingSampled: number;
  actionableSampled: number;
  attemptsAtLeast3Sampled: number;
  oldestActionableAgeMs: number | null;
};

type TransportState = {
  liveStartedAt: Date | null;
};

export const __protractorLiveMonitorTestHooks: {
  mongoDb: typeof getMongoDb;
  pgDb: typeof getPgDb;
  callbackOutcomeReport: typeof getCallbackOutcomeReport;
  now: () => Date;
} = {
  mongoDb: getMongoDb,
  pgDb: getPgDb,
  callbackOutcomeReport: getCallbackOutcomeReport,
  now: () => new Date(),
};

function apiUsagePgCanonical(): boolean {
  return process.env.API_USAGE_PG_CANONICAL === "1";
}

function callbackPgCanonical(): boolean {
  return process.env.PROTRACTOR_OPS_PG_CANONICAL === "1";
}

function iso(value: Date | null | undefined): string | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  return null;
}

function numberOr(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function isRetainedContact(row: PendingRow): boolean {
  // Contact callbacks are retained evidence, not callback-drain work. Older
  // rows can predate the explicit unsupported_contact outcome; treating every
  // Contact as non-actionable keeps that historical gap from inflating queue
  // age or retry pressure.
  return row.objectType === "Contact";
}

function summarizeQueue(rows: PendingRow[], now: Date): QueueSample {
  const retryExhausted = rows.filter((row) => !isRetainedContact(row) && row.attempts >= 3);
  const actionable = rows.filter((row) => !isRetainedContact(row) && row.attempts < 3);
  const oldest = actionable.reduce<Date | null>((value, row) =>
    !value || row.receivedAt < value ? row.receivedAt : value, null);
  return {
    pendingSampled: rows.length,
    actionableSampled: actionable.length,
    attemptsAtLeast3Sampled: retryExhausted.length,
    oldestActionableAgeMs: oldest ? Math.max(0, now.getTime() - oldest.getTime()) : null,
  };
}

function summarizeOutcomes(
  rows: Array<{ receivedAt: string | null; category: string }>,
  startedAt: Date | null,
): { liveActivation: Record<string, number> | null; heldBacklog: Record<string, number> } {
  const liveActivation: Record<string, number> = {};
  const heldBacklog: Record<string, number> = {};
  for (const row of rows) {
    const receivedAt = asDate(row.receivedAt);
    const target = startedAt && receivedAt && receivedAt >= startedAt ? liveActivation : heldBacklog;
    target[row.category] = (target[row.category] ?? 0) + 1;
  }
  return { liveActivation: startedAt ? liveActivation : null, heldBacklog };
}

function relaySummary(rows: RelayRow[], now: Date): ProtractorLiveMonitor["relay"] {
  const newest = rows.reduce<Date | null>((value, row) =>
    !value || row.timestamp > value ? row.timestamp : value, null);
  const latencies = rows
    .flatMap((row) => row.latencyMs === null ? [] : [row.latencyMs])
    .sort((a, b) => a - b);
  const outcomes: Record<string, number> = {};
  for (const row of rows) {
    const key = row.statusCode >= 200 && row.statusCode < 300
      ? "success"
      : row.statusCode === 429 ? "rate_limited"
        : row.statusCode >= 500 ? "server_or_transport_error"
          : "other_http_error";
    outcomes[key] = (outcomes[key] ?? 0) + 1;
  }
  const status: MonitorStatus = rows.length === 0
    ? "empty"
    : newest && now.getTime() - newest.getTime() > STALE_RELAY_MS
      ? "stale"
      : "sampled";
  return {
    status,
    sampleLimit: RELAY_SAMPLE_LIMIT,
    sampled: rows.length,
    newestAt: iso(newest),
    durationScope: "client_attempt_including_local_admission_wait",
    latencySampled: latencies.length,
    averageLatencyMs: latencies.length
      ? Math.round(latencies.reduce((total, latency) => total + latency, 0) / latencies.length)
      : null,
    p95LatencyMs: latencies.length ? latencies[Math.ceil(latencies.length * 0.95) - 1] : null,
    outcomes,
    note: "Recent production relay-transport responses only; duration is client-measured per attempt and can include local admission wait, not relay-side latency. These are bounded samples, not fleet totals.",
  };
}

async function readTransportState(): Promise<TransportState> {
  const db = await __protractorLiveMonitorTestHooks.mongoDb();
  const row = await db.collection<Document>("api_rate_limits").findOne(
    { _id: "protractor-physical-transport-v1" } as Document,
    {
      projection: { canary: 1, operatorStop: 1 },
      hint: "_id_",
      maxTimeMS: QUERY_MAX_MS,
    },
  );
  const canary = row?.canary as Record<string, unknown> | undefined;
  const operatorStop = row?.operatorStop as Record<string, unknown> | undefined;
  const startedAt = asDate(canary?.startedAt);
  const expiresAt = asDate(canary?.expiresAt);
  const validTimedTrial = canary?.mode === "timed_trial" &&
    !canary?.endedBy &&
    operatorStop?.active !== true &&
    !!startedAt &&
    !!expiresAt &&
    expiresAt.getTime() > __protractorLiveMonitorTestHooks.now().getTime();
  // Match the reviewed continuous-mode persisted shape rather than inferring
  // liveness from a mode string. A malformed or terminal record must not
  // quietly classify old work as new live traffic.
  const validContinuousLive = !!canary &&
    canary.mode === "live" &&
    typeof canary.generation === "string" &&
    canary.scope === "callbacks_and_interactive" &&
    canary.requiresCallback === false &&
    canary.requiresRelay === true &&
    canary.workersSuspendedConfirmed === true &&
    !!startedAt &&
    startedAt.getTime() <= __protractorLiveMonitorTestHooks.now().getTime() &&
    !Object.hasOwn(canary, "expiresAt") &&
    canary.maxAdmissions === null &&
    canary.remainingAdmissions === null &&
    Number.isSafeInteger(canary.consumedAdmissions) &&
    Number(canary.consumedAdmissions) >= 0 &&
    Array.isArray(canary.audit) &&
    (canary.auditTruncatedAdmissions === undefined ||
      (Number.isSafeInteger(canary.auditTruncatedAdmissions) &&
        Number(canary.auditTruncatedAdmissions) >= 0)) &&
    !Object.hasOwn(canary, "endedBy") &&
    !Object.hasOwn(canary, "endedAt") &&
    operatorStop?.active === false;
  return { liveStartedAt: validTimedTrial || validContinuousLive ? startedAt : null };
}

async function readMongoRelayRows(since: Date): Promise<RelayRow[]> {
  const db = await __protractorLiveMonitorTestHooks.mongoDb();
  const rows = await db.collection<Document>("api_usage").find(
    {
      provider: "protractor",
      environment: "production",
      timestamp: { $gte: since },
      // REST relay telemetry historically used endpoint=relay. SOAP keeps its
      // endpoint name, so the durable transport marker is authoritative when
      // it exists; retain endpoint=relay for compatible pre-marker records.
      $or: [{ transport: "relay" }, { endpoint: "relay" }],
    },
    {
      projection: { timestamp: 1, statusCode: 1, latencyMs: 1 },
      hint: "provider_1_timestamp_-1",
      maxTimeMS: QUERY_MAX_MS,
    },
  ).sort({ timestamp: -1 }).limit(RELAY_SAMPLE_LIMIT).toArray();
  return rows.flatMap((row) => {
    const timestamp = asDate(row.timestamp);
    if (!timestamp) return [];
    return [{
      timestamp,
      statusCode: numberOr(row.statusCode),
      latencyMs: typeof row.latencyMs === "number" && Number.isFinite(row.latencyMs)
        ? Math.max(0, row.latencyMs)
        : null,
    }];
  });
}

async function readPgRelayRows(since: Date): Promise<RelayRow[]> {
  const db = __protractorLiveMonitorTestHooks.pgDb();
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '2500ms'`);
    const rows = await tx.select({
      timestamp: apiUsage.timestamp,
      statusCode: apiUsage.statusCode,
      latencyMs: apiUsage.latencyMs,
    }).from(apiUsage).where(and(
      eq(apiUsage.provider, "protractor"),
      gte(apiUsage.timestamp, since),
      sql`${apiUsage.extra} ->> 'environment' = 'production'`,
      or(
        eq(apiUsage.endpoint, "relay"),
        sql`${apiUsage.extra} ->> 'transport' = 'relay'`,
      ),
    )).orderBy(desc(apiUsage.timestamp)).limit(RELAY_SAMPLE_LIMIT);
    return rows.flatMap((row) => {
      const timestamp = asDate(row.timestamp);
      if (!timestamp) return [];
      return [{
        timestamp,
        statusCode: numberOr(row.statusCode),
        latencyMs: typeof row.latencyMs === "number" && Number.isFinite(row.latencyMs)
          ? Math.max(0, row.latencyMs)
          : null,
      }];
    });
  });
}

async function readMongoPendingRows(): Promise<PendingRow[]> {
  const db = await __protractorLiveMonitorTestHooks.mongoDb();
  const collection = db.collection<Document>("protractor_callback_events");
  const reads = CALLBACK_METHODS.flatMap((method) => CALLBACK_PRIORITIES.flatMap((priority) =>
    ([1, -1] as const).map((direction) => collection.find(
      { method, processed: false, priority },
      {
        projection: { _id: 1, receivedAt: 1, objectType: 1, attempts: 1, historyOutcome: 1 },
        hint: "method_1_processed_1_priority_1_receivedAt_1",
        maxTimeMS: QUERY_MAX_MS,
      },
    ).sort({ receivedAt: direction }).limit(QUEUE_SAMPLE_PER_EDGE).toArray()),
  ));
  const documents = (await Promise.all(reads)).flat();
  const seen = new Set<string>();
  return documents.flatMap((row) => {
    const receivedAt = asDate(row.receivedAt);
    const key = String(row._id ?? "");
    if (!receivedAt || !key || seen.has(key)) return [];
    seen.add(key);
    const outcome = row.historyOutcome as Record<string, unknown> | undefined;
    return [{
      key,
      receivedAt,
      objectType: typeof row.objectType === "string" ? row.objectType : null,
      attempts: Math.max(0, numberOr(row.attempts)),
      outcomeReason: typeof outcome?.reason === "string" ? outcome.reason : null,
    }];
  });
}

async function readMongoLastProgress(since: Date): Promise<Date | null> {
  const db = await __protractorLiveMonitorTestHooks.mongoDb();
  const collection = db.collection<Document>("protractor_callback_events");
  const rows = await Promise.all(CALLBACK_METHODS.map(async (method) => collection.find(
    { method, processed: true, processedAt: { $gte: since } },
    {
      projection: { processedAt: 1 },
      hint: "method_1_processedAt_-1",
      maxTimeMS: QUERY_MAX_MS,
    },
  ).sort({ processedAt: -1 }).limit(1).toArray()));
  return rows.flat().reduce<Date | null>((value, row) => {
    const processedAt = asDate(row.processedAt);
    return processedAt && (!value || processedAt > value) ? processedAt : value;
  }, null);
}

async function readPgCallbackSnapshot(since: Date): Promise<{ pending: PendingRow[]; lastProgress: Date | null }> {
  const db = __protractorLiveMonitorTestHooks.pgDb();
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '2500ms'`);
    const pendingReads = CALLBACK_METHODS.flatMap((method) => CALLBACK_PRIORITIES.flatMap((priority) =>
      ([asc, desc] as const).map(async (sort) => tx.select({
        id: protractorCallbackEvents.id,
        receivedAt: protractorCallbackEvents.receivedAt,
        objectType: protractorCallbackEvents.objectType,
        attempts: protractorCallbackEvents.attempts,
        outcomeReason: sql<string | null>`${protractorCallbackEvents.payload} -> 'historyOutcome' ->> 'reason'`,
      }).from(protractorCallbackEvents).where(and(
        eq(protractorCallbackEvents.method, method),
        eq(protractorCallbackEvents.processed, false),
        eq(protractorCallbackEvents.priority, priority),
      )).orderBy(sort(protractorCallbackEvents.receivedAt)).limit(QUEUE_SAMPLE_PER_EDGE)),
    ));
    const progressReads = CALLBACK_METHODS.map((method) => tx.select({
      processedAt: protractorCallbackEvents.processedAt,
    }).from(protractorCallbackEvents).where(and(
      eq(protractorCallbackEvents.method, method),
      eq(protractorCallbackEvents.processed, true),
      gte(protractorCallbackEvents.processedAt, since),
    )).orderBy(desc(protractorCallbackEvents.processedAt)).limit(1));
    const [pendingResults, progressResults] = await Promise.all([
      Promise.all(pendingReads),
      Promise.all(progressReads),
    ]);
    const seen = new Set<string>();
    const pending = pendingResults.flat().flatMap((row) => {
      const receivedAt = asDate(row.receivedAt);
      const key = String(row.id ?? "");
      if (!receivedAt || !key || seen.has(key)) return [];
      seen.add(key);
      return [{
        key,
        receivedAt,
        objectType: row.objectType ?? null,
        attempts: Math.max(0, numberOr(row.attempts)),
        outcomeReason: row.outcomeReason ?? null,
      }];
    });
    const lastProgress = progressResults.flat().reduce<Date | null>((value, row) => {
      const processedAt = asDate(row.processedAt);
      return processedAt && (!value || processedAt > value) ? processedAt : value;
    }, null);
    return { pending, lastProgress };
  });
}

async function readBreaker() {
  const db = await __protractorLiveMonitorTestHooks.mongoDb();
  const row = await db.collection<Document>("protractor_circuit_breakers").findOne(
    { _id: "provider" } as Document,
    {
      projection: { openUntil: 1, probeUntil: 1, updatedAt: 1 },
      hint: "_id_",
      maxTimeMS: QUERY_MAX_MS,
    },
  );
  const now = __protractorLiveMonitorTestHooks.now();
  const openUntil = asDate(row?.openUntil);
  const probeUntil = asDate(row?.probeUntil);
  return {
    status: row ? "sampled" as const : "empty" as const,
    state: !row ? "unknown" as const
      : openUntil && openUntil > now ? "open" as const
        : probeUntil && probeUntil > now ? "probe" as const
          : "closed" as const,
    openUntil: iso(openUntil),
    probeUntil: iso(probeUntil),
    updatedAt: iso(asDate(row?.updatedAt)),
    alerting: {
      transitionWiring: "present" as const,
      deliveryStatus: "not-observable" as const,
      note: "Breaker-open transitions call the existing ops alert helper (Better Stack log; Slack is optional). This read model cannot verify downstream delivery.",
    },
  };
}

async function settled<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: true }> {
  try {
    return { value: await fn() };
  } catch {
    return { error: true };
  }
}

/** Read-only monitor contract consumed by the operator client. */
export async function getProtractorLiveMonitor(): Promise<ProtractorLiveMonitor> {
  const now = __protractorLiveMonitorTestHooks.now();
  const recentSince = new Date(now.getTime() - RECENT_TELEMETRY_WINDOW_MS);
  const [transportResult, relayResult, callbackResult, outcomeResult, breakerResult] = await Promise.all([
    settled(readTransportState),
    settled(() => apiUsagePgCanonical() ? readPgRelayRows(recentSince) : readMongoRelayRows(recentSince)),
    settled(callbackPgCanonical()
      ? () => readPgCallbackSnapshot(recentSince)
      : async () => ({ pending: await readMongoPendingRows(), lastProgress: await readMongoLastProgress(recentSince) })),
    settled(__protractorLiveMonitorTestHooks.callbackOutcomeReport),
    settled(readBreaker),
  ]);

  const relay = relayResult.value
    ? relaySummary(relayResult.value, now)
    : {
      status: "error" as const,
      sampleLimit: RELAY_SAMPLE_LIMIT,
      sampled: 0,
      newestAt: null,
      durationScope: "client_attempt_including_local_admission_wait" as const,
      latencySampled: 0,
      averageLatencyMs: null,
      p95LatencyMs: null,
      outcomes: {},
      note: "Relay telemetry could not be read. No provider request was attempted.",
    };
  const pending = callbackResult.value?.pending ?? [];
  const activationCohortStatus = transportResult.error
    ? "error" as const
    : transportResult.value?.liveStartedAt ? "available" as const : "not_live" as const;
  const startedAt = activationCohortStatus === "available"
    ? transportResult.value?.liveStartedAt ?? null
    : null;
  const liveRows = startedAt ? pending.filter((row) => row.receivedAt >= startedAt) : [];
  const heldRows = startedAt ? pending.filter((row) => row.receivedAt < startedAt) : pending;
  const retainedContactsSampled = pending.filter(isRetainedContact).length;
  const outcomeRows = outcomeResult.value?.rows ?? [];
  const outcomes = summarizeOutcomes(outcomeRows, startedAt);
  const liveQueue = summarizeQueue(liveRows, now);
  const heldQueue = summarizeQueue(heldRows, now);
  // Old held-backlog rows are intentionally not a page condition. Only work
  // admitted after the active cohort began is stale, and only when it is old
  // enough with no callback progress signal at all or within the same window.
  const liveActionableStalled = liveQueue.actionableSampled > 0 &&
    liveQueue.oldestActionableAgeMs !== null &&
    liveQueue.oldestActionableAgeMs > STALE_RELAY_MS &&
    (!callbackResult.value?.lastProgress ||
      now.getTime() - callbackResult.value.lastProgress.getTime() > STALE_RELAY_MS);
  const callbackStatus: MonitorStatus = callbackResult.error
    ? "error"
    : pending.length === 0 ? "empty"
      : liveActionableStalled ? "stale" : "partial";

  return {
    generatedAt: now.toISOString(),
    scope: {
      environment: "production",
      apiUsageCanonical: apiUsagePgCanonical() ? "postgres" : "mongo",
      callbackCanonical: callbackPgCanonical() ? "postgres" : "mongo",
      note: "This endpoint is production-service scoped. All queue values are index-bounded samples, never fleet-exact counts.",
    },
    relay,
    callbacks: {
      status: callbackStatus,
      sampleLimit: CALLBACK_METHODS.length * CALLBACK_PRIORITIES.length * QUEUE_SAMPLE_PER_EDGE * 2,
      sampled: pending.length,
      activationCohortStatus,
      liveActivation: startedAt ? liveQueue : null,
      heldBacklog: heldQueue,
      retainedContactsSampled,
      lastProgressAt: iso(callbackResult.value?.lastProgress ?? null),
      outcomes: outcomeResult.value
        ? {
          status: "sampled",
          sampleLimit: outcomeResult.value.sampleLimit,
          sampled: outcomeResult.value.sampled,
          liveActivation: outcomes.liveActivation,
          heldBacklog: outcomes.heldBacklog,
          note: "Recent callback history outcomes are bounded indexed samples, not fleet totals.",
        }
        : {
          status: "error",
          sampleLimit: 200,
          sampled: 0,
          liveActivation: startedAt ? {} : null,
          heldBacklog: {},
          note: "Callback outcome history could not be read.",
        },
      note: callbackResult.error
        ? "Callback telemetry could not be read. No callback drain was invoked."
        : activationCohortStatus === "error"
          ? "Callback queue was sampled, but activation state could not be read; live and held cohorts are not separated."
        : startedAt
          ? "Live activation and older held backlog are separate bounded queue samples. Retained unsupported Contacts are excluded from actionable samples. Stale applies only to actionable live-cohort work with no recent progress."
          : "No live timed activation is present; held backlog represents the current bounded pending sample. Retained unsupported Contacts are excluded from actionable samples and do not make this monitor stale.",
    },
    breaker: breakerResult.value ?? {
      status: "error",
      state: "unknown",
      openUntil: null,
      probeUntil: null,
      updatedAt: null,
      alerting: {
        transitionWiring: "present",
        deliveryStatus: "not-observable",
        note: "Breaker state could not be read. Existing alert delivery was not checked.",
      },
    },
  };
}