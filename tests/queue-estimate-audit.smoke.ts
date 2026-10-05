/**
 * Queue-only regression coverage for task #1279.
 *
 * These tests intentionally do not construct a Redis client.  They cover the
 * deterministic audit job identity and queue options that make admission
 * safe before a deployment is pointed at Redis.
 */

import assert from "node:assert/strict";

import {
  __resetEstimateAuditQueueCountersForTest,
  enqueueEstimateAudit,
  estimateAuditJobId,
  getEstimateAuditQueueCounters,
  type EstimateAuditJobData,
} from "../lib/queue/producer";
import {
  DEFAULT_JOB_OPTS,
  ESTIMATE_AUDIT_JOB_OPTS,
  ESTIMATE_AUDIT_QUEUE_COMMAND_TIMEOUT_MS,
  __resetQueueCacheForTest,
  __setQueueForTest,
  QUEUE_NAMES,
} from "../lib/queue/queues";

const base: EstimateAuditJobData = {
  shopId: 44,
  provider: "tekmetric",
  workOrderId: "ro-" + "x".repeat(180),
  revision: 3,
  enqueuedAt: "2026-01-01T12:00:00.000Z",
};

async function main() {
  const stable = estimateAuditJobId(base);
  assert.equal(stable, estimateAuditJobId({ ...base, enqueuedAt: "later" }));
  assert.match(
    stable,
    new RegExp(`^${QUEUE_NAMES.ESTIMATE_AUDIT}_[a-f0-9]{64}$`),
    "audit job ids use the complete SHA-256 digest",
  );
  assert.ok(!stable.includes(":"), "BullMQ custom ids cannot contain ':'");

  // The old implementation made these collide after sanitizing/truncating
  // the RO id.  Both punctuation and the suffix must remain identity-bearing.
  assert.notEqual(
    stable,
    estimateAuditJobId({ ...base, workOrderId: base.workOrderId.replace(/x$/, "y") }),
    "long RO ids that differ after the truncation boundary must not collide",
  );
  assert.notEqual(
    estimateAuditJobId({ ...base, workOrderId: "ro:a" }),
    estimateAuditJobId({ ...base, workOrderId: "ro_a" }),
    "punctuation variants must not collapse during sanitization",
  );
  assert.notEqual(
    stable,
    estimateAuditJobId({ ...base, revision: base.revision + 1 }),
    "revisions remain independently schedulable",
  );

  assert.ok(
    ESTIMATE_AUDIT_JOB_OPTS.delay >= 3_000 &&
      ESTIMATE_AUDIT_JOB_OPTS.delay <= 5_000,
    "audit bursts use a 3-5 second coalescing delay",
  );
  assert.ok(
    ESTIMATE_AUDIT_JOB_OPTS.attempts > 1 &&
      ESTIMATE_AUDIT_JOB_OPTS.attempts <= 3,
    "audit retries are explicitly capped",
  );
  assert.equal(
    DEFAULT_JOB_OPTS.attempts,
    5,
    "backfill retry defaults remain unchanged",
  );
  assert.equal(
    ESTIMATE_AUDIT_QUEUE_COMMAND_TIMEOUT_MS,
    5_000,
    "audit producer Redis calls have a bounded wait",
  );

  __resetEstimateAuditQueueCountersForTest();
  const previousEnabled = process.env.ESTIMATE_AUDIT_AUTOMATION_ENABLED;
  const previousDisabled = process.env.ESTIMATE_AUDIT_AUTOMATION_DISABLED;
  const previousInfo = console.info;
  try {
    process.env.ESTIMATE_AUDIT_AUTOMATION_ENABLED = "true";
    delete process.env.ESTIMATE_AUDIT_AUTOMATION_DISABLED;
    const addCalls: any[] = [];
    let duplicate = false;
    const fakeQueue: any = {
      async getJob() {
        if (!duplicate) return null;
        return {
          id: stable,
          async getState() {
            return "delayed";
          },
        };
      },
      async add(name: string, data: unknown, options: unknown) {
        addCalls.push({ name, data, options });
        return { id: (options as any).jobId };
      },
    };
    __setQueueForTest(QUEUE_NAMES.ESTIMATE_AUDIT, fakeQueue);
    const events: any[] = [];
    console.info = (message?: any) => {
      if (typeof message === "string") events.push(JSON.parse(message));
    };

    const queued = await enqueueEstimateAudit(base);
    assert.equal(queued.enqueued, true);
    assert.deepEqual(getEstimateAuditQueueCounters(), { queued: 1, deduped: 0 });
    assert.equal(addCalls.length, 1);
    assert.equal(addCalls[0].name, "evaluate");
    assert.equal(addCalls[0].options.jobId, stable);
    assert.equal(addCalls[0].options.delay, ESTIMATE_AUDIT_JOB_OPTS.delay);
    assert.equal(addCalls[0].options.attempts, ESTIMATE_AUDIT_JOB_OPTS.attempts);
    assert.deepEqual(addCalls[0].options.backoff, ESTIMATE_AUDIT_JOB_OPTS.backoff);
    assert.equal(events[0]?.event, "estimate_audit_queued");

    duplicate = true;
    const deduped = await enqueueEstimateAudit(base);
    assert.deepEqual(deduped, {
      enqueued: false,
      reason: "duplicate",
      queue: QUEUE_NAMES.ESTIMATE_AUDIT,
    });
    assert.deepEqual(getEstimateAuditQueueCounters(), { queued: 1, deduped: 1 });
    assert.equal(addCalls.length, 1, "delayed burst does not add a second job");
    assert.equal(events[1]?.event, "estimate_audit_deduped");
  } finally {
    console.info = previousInfo;
    __resetQueueCacheForTest();
    if (previousEnabled === undefined) delete process.env.ESTIMATE_AUDIT_AUTOMATION_ENABLED;
    else process.env.ESTIMATE_AUDIT_AUTOMATION_ENABLED = previousEnabled;
    if (previousDisabled === undefined) delete process.env.ESTIMATE_AUDIT_AUTOMATION_DISABLED;
    else process.env.ESTIMATE_AUDIT_AUTOMATION_DISABLED = previousDisabled;
  }

  console.log("queue-estimate-audit.smoke.ts: OK");
}

main().catch((error) => {
  console.error("queue-estimate-audit.smoke.ts FAILED:", error);
  process.exit(1);
});