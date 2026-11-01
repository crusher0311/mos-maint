import test, {before, after} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {isolatedStaffDatabase} from "./helpers/staff-inspection-fixture";
import {MongoRecordingPersistence, RecordingRepository, type Recording} from "../lib/auto-dvi/staff/recording-store";
let isolated: Awaited<ReturnType<typeof isolatedStaffDatabase>>;
before(async () => {isolated = await isolatedStaffDatabase(27942);});
after(async () => {await isolated.close();});
test("durable segment receipts survive restart, lost acknowledgments and worker claim races", async () => {
  const db = isolated.client.db(`recording_${randomUUID().replaceAll("-", "")}`);
  const persistence = new MongoRecordingPersistence(async () => db);
  const repository = new RecordingRepository(persistence), authorize = async () => {};
  const record: Recording = {id: randomUUID(), shopId: 1, visitId: "exact-visit", actor: "fixture",
    contributorEmail: "fixture@example.invalid",
    identityDigest: "a".repeat(64), inspectionRevision: 3, policyVersion: 1, revision: 0,
    createdAt: "2026-10-31T12:00:00.000Z", state: "open", targets: [], segments: []};
  await repository.create(record, authorize);
  assert.equal((await repository.create(record, authorize)).revision, 0);
  const segment = {sequence: 0, digest: "b".repeat(64), bytes: 100, mime: "video/webm" as const,
    durationSeconds: 10, mediaId: "c".repeat(24), state: "uploaded" as const,
    attempts: 0, lease: null, drafts: [], error: null};
  const realCas = persistence.cas.bind(persistence);
  persistence.cas = async (...args) => {await realCas(...args); throw Error("Lost acknowledgment");};
  await assert.rejects(repository.append(record, segment, authorize), /Lost acknowledgment/);
  persistence.cas = realCas;
  await repository.append(record, segment, authorize);
  assert.equal((await persistence.read(1, "exact-visit", record.id))!.segments.length, 1);
  const resumed = new RecordingRepository(new MongoRecordingPersistence(async () => db));
  const claims = await Promise.allSettled([resumed.claim(record, 0, 0, authorize), repository.claim(record, 0, 0, authorize)]);
  assert.equal(claims.filter(r => r.status === "fulfilled").length, 1);
  const claim = claims.find(r => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof resumed.claim>>>;
  await assert.rejects(resumed.finish(record, 0, claim.value.token, 1, {drafts: []}, async () => {throw Error("Revoked");}), /Revoked/);
  await resumed.finish(record, 0, claim.value.token, 1, {drafts: []}, authorize);
  assert.equal((await persistence.read(1, "exact-visit", record.id))!.segments[0].state, "processed");
  assert.equal(await persistence.read(2, "exact-visit", record.id), null);
  assert.equal(await persistence.read(1, "another-visit", record.id), null);
});
