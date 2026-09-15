/**
 * Offline behavior coverage for the Protractor live monitor repository.
 * The repository seams supply in-memory Mongo/Drizzle lookalikes; network
 * egress is denied before imports and neither fake can open a DB connection.
 */
import "./helpers/deny-network-egress";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  __protractorLiveMonitorTestHooks,
  getProtractorLiveMonitor,
} from "../lib/data/repositories/protractor-live-monitor";

type Row = Record<string, any>;
const now = new Date("2026-09-01T12:00:00.000Z");
const seen: Array<{ collection: string; filter: Row; options: Row }> = [];
let breaker: Row | null = null;

const activation: Row = {
  _id: "protractor-physical-transport-v1",
  operatorStop: { active: false },
  canary: {
    generation: "live-generation",
    mode: "live",
    scope: "callbacks_and_interactive",
    requiresCallback: false,
    requiresRelay: true,
    workersSuspendedConfirmed: true,
    startedAt: new Date("2026-09-01T11:00:00.000Z"),
    maxAdmissions: null,
    remainingAdmissions: null,
    consumedAdmissions: 7,
    audit: [],
  },
};
const relayRows = [
  { _id: "relay-measured", provider: "protractor", endpoint: "relay", environment: "production", timestamp: new Date("2026-09-01T11:59:00.000Z"), statusCode: 200, latencyMs: 90 },
  { _id: "relay-no-latency", provider: "protractor", endpoint: "relay", environment: "production", timestamp: new Date("2026-09-01T11:58:00.000Z"), statusCode: 503 },
  // SOAP preserves its endpoint name; transport is the durable relay marker.
  { _id: "relay-soap", provider: "protractor", endpoint: "soap:work_order", transport: "relay", environment: "production", timestamp: new Date("2026-09-01T11:57:00.000Z"), statusCode: 429, latencyMs: 110 },
  { _id: "direct-soap", provider: "protractor", endpoint: "soap:work_order", transport: "direct", environment: "production", timestamp: new Date("2026-09-01T11:56:00.000Z"), statusCode: 200, latencyMs: 1 },
];
const callbackRows = [
  { _id: "live-work", method: "GET", processed: false, priority: 1, objectType: "WorkOrder", attempts: 1, receivedAt: new Date("2026-09-01T11:30:00.000Z") },
  { _id: "old-work", method: "POST", processed: false, priority: 1, objectType: "WorkOrder", attempts: 0, receivedAt: new Date("2026-09-01T10:00:00.000Z") },
  { _id: "old-exhausted", method: "GET", processed: false, priority: 1, objectType: "WorkOrder", attempts: 3, receivedAt: new Date("2026-09-01T09:00:00.000Z") },
  // This deliberately has no historyOutcome; legacy Contact rows must not
  // contaminate actionable age while retained-contact marking catches up.
  { _id: "legacy-contact", method: "POST", processed: false, priority: 1, objectType: "Contact", attempts: 0, receivedAt: new Date("2026-09-01T08:00:00.000Z") },
  { _id: "progress", method: "GET", processed: true, priority: 1, processedAt: new Date("2026-09-01T11:58:00.000Z") },
];

function rowsFor(name: string, filter: Row): Row[] {
  if (name === "api_usage") {
    const relayEligible = filter.$or.some((clause: Row) =>
      clause.transport === "relay" || clause.endpoint === "relay",
    );
    return relayRows.filter((row) =>
      row.provider === filter.provider &&
      row.environment === filter.environment &&
      row.timestamp >= filter.timestamp.$gte &&
      relayEligible &&
      (row.transport === "relay" || row.endpoint === "relay"),
    );
  }
  if (name !== "protractor_callback_events") return [];
  return callbackRows.filter((row) =>
    row.method === filter.method &&
    row.processed === filter.processed &&
    (filter.priority === undefined || row.priority === filter.priority) &&
    (!filter.processedAt || (row.processedAt instanceof Date && row.processedAt >= filter.processedAt.$gte)),
  );
}

const fakeMongo = {
  collection(name: string) {
    return {
      async findOne(_filter: Row) {
        if (name === "api_rate_limits") return activation;
        if (name === "protractor_circuit_breakers") return breaker;
        return null;
      },
      find(filter: Row, options: Row) {
        seen.push({ collection: name, filter, options });
        let rows = rowsFor(name, filter);
        return {
          sort(sort: Row) {
            const [field, direction] = Object.entries(sort)[0] as [string, number];
            rows = rows.slice().sort((a, b) => direction * (
              new Date(a[field] ?? 0).getTime() - new Date(b[field] ?? 0).getTime()
            ));
            return {
              limit(limit: number) {
                return { toArray: async () => rows.slice(0, limit).map((row) => ({ ...row })) };
              },
            };
          },
        };
      },
    };
  },
};

const report = {
  sampleLimit: 200 as const,
  windowHours: 24 as const,
  sampled: 2,
  counts: { applied_indexed: 1, deferred: 1 },
  rows: [
    { method: "GET" as const, shopId: 1, receivedAt: "2026-09-01T11:31:00.000Z", category: "applied_indexed", reason: "indexed" },
    { method: "POST" as const, shopId: 1, receivedAt: "2026-09-01T10:01:00.000Z", category: "deferred", reason: "pending_replay" },
  ],
};

function installMongoSeams() {
  __protractorLiveMonitorTestHooks.mongoDb = async () => fakeMongo as any;
  __protractorLiveMonitorTestHooks.callbackOutcomeReport = async () => report;
  __protractorLiveMonitorTestHooks.now = () => new Date(now);
  delete process.env.API_USAGE_PG_CANONICAL;
  delete process.env.PROTRACTOR_OPS_PG_CANONICAL;
}

async function mongoBehavior() {
  installMongoSeams();
  seen.length = 0;
  breaker = null;
  const monitor = await getProtractorLiveMonitor();
  assert.equal(monitor.callbacks.activationCohortStatus, "available", "fresh reviewed continuous shape is a live cohort");
  assert.equal(monitor.callbacks.liveActivation?.actionableSampled, 1);
  assert.equal(monitor.callbacks.heldBacklog.actionableSampled, 1, "exhausted and retained rows are excluded");
  assert.equal(monitor.callbacks.heldBacklog.attemptsAtLeast3Sampled, 1, "exhausted work remains separately visible");
  assert.equal(monitor.callbacks.retainedContactsSampled, 1, "legacy unmarked Contact remains separately visible");
  assert.equal(monitor.callbacks.heldBacklog.oldestActionableAgeMs, 2 * 60 * 60_000);
  assert.equal(monitor.callbacks.outcomes.liveActivation?.applied_indexed, 1);
  assert.equal(monitor.callbacks.outcomes.heldBacklog.deferred, 1);
  assert.equal(monitor.callbacks.status, "partial", "recent progress prevents a stale page");
  assert.equal(monitor.relay.sampled, 3, "transport-marked SOAP relay response is included, direct SOAP is not");
  assert.equal(monitor.relay.outcomes.rate_limited, 1);
  assert.equal(monitor.relay.latencySampled, 2, "missing duration is not coerced to zero");
  assert.equal(monitor.relay.averageLatencyMs, 100);
  assert.equal(monitor.relay.p95LatencyMs, 110, "P95 is calculated from measured durations, not all rows");
  assert.equal(monitor.breaker.state, "unknown", "an absent breaker record is not reported as closed");
  assert.equal(monitor.breaker.status, "empty");

  const relayQuery = seen.find((query) => query.collection === "api_usage")!;
  assert.ok(relayQuery.filter.timestamp.$gte instanceof Date, "relay lookup has an explicit recent time floor");
  assert.equal(relayQuery.options.hint, "provider_1_timestamp_-1");
  assert.deepEqual(relayQuery.filter.$or, [{ transport: "relay" }, { endpoint: "relay" }]);
  const progressQueries = seen.filter((query) => query.collection === "protractor_callback_events" && query.filter.processed === true);
  assert.equal(progressQueries.length, 2);
  assert.ok(progressQueries.every((query) => query.filter.processedAt.$gte instanceof Date), "progress reads have a time floor");
  assert.ok(progressQueries.every((query) => query.options.hint === "method_1_processedAt_-1"));
  const clientSource = readFileSync("lib/integrations/protractor/client.ts", "utf8");
  assert.match(clientSource, /trackApiRequest\('protractor', actualRelayLogging \? 'relay'/);
  assert.match(clientSource, /environment: resolveProtractorEnvironment\(process\.env\)/);
  assert.match(clientSource, /'soap:work_order'/);
  assert.match(clientSource, /transport: physicalTransport/);

  callbackRows.splice(callbackRows.findIndex((row) => row._id === "progress"), 1);
  const stalled = await getProtractorLiveMonitor();
  assert.equal(stalled.callbacks.status, "stale", "old eligible live work with no progress is stale");
  callbackRows.splice(callbackRows.findIndex((row) => row._id === "live-work"), 1);
  const heldOnly = await getProtractorLiveMonitor();
  assert.equal(heldOnly.callbacks.status, "partial", "old held backlog alone does not page the live monitor");

  activation.canary.expiresAt = new Date("2026-09-01T13:00:00.000Z");
  const malformed = await getProtractorLiveMonitor();
  assert.equal(malformed.callbacks.activationCohortStatus, "not_live", "continuous records with an expiry fail closed");
  delete activation.canary.expiresAt;
  breaker = { _id: "provider", openUntil: new Date("2026-09-01T12:10:00.000Z"), updatedAt: now };
  const open = await getProtractorLiveMonitor();
  assert.equal(open.breaker.state, "open");
}

async function postgresSeams() {
  let selectCalls = 0;
  const tx = {
    execute: async () => [],
    select(selection: Row) {
      return {
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => {
                selectCalls += 1;
                return "timestamp" in selection
                  ? [{ timestamp: new Date("2026-09-01T11:59:30.000Z"), statusCode: 200, latencyMs: null }]
                  : [];
              },
            }),
          }),
        }),
      };
    },
  };
  __protractorLiveMonitorTestHooks.pgDb = () => ({
    transaction: async (fn: (transaction: any) => Promise<any>) => fn(tx),
  }) as any;
  process.env.API_USAGE_PG_CANONICAL = "1";
  process.env.PROTRACTOR_OPS_PG_CANONICAL = "1";
  const monitor = await getProtractorLiveMonitor();
  assert.ok(selectCalls >= 8, `PG callback reader uses the PG seam (selects=${selectCalls})`);
  assert.equal(monitor.relay.sampled, 1, JSON.stringify(monitor.relay));
  assert.equal(monitor.relay.latencySampled, 0);
  assert.equal(monitor.relay.averageLatencyMs, null);
  assert.notEqual(monitor.callbacks.status, "error", "PG callback snapshot is readable through the seam");
  delete process.env.API_USAGE_PG_CANONICAL;
  delete process.env.PROTRACTOR_OPS_PG_CANONICAL;
}

Promise.resolve()
  .then(mongoBehavior)
  .then(postgresSeams)
  .then(() => console.log("✓ Protractor live monitor repository offline behavior passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });