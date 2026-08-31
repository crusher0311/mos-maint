import crypto from "node:crypto";
import { getDb } from "@/lib/mongo";
import { sendOpsAlert } from "@/lib/alerts/notify";

const COLLECTION = "protractor_circuit_breakers";
const AUTH_COOLDOWN_MS = 5 * 60_000;
const TRANSIENT_COOLDOWN_MS = 30_000;
const PROBE_LEASE_MS = 30_000;
const AUTH_CORRELATION_WINDOW_MS = 60_000;
const PROVIDER_AUTH_CONNECTIONS = 3;
const PROVIDER_TRANSIENT_FAILURES = 3;
// A transport exception has no HTTP response.  It is deliberately distinct
// from auth statuses so it can only contribute to transient provider health.
export const PROTRACTOR_TRANSPORT_FAILURE_STATUS = 599;

type BreakerDocument = {
  _id: string;
  scope: "provider" | "connection";
  connectionHash?: string;
  openUntil?: Date;
  probeUntil?: Date;
  authFailureAt?: Date;
  transientFailures?: number;
  totalResponses?: number;
  successResponses?: number;
  authFailureResponses?: number;
  throttledResponses?: number;
  serverFailureResponses?: number;
  transportFailureResponses?: number;
  otherFailureResponses?: number;
  updatedAt: Date;
};

export type ProtractorGateDecision =
  | { allowed: true; probe: boolean }
  | { allowed: false; reason: string; retryAfterMs: number };

function connectionHash(connectionId: string): string {
  return crypto.createHash("sha256").update(connectionId).digest("hex").slice(0, 32);
}

function connectionKey(connectionId: string): string {
  return `connection:${connectionHash(connectionId)}`;
}

async function claimScope(key: string, now: Date): Promise<ProtractorGateDecision> {
  const db = await getDb();
  const collection = db.collection<BreakerDocument>(COLLECTION);
  const state = await collection.findOne({ _id: key });
  if (!state?.openUntil) return { allowed: true, probe: false };

  if (state.openUntil.getTime() > now.getTime()) {
    return {
      allowed: false,
      reason: `Protractor ${state.scope} circuit breaker open`,
      retryAfterMs: state.openUntil.getTime() - now.getTime(),
    };
  }

  const probeUntil = new Date(now.getTime() + PROBE_LEASE_MS);
  const claimed = await collection.findOneAndUpdate(
    {
      _id: key,
      openUntil: { $lte: now },
      $or: [{ probeUntil: { $exists: false } }, { probeUntil: { $lte: now } }],
    },
    { $set: { probeUntil, updatedAt: now } },
    { returnDocument: "after" },
  );
  if (claimed) return { allowed: true, probe: true };

  return {
    allowed: false,
    reason: `Protractor ${state.scope} circuit breaker awaiting controlled probe`,
    retryAfterMs: Math.max(
      1,
      (state.probeUntil?.getTime() ?? probeUntil.getTime()) - now.getTime(),
    ),
  };
}

async function releaseClaimedProbe(key: string): Promise<void> {
  const db = await getDb();
  await db.collection<BreakerDocument>(COLLECTION).updateOne(
    { _id: key, probeUntil: { $exists: true } },
    { $unset: { probeUntil: "" }, $set: { updatedAt: new Date() } },
  );
}

// Narrow repository seam for deterministic coordination-race tests. Production
// defaults remain the Mongo operations above.
export const __protractorCircuitBreakerTestHooks: {
  claimScope: (key: string, now: Date) => Promise<ProtractorGateDecision>;
  releaseClaimedProbe: (key: string) => Promise<void>;
  getDb: typeof getDb;
  alert: typeof sendOpsAlert;
} = {
  claimScope,
  releaseClaimedProbe,
  getDb,
  alert: sendOpsAlert,
};

type BreakerScope = "provider" | "connection";
type ResponseClass = "authentication" | "throttled" | "server" | "transport";

async function pageBreakerOpen(input: {
  scope: BreakerScope;
  responseClass: ResponseClass;
  cooldownMs: number;
  connectionFingerprint: string;
}): Promise<void> {
  await __protractorCircuitBreakerTestHooks.alert({
    title: "Protractor traffic automatically blocked",
    severity: "critical",
    summary: `The ${input.scope} circuit breaker opened and Protractor traffic is being contained automatically.`,
    fields: {
      scope: input.scope,
      responseClass: input.responseClass,
      cooldownMs: input.cooldownMs,
      connectionFingerprint: input.connectionFingerprint,
    },
    source: "protractor-circuit-breaker",
    dedupKey:
      input.scope === "connection"
        ? `protractor-breaker:connection:${input.connectionFingerprint}`
        : "protractor-breaker:provider",
  });
}

/**
 * Distributed gate used immediately before every live Protractor transport.
 * Connection scope takes precedence so one bad credential cannot consume the
 * single provider-wide recovery probe.
 */
export async function acquireProtractorOutboundGate(
  connectionId: string,
  now = new Date(),
): Promise<ProtractorGateDecision> {
  const key = connectionKey(connectionId);
  const connection = await __protractorCircuitBreakerTestHooks.claimScope(key, now);
  if (!connection.allowed) return connection;
  try {
    const provider = await __protractorCircuitBreakerTestHooks.claimScope("provider", now);
    if (!provider.allowed) {
      // The connection probe was ours, but it cannot be sent because the
      // provider scope won the deny. Roll it back rather than stranding the
      // connection for the complete probe lease.
      if (connection.probe) await __protractorCircuitBreakerTestHooks.releaseClaimedProbe(key);
      return provider;
    }
    return { allowed: true, probe: connection.probe || provider.probe };
  } catch (error) {
    if (connection.probe) await __protractorCircuitBreakerTestHooks.releaseClaimedProbe(key).catch(() => {});
    throw error;
  }
}

export async function recordProtractorResponse(
  connectionId: string,
  statusCode: number,
  retryAfterMs = 0,
  now = new Date(),
): Promise<void> {
  const db = await __protractorCircuitBreakerTestHooks.getDb();
  const collection = db.collection<BreakerDocument>(COLLECTION);
  const connHash = connectionHash(connectionId);
  const connKey = `connection:${connHash}`;
  const responseCounter =
    statusCode >= 200 && statusCode < 400
      ? "successResponses"
      : statusCode === 401 || statusCode === 403
        ? "authFailureResponses"
        : statusCode === 429
          ? "throttledResponses"
          : statusCode === PROTRACTOR_TRANSPORT_FAILURE_STATUS
            ? "transportFailureResponses"
            : statusCode >= 500
              ? "serverFailureResponses"
              : "otherFailureResponses";

  // Privacy-safe per-connection attribution. The document key and
  // connectionHash are one-way fingerprints; credentials and payloads are
  // never retained.
  await collection.updateOne(
    { _id: connKey },
    {
      $setOnInsert: { scope: "connection", connectionHash: connHash },
      $set: { updatedAt: now },
      $inc: { totalResponses: 1, [responseCounter]: 1 },
    },
    { upsert: true },
  );

  if (statusCode >= 200 && statusCode < 400) {
    await Promise.all([
      collection.updateOne(
        {
          _id: connKey,
          $or: [{ openUntil: { $exists: false } }, { probeUntil: { $exists: true } }],
        },
        {
          $unset: { openUntil: "", probeUntil: "", transientFailures: "", authFailureAt: "" },
          $set: { updatedAt: now },
        },
      ),
      collection.updateOne(
        {
          _id: "provider",
          $or: [{ openUntil: { $exists: false } }, { probeUntil: { $exists: true } }],
        },
        { $unset: { openUntil: "", probeUntil: "", transientFailures: "" }, $set: { updatedAt: now } },
      ),
    ]);
    return;
  }

  if (statusCode === 401 || statusCode === 403) {
    const openedConnection = await collection.findOneAndUpdate(
      { _id: connKey, openUntil: { $exists: false } },
      {
        $set: {
          scope: "connection",
          connectionHash: connHash,
          authFailureAt: now,
          openUntil: new Date(now.getTime() + AUTH_COOLDOWN_MS),
          updatedAt: now,
        },
        $unset: { probeUntil: "" },
      },
      { returnDocument: "after" },
    );
    if (openedConnection) {
      await pageBreakerOpen({
        scope: "connection",
        responseClass: "authentication",
        cooldownMs: AUTH_COOLDOWN_MS,
        connectionFingerprint: connHash,
      }).catch((error) => {
        console.error("[ProtractorCircuitBreaker] Failed to deliver connection-open alert:", error);
      });
    }

    const recentConnections = await collection.countDocuments({
      scope: "connection",
      authFailureAt: { $gte: new Date(now.getTime() - AUTH_CORRELATION_WINDOW_MS) },
    });
    if (recentConnections >= PROVIDER_AUTH_CONNECTIONS) {
      // Ensure the provider document exists before the transition claim. Using
      // an upsert on the conditional claim itself can race: after one replica
      // opens the existing document, another replica's filter no longer
      // matches and Mongo may attempt a duplicate _id insert.
      await collection.updateOne(
        { _id: "provider" },
        {
          $setOnInsert: {
            scope: "provider",
            updatedAt: now,
          },
        },
        { upsert: true },
      );
      const openedProvider = await collection.findOneAndUpdate(
        { _id: "provider", openUntil: { $exists: false } },
        {
          $set: {
            scope: "provider",
            openUntil: new Date(now.getTime() + AUTH_COOLDOWN_MS),
            updatedAt: now,
          },
          $unset: { probeUntil: "" },
        },
        { returnDocument: "after" },
      );
      if (openedProvider) {
        await pageBreakerOpen({
          scope: "provider",
          responseClass: "authentication",
          cooldownMs: AUTH_COOLDOWN_MS,
          connectionFingerprint: connHash,
        }).catch((error) => {
          console.error("[ProtractorCircuitBreaker] Failed to deliver provider-open alert:", error);
        });
      }
    }
    return;
  }

  if (statusCode === 429 || statusCode >= 500 || statusCode === PROTRACTOR_TRANSPORT_FAILURE_STATUS) {
    const result = await collection.findOneAndUpdate(
      { _id: "provider" },
      {
        $set: { scope: "provider", updatedAt: now },
        $inc: { transientFailures: 1 },
        $unset: { probeUntil: "" },
      },
      { upsert: true, returnDocument: "after" },
    );
    if ((result?.transientFailures ?? 0) >= PROVIDER_TRANSIENT_FAILURES) {
      const cooldown = Math.max(TRANSIENT_COOLDOWN_MS, retryAfterMs);
      const openedProvider = await collection.findOneAndUpdate(
        { _id: "provider", openUntil: { $exists: false } },
        { $set: { openUntil: new Date(now.getTime() + cooldown), updatedAt: now } },
        { returnDocument: "after" },
      );
      if (openedProvider) {
        const responseClass: ResponseClass =
          statusCode === 429
            ? "throttled"
            : statusCode === PROTRACTOR_TRANSPORT_FAILURE_STATUS
              ? "transport"
              : "server";
        await pageBreakerOpen({
          scope: "provider",
          responseClass,
          cooldownMs: cooldown,
          connectionFingerprint: connHash,
        }).catch((error) => {
          console.error("[ProtractorCircuitBreaker] Failed to deliver provider-open alert:", error);
        });
      }
    }
  }
}
