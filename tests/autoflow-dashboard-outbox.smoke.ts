import assert from "node:assert/strict";
import {
  __deps,
  drainAutoflowDashboardUpdates,
  finishAutoflowDashboardUpdate,
  reserveAutoflowDashboardUpdate,
} from "../lib/autoflow-dashboard-outbox";
import { fakeMongo } from "./helpers/autoflow-outbox-fake";

async function run() {
  let now = Date.parse("2026-01-01T00:00:00Z");
  __deps.now = () => now;

  const mongo = fakeMongo();
  const delivered: Array<[string, string]> = [];
  let markerFailures = 0;
  __deps.bumpDashboardUpdate = async (_db, source, shopId, options) => {
    assert.equal(options?.maxTimeMS, 2_000);
    if (markerFailures > 0) {
      markerFailures -= 1;
      throw new Error("marker unavailable");
    }
    delivered.push([String(shopId), String(source)]);
    return now;
  };

  await assert.rejects(
    reserveAutoflowDashboardUpdate(mongo.db, 0, "autoflow_webhook"),
    /positive integer/,
  );
  await assert.rejects(
    reserveAutoflowDashboardUpdate(mongo.db, 1, "other" as any),
    /source/,
  );

  const first = await reserveAutoflowDashboardUpdate(
    mongo.db,
    "42",
    "autoflow_webhook",
  );
  assert.equal(mongo.rows[0].status, "prepared");
  assert.equal(mongo.rows[0].dueAt.getTime(), now + 60_000);
  assert.equal(delivered.length, 0, "reserve performs no upstream or notification work");

  mongo.failNextUpdate();
  await assert.doesNotReject(finishAutoflowDashboardUpdate(mongo.db, first));
  assert.equal(mongo.rows[0].status, "prepared", "failed ready marker stays recoverable");

  now += 60_000;
  await drainAutoflowDashboardUpdates(mongo.db);
  assert.deepEqual(delivered[0], ["42", "autoflow_webhook"]);
  assert.equal(mongo.rows[0].status, "prepared", "prepared recovery bump is not an ack");

  now += 60_000;
  await finishAutoflowDashboardUpdate(mongo.db, first);
  assert.equal(mongo.rows.length, 0, "late finalization resets attempts and ready delivery deletes");

  const readyRetry = await reserveAutoflowDashboardUpdate(
    mongo.db,
    7,
    "autoflow_webhook",
  );
  markerFailures = 1;
  await finishAutoflowDashboardUpdate(mongo.db, readyRetry);
  assert.equal(mongo.rows[0].status, "ready", "marker failure leaves durable ready work");
  now += 60_000;
  await drainAutoflowDashboardUpdates(mongo.db);
  assert.equal(mongo.rows.length, 0, "cron recovers a failed immediate marker");

  const lostAck = await reserveAutoflowDashboardUpdate(
    mongo.db,
    8,
    "autoflow_webhook",
  );
  mongo.failNextDelete();
  await finishAutoflowDashboardUpdate(mongo.db, lostAck);
  assert.equal(mongo.rows[0]._id, lostAck, "ack failure retains the intent");
  now += 30_000;
  await drainAutoflowDashboardUpdates(mongo.db);
  assert.equal(mongo.rows.length, 0, "expired fenced lease retries a lost ack");

  const repeatedFinish = await reserveAutoflowDashboardUpdate(
    mongo.db,
    10,
    "autoflow_workflow",
  );
  mongo.rows[0].attempts = 7; // model repeated prepared crash recovery
  markerFailures = 2;
  await finishAutoflowDashboardUpdate(mongo.db, repeatedFinish);
  assert.equal(mongo.rows[0].attempts, 1, "finalization resets prepared attempts");
  now += 60_000;
  await finishAutoflowDashboardUpdate(mongo.db, repeatedFinish);
  assert.equal(mongo.rows[0].attempts, 2, "late duplicate finish does not reset again");
  mongo.rows.splice(0);

  const one = await reserveAutoflowDashboardUpdate(mongo.db, 1, "autoflow_workflow");
  const two = await reserveAutoflowDashboardUpdate(mongo.db, 2, "autoflow_workflow");
  await finishAutoflowDashboardUpdate(mongo.db, one);
  await finishAutoflowDashboardUpdate(mongo.db, two);
  assert(delivered.some(([shop]) => shop === "1") && delivered.some(([shop]) => shop === "2"));
  assert(mongo.options.every((option) => option.maxTimeMS === 2_000));

  // Two concurrent drains can only acquire a row once because claim+lease is atomic.
  const concurrent = fakeMongo();
  await reserveAutoflowDashboardUpdate(concurrent.db, 9, "autoflow_webhook");
  now += 60_000;
  const before = delivered.length;
  await Promise.all([
    drainAutoflowDashboardUpdates(concurrent.db),
    drainAutoflowDashboardUpdates(concurrent.db),
  ]);
  assert.equal(delivered.length, before + 1);

  // Batch processing is finite even with a large due queue.
  const bounded = fakeMongo();
  for (let index = 1; index <= 30; index += 1) {
    await reserveAutoflowDashboardUpdate(bounded.db, index, "autoflow_webhook");
  }
  now += 60_000;
  assert.equal(await drainAutoflowDashboardUpdates(bounded.db), 25);

  const crashed = fakeMongo();
  await reserveAutoflowDashboardUpdate(crashed.db, 99, "autoflow_webhook");
  crashed.rows[0].attempts = 8;
  crashed.rows[0].leaseToken = "crashed-worker";
  crashed.rows[0].leaseUntil = new Date(now - 1);
  assert.equal(await drainAutoflowDashboardUpdates(crashed.db), 1);
  assert.equal(crashed.rows[0].status, "terminal", "last crashed claim cannot wedge forever");
  assert(crashed.rows[0].terminalAt instanceof Date);

  const exhausted = fakeMongo();
  const exhaustedId = await reserveAutoflowDashboardUpdate(
    exhausted.db,
    100,
    "autoflow_workflow",
  );
  markerFailures = 8;
  await finishAutoflowDashboardUpdate(exhausted.db, exhaustedId);
  for (let attempt = 2; attempt <= 8; attempt += 1) {
    now += 60 * 60_000;
    await drainAutoflowDashboardUpdates(exhausted.db);
  }
  assert.equal(exhausted.rows[0].attempts, 8);
  assert.equal(exhausted.rows[0].status, "terminal", "eight actual failures exhaust retries");

  const expired = fakeMongo();
  await reserveAutoflowDashboardUpdate(expired.db, 101, "autoflow_webhook");
  now += 24 * 60 * 60_000 + 1;
  await drainAutoflowDashboardUpdates(expired.db);
  assert.equal(expired.rows[0].status, "terminal", "intent lifetime is limited to 24 hours");

  const indexRecovery = fakeMongo();
  indexRecovery.failNextIndex();
  await assert.rejects(
    reserveAutoflowDashboardUpdate(indexRecovery.db, 102, "autoflow_webhook"),
    /index failure/,
  );
  await assert.doesNotReject(
    reserveAutoflowDashboardUpdate(indexRecovery.db, 102, "autoflow_webhook"),
  );
  assert.equal(indexRecovery.rows.length, 1, "failed cached initialization is retried");

  const raced = fakeMongo();
  const racedId = await reserveAutoflowDashboardUpdate(
    raced.db,
    103,
    "autoflow_webhook",
  );
  now += 60_000;
  raced.afterNextClaim(async () => {
    markerFailures = 1;
    await finishAutoflowDashboardUpdate(raced.db, racedId);
  });
  await drainAutoflowDashboardUpdates(raced.db);
  assert.equal(raced.rows[0].status, "ready");
  assert.equal(raced.rows[0].attempts, 1);
  assert.equal(
    raced.rows[0].leaseToken,
    undefined,
    "stale prepared acknowledgement cannot overwrite finalization's fence",
  );

  const deadline = fakeMongo();
  await reserveAutoflowDashboardUpdate(deadline.db, 104, "autoflow_webhook");
  await reserveAutoflowDashboardUpdate(deadline.db, 105, "autoflow_webhook");
  now += 60_000;
  deadline.afterNextClaim(() => {
    now += 20_000;
  });
  assert.equal(
    await drainAutoflowDashboardUpdates(deadline.db),
    1,
    "drain stops claiming rows at its 20-second deadline",
  );

  console.log("autoflow dashboard outbox smoke tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});