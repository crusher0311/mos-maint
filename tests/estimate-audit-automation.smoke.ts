import assert from "node:assert/strict";
import {
  AUDIT_AUTOMATION_COLLECTIONS,
  fingerprintAuditInput,
  scheduleAuditFromReceipt,
  statusFromAuditState,
  type AuditAutomationInput,
  type AuditState,
} from "../lib/estimate-assist/audit-automation";
import { configureEstimateAuditProcessorDeps, processEstimateAudit } from "../workers/processors/estimate-audit";
import { GET as getAuditStatus } from "../app/api/estimate-assist/audit/status/route";
import { auditStatusDeps } from "../app/api/estimate-assist/audit/status/deps";

type Doc = Record<string, any>;

function matches(doc: Doc | undefined, query: Doc): boolean {
  if (!doc) return false;
  return Object.entries(query).every(([key, expected]) => {
    const actual = doc[key];
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      if ("$exists" in expected) return Boolean(actual !== undefined) === expected.$exists;
      if ("$lte" in expected) return new Date(actual).getTime() <= new Date(expected.$lte).getTime();
      if ("$in" in expected) return expected.$in.includes(actual);
      if ("$or" in expected) return false;
    }
    return actual === expected;
  });
}

class FakeCollection {
  doc?: Doc;
  failWrites = 0;
  async findOne(query: Doc) { return matches(this.doc, query) ? { ...this.doc } : null; }
  async findOneAndUpdate(query: Doc, update: Doc) {
    const alternatives = query.$or as Doc[] | undefined;
    const base = { ...query };
    delete base.$or;
    const found = matches(this.doc, base) && (!alternatives || alternatives.some((item) => matches(this.doc, item)));
    if (!found) return null;
    Object.assign(this.doc!, update.$set || {});
    for (const key of Object.keys(update.$unset || {})) delete this.doc![key];
    return { ...this.doc };
  }
  async updateOne(query: Doc, update: Doc, options: Doc = {}) {
    if (this.failWrites > 0) {
      this.failWrites--;
      throw new Error("fake_write_failure");
    }
    const alternatives = query.$or as Doc[] | undefined;
    const base = { ...query };
    delete base.$or;
    const found = matches(this.doc, base) && (!alternatives || alternatives.some((item) => matches(this.doc, item)));
    if (!found && !options.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    if (!found && this.doc?._id === query._id) {
      const duplicate: any = new Error("duplicate _id");
      duplicate.code = 11000;
      throw duplicate;
    }
    if (!found) this.doc = { _id: query._id };
    if (!found) Object.assign(this.doc!, update.$setOnInsert || {});
    Object.assign(this.doc!, update.$set || {});
    for (const [key, amount] of Object.entries(update.$inc || {})) {
      this.doc![key] = (Number(this.doc![key]) || 0) + Number(amount);
    }
    for (const key of Object.keys(update.$unset || {})) delete this.doc![key];
    return { matchedCount: found ? 1 : 0, modifiedCount: found ? 1 : 0, upsertedCount: found ? 0 : 1 };
  }
}

class FakeDb {
  states = new FakeCollection();
  shopLocks = new FakeCollection();
  fleetLock = new FakeCollection();
  history = new FakeCollection();
  collection(name: string) {
    if (name === AUDIT_AUTOMATION_COLLECTIONS.states) return this.states;
    if (name === AUDIT_AUTOMATION_COLLECTIONS.shopLocks) return this.shopLocks;
    if (name === AUDIT_AUTOMATION_COLLECTIONS.fleetLock) return this.fleetLock;
    if (name === AUDIT_AUTOMATION_COLLECTIONS.history) return this.history;
    return new FakeCollection();
  }
}

function fakeRepository(db: FakeDb): any {
  const collectionFor = (name: string) => db.collection(name);
  return {
    isProviderRoutedForShop: async () => true,
    findHistoryRepair: (id: string, revision: number) =>
      db.states.findOne({ _id: id, revision, status: { $in: ["complete", "partial"] }, historyPending: true }),
    async claim(id: string, revision: number, token: string, runLeaseUntil: Date) {
      return db.states.findOneAndUpdate(
        { _id: id, revision, $or: [{ status: "pending" }, { status: "running", runLeaseUntil: { $lte: new Date() } }] },
        { $set: { status: "running", runToken: token, runLeaseUntil, updatedAt: new Date() } },
      );
    },
    update: (filter: Doc, update: Doc) => db.states.updateOne(filter, update),
    acquireLease: async (item: any, leaseUntil: Date) => {
      const c = collectionFor(item.collection);
      return (await c.updateOne(
        { _id: item.key, $or: [{ leaseUntil: { $lte: new Date() } }, { token: item.token }] },
        { $set: { token: item.token, leaseUntil } },
        { upsert: true },
      )).modifiedCount > 0 || c.doc?.token === item.token;
    },
    releaseLease: (item: any) => collectionFor(item.collection).updateOne(
      { _id: item.key, token: item.token }, { $set: { leaseUntil: new Date(0) }, $unset: { token: "" } },
    ),
    upsertHistory: (state: any, report: any) => db.history.updateOne(
      { _id: `${state._id}:${state.revision}` },
      { $setOnInsert: { _id: `${state._id}:${state.revision}`, automation: true, report } },
      { upsert: true },
    ),
  };
}

const now = new Date("2026-01-01T12:00:00Z");
const base: AuditAutomationInput = {
  shopId: 44, provider: "tekmetric", workOrderId: "ro-9",
  lineItems: [{ title: " Brake   Pad Replacement ", laborHours: 1, partsTotal: 25 }],
  vehicleVin: " 1abc ", canUseMaintenance: false, completeTicket: true,
  source: "webhook", upstreamRevision: "r2", upstreamUpdatedAt: now,
};
const queued: any[] = [];
const deps: any = {
  now: () => now,
  getFeatureEntitlements: async () => ({}),
  canAccessShopFeature: () => true,
  enqueue: async (job: any) => { queued.push(job); return { enqueued: true, reason: "queued" }; },
};

async function main() {
  process.env.ESTIMATE_AUDIT_AUTOMATION_ENABLED = "true";
  const db = new FakeDb();
  assert.equal(
    fingerprintAuditInput(base),
    fingerprintAuditInput({ ...base, lineItems: [{ title: "brake pad replacement", laborHours: 1, partsTotal: 25 }] }),
    "format-only duplicate must dedupe",
  );
  assert.equal(
    fingerprintAuditInput(base),
    fingerprintAuditInput({ ...base, upstreamRevision: "different-delivery-revision", upstreamUpdatedAt: new Date("2026-01-02T00:00:00Z") }),
    "delivery ordering metadata must not make unchanged source content rerun AI",
  );

  // An unchanged later delivery must still advance the ordering watermark.
  // Otherwise a changed receipt from between T1 and T3 can incorrectly
  // create a newer revision after T3 has already been observed.
  const watermarkDb = new FakeDb();
  const t1 = { ...base, upstreamRevision: "t1", upstreamUpdatedAt: new Date("2026-01-01T12:00:00Z") };
  const t3SameContent = { ...base, upstreamRevision: "t3", upstreamUpdatedAt: new Date("2026-01-01T12:03:00Z") };
  const t2Changed = {
    ...base,
    upstreamRevision: "t2",
    upstreamUpdatedAt: new Date("2026-01-01T12:02:00Z"),
    lineItems: [{ title: "Brake pad replacement", laborHours: 2, partsTotal: 25 }],
  };
  await scheduleAuditFromReceipt(watermarkDb as any, t1, deps);
  assert.equal((await scheduleAuditFromReceipt(watermarkDb as any, t3SameContent, deps)).reason, "redriven");
  const lateChanged = await scheduleAuditFromReceipt(watermarkDb as any, t2Changed, deps);
  assert.equal(lateChanged.reason, "older_receipt");
  assert.equal(watermarkDb.states.doc?.upstreamRevision, "t3");
  assert.equal(watermarkDb.states.doc?.revision, 1);

  // Concurrent different receipts use CAS; the newer provider timestamp wins
  // even if the stale delivery reaches the scheduler after it.
  const newer = { ...base, upstreamRevision: "r3", upstreamUpdatedAt: new Date("2026-01-01T12:01:00Z"), lineItems: [{ title: "Brake pads", laborHours: 2 }] };
  const older = { ...base, upstreamRevision: "r1", upstreamUpdatedAt: new Date("2026-01-01T11:59:00Z"), lineItems: [{ title: "Brake pads", laborHours: 1 }] };
  await Promise.all([scheduleAuditFromReceipt(db as any, newer, deps), scheduleAuditFromReceipt(db as any, older, deps)]);
  assert.equal(db.states.doc?.upstreamRevision, "r3", "old reordered receipt cannot overwrite current state");
  assert.equal(db.states.doc?.revision, 1);

  // A completed identical ticket is re-evaluated after bounded freshness.
  db.states.doc = {
    ...db.states.doc, status: "complete", completedAt: new Date(0), updatedAt: new Date(0),
    inputFingerprint: fingerprintAuditInput(newer), evaluatorVersion: "audit-evaluator-v1",
  };
  const stale = await scheduleAuditFromReceipt(db as any, newer, deps);
  assert.equal(stale.revision, 2, JSON.stringify(stale));
  assert.equal(db.states.doc?.status, "pending");

  // Repeated queue failures leave pending/failed work redrivable by a receipt.
  db.states.doc = { ...db.states.doc, status: "failed", inputFingerprint: fingerprintAuditInput(newer) };
  const retry = await scheduleAuditFromReceipt(db as any, newer, deps);
  assert.equal(retry.reason, "redriven");
  assert.ok(queued.length >= 2, "receipt re-drives bounded-retry exhaustion");
  db.states.doc = { ...db.states.doc, status: "failed", failureCount: 5 };
  assert.equal(
    (await scheduleAuditFromReceipt(db as any, newer, deps)).reason,
    "retry_exhausted",
    "repeated receipts cannot reset an exhausted revision forever",
  );

  // Processor fake verifies real claim/completion and recovery of the
  // completion-before-history failure window, rather than only lease helpers.
  const processorDb = new FakeDb();
  processorDb.states.doc = {
    _id: "44:tekmetric:processor", shopId: 44, provider: "tekmetric", workOrderId: "processor",
    revision: 7, status: "pending", createdAt: now, updatedAt: now,
    pendingInput: { lineItems: [{ title: "Oil change" }], completeTicket: true },
  };
  const processorReport = {
    auditDate: now.toISOString(), findings: [], summary: { totalFindings: 0, critical: 0, warnings: 0, info: 0, score: 100 },
    evaluation: { completeness: "complete", ai: { status: "completed" } },
  };
  configureEstimateAuditProcessorDeps({
    getRepository: async () => fakeRepository(processorDb),
    getFeatureEntitlements: async () => ({}) as any,
    canAccessShopFeature: () => true,
    enforceAiBudget: async () => false,
    evaluateAudit: async () => processorReport,
  } as any);
  await processEstimateAudit({ id: "processor-7", data: { shopId: 44, provider: "tekmetric", workOrderId: "processor", revision: 7, enqueuedAt: now.toISOString() } } as any);
  assert.equal(processorDb.states.doc?.status, "complete");
  assert.equal(processorDb.states.doc?.historyPending, undefined);
  assert.equal(processorDb.history.doc?.automation, true);

  const repairDb = new FakeDb();
  repairDb.states.doc = {
    ...processorDb.states.doc, _id: "44:tekmetric:repair", workOrderId: "repair",
    revision: 8, status: "pending", pendingInput: { lineItems: [], completeTicket: true },
  };
  repairDb.history.failWrites = 1;
  configureEstimateAuditProcessorDeps({ getRepository: async () => fakeRepository(repairDb) } as any);
  await assert.rejects(
    processEstimateAudit({ id: "repair-8", data: { shopId: 44, provider: "tekmetric", workOrderId: "repair", revision: 8, enqueuedAt: now.toISOString() } } as any),
  );
  assert.equal(repairDb.states.doc?.status, "complete");
  assert.equal(repairDb.states.doc?.historyPending, true);
  await processEstimateAudit({ id: "repair-8-retry", data: { shopId: 44, provider: "tekmetric", workOrderId: "repair", revision: 8, enqueuedAt: now.toISOString() } } as any);
  assert.equal(repairDb.states.doc?.historyPending, undefined);
  assert.equal(repairDb.history.doc?.automation, true);

  // Queue retries execute the real processor but cannot evaluate a permanently
  // failing input more than the durable revision cap.
  const failureDb = new FakeDb();
  failureDb.states.doc = {
    ...processorDb.states.doc, _id: "44:tekmetric:failure", workOrderId: "failure",
    revision: 9, status: "pending", failureCount: 0, pendingInput: { lineItems: [], completeTicket: true },
  };
  let evaluations = 0;
  configureEstimateAuditProcessorDeps({
    getRepository: async () => fakeRepository(failureDb),
    evaluateAudit: async () => { evaluations++; throw new Error("forced_evaluator_failure"); },
  } as any);
  const failingJob: any = { id: "failure-9", data: { shopId: 44, provider: "tekmetric", workOrderId: "failure", revision: 9, enqueuedAt: now.toISOString() } };
  for (let attempt = 0; attempt < 5; attempt++) await assert.rejects(processEstimateAudit(failingJob));
  assert.equal(failureDb.states.doc?.failureCount, 5);
  await processEstimateAudit(failingJob);
  assert.equal(evaluations, 5);
  assert.equal(failureDb.states.doc?.status, "failed");
  assert.equal(failureDb.states.doc?.lastError, "audit_retry_exhausted");

  const report: any = { auditDate: now.toISOString(), findings: [], summary: { totalFindings: 0, critical: 0, warnings: 0, info: 0, score: 100 } };
  const state = { ...db.states.doc, status: "partial", report, completedAt: new Date(0), updatedAt: new Date(0) } as AuditState;
  assert.equal(statusFromAuditState(state, 16 * 60_000).status, "stale");

  // Status never exposes a report to an Estimate Assist-ineligible shop, and
  // strips persisted VHI-only findings immediately on a maintenance downgrade.
  process.env.ESTIMATE_AUDIT_WORKER_ENABLED = "true";
  process.env.REDIS_URL = "redis://fake";
  const savedStatusDeps = { ...auditStatusDeps };
  const statusState = {
    ...state,
    status: "complete",
    completedAt: new Date(),
    updatedAt: new Date(),
    report: {
      ...report,
      findings: [
        { id: "vhi", source: "vhi", severity: "warning", title: "Due service", description: "VHI" },
        { id: "static", source: "static", severity: "warning", title: "Static", description: "Rule" },
      ],
      summary: { totalFindings: 2, critical: 0, warnings: 2, info: 0, score: 90 },
    },
  };
  Object.assign(auditStatusDeps as any, {
    getSession: async () => ({ shopId: 44 }),
    getFeatureEntitlements: async () => ({ canUseFeature: (feature: string) => feature === "estimate_assist" }),
    getRepository: async () => ({ findState: async () => statusState }),
  });
  const request: any = { headers: new Headers(), nextUrl: new URL("http://localhost/api/estimate-assist/audit/status?provider=tekmetric&workOrderId=ro-9") };
  const downgraded = await getAuditStatus(request);
  const downgradedBody = await downgraded.json();
  assert.equal(downgradedBody.status, "partial");
  assert.equal(downgradedBody.report.findings.length, 1);
  (auditStatusDeps as any).getFeatureEntitlements = async () => ({ canUseFeature: () => false });
  const denied = await getAuditStatus(request);
  assert.deepEqual(await denied.json(), { ok: true, status: "unavailable", reason: "estimate_assist_not_entitled" });
  Object.assign(auditStatusDeps as any, savedStatusDeps);
  delete process.env.ESTIMATE_AUDIT_WORKER_ENABLED;
  delete process.env.REDIS_URL;
  delete process.env.ESTIMATE_AUDIT_AUTOMATION_ENABLED;
  console.log("estimate-audit fake concurrency/retry tests passed");
}

void main();