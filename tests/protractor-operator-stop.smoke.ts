import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  __protractorPhysicalTransportTestHooks,
  acquireProtractorPhysicalTransportLease,
  activateProtractorOperatorStop,
  clearProtractorOperatorStop,
  confirmProtractorPhysicalTransportLease,
  getProtractorOperatorStop,
  releaseProtractorPhysicalTransportLease,
} from "../lib/data/repositories/api-usage";
import { createMongoExpressionCollection } from "./helpers/mongo-expression-collection";

let now = new Date(Date.now() + 1_000);
let sequence = 0;
let failAfterCommit = false;
const collection = createMongoExpressionCollection({
  _id: "protractor-physical-transport-v1",
  count: 0,
  nextAllowedAt: new Date(0),
  leaseExpiresAt: new Date(0),
  operatorStop: {
    active: true,
    stopId: "initial-stop",
    reason: "incident",
    changedBy: "operator",
    activatedAt: now,
    updatedAt: now,
  },
}, {
  now: () => now,
  afterFindOneAndUpdate: () => {
    if (!failAfterCommit) return undefined;
    failAfterCommit = false;
    return new Error("confirmation response lost after commit");
  },
});

__protractorPhysicalTransportTestHooks.getDb = async () => ({
  collection: () => collection,
} as any);
__protractorPhysicalTransportTestHooks.randomUUID = () => `id-${++sequence}`;

function activeStop(stopId: string): void {
  collection.row.operatorStop = {
    active: true,
    stopId,
    reason: "test containment",
    changedBy: "test-operator",
    activatedAt: now,
    updatedAt: now,
  };
}

async function openCanary(stopId: string, maxAdmissions = 3, lifetimeMs = 60_000) {
  activeStop(stopId);
  return clearProtractorOperatorStop({
    changedBy: "test-operator",
    reason: "bounded test",
    expectedStopId: stopId,
    expiresAt: new Date(now.getTime() + lifetimeMs),
    maxAdmissions,
    now,
  });
}

async function consumeAdmission(): Promise<boolean> {
  const lease = await acquireProtractorPhysicalTransportLease(Date.now() + 20);
  if (!lease) return false;
  const confirmed = await confirmProtractorPhysicalTransportLease(lease);
  await releaseProtractorPhysicalTransportLease(lease);
  now = new Date(now.getTime() + 1_001);
  return confirmed;
}

async function main(): Promise<void> {
  console.log("Scenario 1: repository expressions enforce a bounded generation");
  const cleared = await clearProtractorOperatorStop({
    changedBy: "test-operator",
    reason: "three-request canary",
    expectedStopId: "initial-stop",
    expiresAt: new Date(now.getTime() + 60_000),
    maxAdmissions: 3,
    now,
  });
  assert.equal(cleared.active, false);
  assert.equal(cleared.canary?.remainingAdmissions, 3);
  assert.equal(await consumeAdmission(), true);
  assert.equal(await consumeAdmission(), true);
  assert.equal(await consumeAdmission(), true);
  assert.equal(await consumeAdmission(), false, "the fourth physical attempt must be denied");
  let status = await getProtractorOperatorStop();
  assert.equal(status.canary?.generation, cleared.canary?.generation);
  assert.equal(status.canary?.consumedAdmissions, 3);
  assert.equal(status.canary?.remainingAdmissions, 0);
  assert.equal(status.canary?.endedBy, "budget");
  assert.deepEqual(status.canary?.audit.map(event => event.event), [
    "opened", "admitted", "admitted", "admitted", "ended",
  ]);

  console.log("Scenario 2: simultaneous duplicate confirmation consumes exactly once");
  await openCanary("duplicate-stop");
  const duplicateLease = await acquireProtractorPhysicalTransportLease(Date.now() + 20);
  assert.ok(duplicateLease);
  const duplicateResults = await Promise.all([
    confirmProtractorPhysicalTransportLease(duplicateLease!),
    confirmProtractorPhysicalTransportLease(duplicateLease!),
  ]);
  assert.deepEqual(
    duplicateResults.sort(),
    [false, true],
    "a token may cross the final physical-admission boundary only once",
  );
  status = await getProtractorOperatorStop();
  assert.equal(status.canary?.consumedAdmissions, 1);
  assert.equal(status.canary?.audit.filter(event => event.event === "admitted").length, 1);
  await releaseProtractorPhysicalTransportLease(duplicateLease!);
  now = new Date(now.getTime() + 1_001);

  console.log("Scenario 3: committed confirmation errors do not refund or re-dispatch");
  const committed = await openCanary("commit-then-error-stop", 1);
  const committedLease = await acquireProtractorPhysicalTransportLease(Date.now() + 20);
  assert.ok(committedLease);
  failAfterCommit = true;
  await assert.rejects(
    confirmProtractorPhysicalTransportLease(committedLease!),
    /confirmation response lost after commit/,
  );
  await releaseProtractorPhysicalTransportLease(committedLease!);
  status = await getProtractorOperatorStop();
  assert.equal(status.canary?.generation, committed.canary?.generation);
  assert.equal(status.canary?.consumedAdmissions, 1);
  assert.deepEqual(status.canary?.audit.slice(-2).map(event => event.event), [
    "admitted",
    "ended",
  ]);
  assert.equal(
    await acquireProtractorPhysicalTransportLease(Date.now() + 20),
    null,
    "a lost confirmation response must not refund a committed admission",
  );
  now = new Date(now.getTime() + 1_001);

  console.log("Scenario 4: malformed accounting records fail closed without arithmetic");
  const malformedCounters = [
    { maxAdmissions: 4, consumedAdmissions: 0 },
    { maxAdmissions: 3.5, consumedAdmissions: 0 },
    { maxAdmissions: 3, consumedAdmissions: -1 },
    { maxAdmissions: 3, consumedAdmissions: 4 },
    { maxAdmissions: "3", consumedAdmissions: 0 },
    { maxAdmissions: 3, consumedAdmissions: "0" },
  ];
  for (const [index, counters] of malformedCounters.entries()) {
    const generation = `malformed-generation-${index}`;
    activeStop(`malformed-stop-${index}`);
    collection.row.operatorStop = { active: false };
    collection.row.canary = {
      generation,
      expiresAt: new Date(now.getTime() + 60_000),
      ...counters,
      audit: [],
    };
    delete collection.row.ownerToken;
    delete collection.row.ownerCanaryGeneration;
    delete collection.row.physicalAdmissionOwnerToken;
    collection.row.nextAllowedAt = new Date(0);
    collection.row.leaseExpiresAt = new Date(0);
    const before = JSON.stringify(collection.row.canary);
    assert.equal(
      await acquireProtractorPhysicalTransportLease(Date.now() + 20),
      null,
      `malformed accounting record ${index} must not acquire`,
    );
    collection.row.ownerToken = `malformed-owner-${index}`;
    collection.row.ownerCanaryGeneration = generation;
    collection.row.leaseExpiresAt = new Date(now.getTime() + 60_000);
    assert.equal(
      await confirmProtractorPhysicalTransportLease(collection.row.ownerToken),
      false,
      `malformed accounting record ${index} must not confirm`,
    );
    assert.equal(
      JSON.stringify(collection.row.canary),
      before,
      `malformed accounting record ${index} must remain unchanged`,
    );
    delete collection.row.ownerToken;
    delete collection.row.ownerCanaryGeneration;
    collection.row.leaseExpiresAt = new Date(0);
    now = new Date(now.getTime() + 1_001);
  }

  console.log("Scenario 5: expiry between lease and confirmation is finalized");
  const expiring = await openCanary("expiry-stop", 3, 100);
  const expiringLease = await acquireProtractorPhysicalTransportLease(Date.now() + 20);
  assert.ok(expiringLease);
  now = new Date(now.getTime() + 101);
  assert.equal(await confirmProtractorPhysicalTransportLease(expiringLease!), false);
  status = await getProtractorOperatorStop();
  assert.equal(status.canary?.generation, expiring.canary?.generation);
  assert.equal(status.canary?.consumedAdmissions, 0);
  assert.equal(status.canary?.endedBy, "time");
  assert.equal(status.canary?.audit.at(-1)?.event, "ended");
  assert.equal(status.canary?.audit.at(-1)?.endedBy, "time");
  await releaseProtractorPhysicalTransportLease(expiringLease!);
  now = new Date(now.getTime() + 1_001);

  console.log("Scenario 6: stop/clear races and stale stop IDs fail closed");
  activeStop("race-stop");
  const race = await Promise.allSettled([
    clearProtractorOperatorStop({
      changedBy: "clear-operator",
      reason: "race clear",
      expectedStopId: "race-stop",
      expiresAt: new Date(now.getTime() + 60_000),
      maxAdmissions: 1,
      now,
    }),
    activateProtractorOperatorStop({
      changedBy: "stop-operator",
      reason: "race activation",
      now,
    }),
  ]);
  status = await getProtractorOperatorStop();
  assert.equal(status.active, true, "activation concurrent with clear must leave containment active");
  assert.ok(race.some(result => result.status === "fulfilled"));
  await assert.rejects(
    clearProtractorOperatorStop({
      changedBy: "stale-operator",
      reason: "stale clear",
      expectedStopId: "race-stop",
      expiresAt: new Date(now.getTime() + 60_000),
      maxAdmissions: 1,
      now,
    }),
    /operator stop changed/,
  );
  assert.equal((await getProtractorOperatorStop()).active, true);

  console.log("Scenario 7: an in-flight old generation cannot confirm after replacement");
  const old = await openCanary(status.stopId!);
  const staleLease = await acquireProtractorPhysicalTransportLease(Date.now() + 20);
  assert.ok(staleLease);
  await activateProtractorOperatorStop({
    changedBy: "test-operator",
    reason: "replace generation",
    now,
  });
  status = await getProtractorOperatorStop();
  await openCanary(status.stopId!);
  assert.notEqual(collection.row.canary.generation, old.canary?.generation);
  assert.equal(await confirmProtractorPhysicalTransportLease(staleLease!), false);

  console.log("Scenario 8: legacy records remain usable without a canary");
  delete collection.row.canary;
  collection.row.operatorStop = { active: false };
  delete collection.row.ownerToken;
  delete collection.row.ownerCanaryGeneration;
  collection.row.physicalAdmissionOwnerToken = "abandoned-owner";
  collection.row.physicalAdmissionStartedAt = new Date(now.getTime() - 10_000);
  collection.row.nextAllowedAt = new Date(0);
  collection.row.leaseExpiresAt = new Date(0);
  const legacyLease = await acquireProtractorPhysicalTransportLease(Date.now() + 20);
  assert.ok(legacyLease, "deploying bounded-canary support must not stop legacy traffic");
  assert.equal(
    Object.hasOwn(collection.row, "physicalAdmissionOwnerToken"),
    false,
    "a new owner must clear the expired owner's admission marker",
  );
  assert.equal(
    Object.hasOwn(collection.row, "physicalAdmissionStartedAt"),
    false,
    "a new owner must clear the expired owner's admission timestamp",
  );
  assert.equal(await confirmProtractorPhysicalTransportLease(legacyLease!), true);
  assert.equal(await confirmProtractorPhysicalTransportLease(legacyLease!), false);
  await releaseProtractorPhysicalTransportLease(legacyLease!);

  console.log("Scenario 9: status retains only the latest twenty completed generations");
  activeStop("history-0");
  const generations: string[] = [];
  for (let index = 0; index < 21; index += 1) {
    const opened = await clearProtractorOperatorStop({
      changedBy: "history-operator",
      reason: `generation ${index}`,
      expectedStopId: collection.row.operatorStop.stopId,
      expiresAt: new Date(now.getTime() + 60_000),
      maxAdmissions: 1,
      now,
    });
    generations.push(opened.canary!.generation);
    await activateProtractorOperatorStop({
      changedBy: "history-operator",
      reason: `close ${index}`,
      now,
    });
  }
  status = await getProtractorOperatorStop();
  const history = (status as any).canaryHistory;
  assert.equal(history.length, 20);
  assert.deepEqual(
    history.map((canary: any) => canary.generation),
    generations.slice(0, -1),
  );
  assert.ok(history.every((canary: any) => canary.audit.length >= 2));

  console.log("Scenario 10: safety record updates carry no physical-record TTL");
  const physicalUpdates = collection.calls.filter(call =>
    call.filter?._id === "protractor-physical-transport-v1" && call.update
  );
  assert.ok(physicalUpdates.length > 0);
  assert.ok(
    physicalUpdates.every(call => !JSON.stringify(call.update).includes('"expiresAt":{"$dateAdd"')),
    "the permanent physical safety record must not receive collection TTL expiresAt",
  );

  console.log("Scenario 11: activation uses the Mongo server clock outside the test seam");
  await activateProtractorOperatorStop({
    changedBy: "server-clock-operator",
    reason: "server-clock containment",
  });
  const serverClockUpdate = collection.calls.at(-1)?.update;
  assert.equal(serverClockUpdate?.[0]?.$set?.operatorStop?.activatedAt, "$$NOW");
  assert.equal(serverClockUpdate?.[0]?.$set?.operatorStop?.updatedAt, "$$NOW");
  assert.ok(
    JSON.stringify(serverClockUpdate).includes('["$canary.expiresAt","$$NOW"]'),
    "canary expiry classification must use the same Mongo server clock",
  );
  assert.ok(
    JSON.stringify(serverClockUpdate).includes('"at":"$$NOW"'),
    "operator-stop audit timestamps must use the Mongo server clock",
  );

  console.log("Scenario 12: production log fixture excludes build-service contamination");
  const runbook = readFileSync("docs/runbooks/protractor-storm-recovery.md", "utf8");
  const sql = runbook.match(/```sql\s+([\s\S]*?)```/)?.[1] ?? "";
  const rows = [
    { host: "mos-maintenance-mvp-main", appname: "web-a", physicalAdmissions: 2 },
    { host: "mos-maintenance-mvp-main", appname: "bld-a", physicalAdmissions: 99 },
    { host: "other-service", appname: "web-a", physicalAdmissions: 50 },
  ];
  assert.match(sql, /syslog\.host = 'mos-maintenance-mvp-main'/);
  assert.match(sql, /syslog\.appname LIKE 'web-%'/);
  assert.match(sql, /syslog\.appname NOT LIKE 'bld-%'/);
  const observed = rows.filter(row =>
    row.host === "mos-maintenance-mvp-main" &&
    row.appname.startsWith("web-") &&
    !row.appname.startsWith("bld-")
  );
  assert.equal(observed.reduce((sum, row) => sum + row.physicalAdmissions, 0), 2);

  console.log("All Protractor bounded-canary repository checks passed");
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});