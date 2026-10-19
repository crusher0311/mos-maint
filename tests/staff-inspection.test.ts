import test, {before, after} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {MongoClient} from "mongodb";
import {isolatedStaffDatabase, staffFixture} from "./helpers/staff-inspection-fixture";
import {mutateStaff, snapshot} from "../lib/auto-dvi/staff/service";
import {attachStaffPhoto, readStaffPhoto} from "../lib/auto-dvi/staff/media";
import {StaffRepository} from "../lib/auto-dvi/staff/store";
import {MongoStaffPersistence, STAFF_MEDIA_BUCKET} from "../lib/data/repositories/workflow-inspections";
import {blankFinding, missingRequirements, STAFF_SHEET_TEMPLATES, applyStaffCommand, initialInspection} from "../lib/auto-dvi/staff/model";
import {VISIT_DVI_RELEASE_ENABLED} from "../lib/auto-dvi/visit-release";
import {effectiveInspectionPermission} from "../lib/auto-dvi/workflow-policy";

let isolated: Awaited<ReturnType<typeof isolatedStaffDatabase>>;
before(async () => {isolated = await isolatedStaffDatabase(27816);});
after(async () => {await isolated?.close();});
const full = () => ({...blankFinding(), rating: "green" as const, notes: "Manual evaluation recorded",
  values: {unit: "32nds", inner: 7, center: 8, outer: 7, beforePsi: 32}});
async function save(f: Awaited<ReturnType<typeof staffFixture>>, finding = full()) {
  const s = await snapshot("visit-one", f.deps);
  return mutateStaff({visitId: "visit-one", requestId: randomUUID(), revision: s.inspection!.revision,
    command: {type: "save", sheet: "fixture@1", item: "tire.lf", finding}}, f.deps);
}
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
test("persisted technician-to-advisor flow, no auto-green, same VIN/RO separate, readiness invalidation", async () => {
  const f = await staffFixture(isolated.client);
  const unopened = await snapshot("visit-one", f.deps);
  assert.equal(unopened.record, null); // reads never admit work
  let s = await f.initialize();
  assert.equal(s.inspection!.startedAt, null);
  assert.equal(s.inspection!.sheets[0].results["tire.lf"], undefined);
  assert.ok(missingRequirements(s.inspection!).length);
  s = await save(f);
  assert.ok(s.inspection!.startedAt);
  const request = {visitId: "visit-one", requestId: randomUUID(), revision: s.inspection!.revision, command: {type: "ready"}};
  s = await mutateStaff(request, f.deps);
  await assert.rejects(mutateStaff({...request, requestId: randomUUID(), revision: s.inspection!.revision, command: {type: "review"}}, f.deps), /Advisor/);
  f.setAccess({actor: "advisor-fixture", canReview: true});
  s = await mutateStaff({...request, requestId: randomUUID(), revision: s.inspection!.revision, command: {type: "review"}}, f.deps);
  assert.equal(s.inspection!.reviewed!.revision, s.inspection!.evidenceRevision);
  const reopened = new MongoClient(isolated.uri);
  await reopened.connect();
  try {
    const repo = new StaffRepository(new MongoStaffPersistence(async () => reopened.db(f.db.databaseName)));
    assert.deepEqual((await repo.read(1, "visit-one"))!.results.staff, s.inspection);
  } finally {await reopened.close();}
  const edited = await save(f, {...full(), notes: "Changed after review"});
  assert.notEqual(edited.inspection!.reviewed!.revision, edited.inspection!.evidenceRevision);
  const second = await f.initialize("visit-two");
  assert.equal(second.inspection!.startedAt, null);
  assert.deepEqual(second.inspection!.sheets[0].results, {});
  assert.equal((await f.deps.board.read(1)).visits.length, 2);
  assert.equal((await f.deps.board.read(1)).jobs.length, 0);
  assert.equal(VISIT_DVI_RELEASE_ENABLED, false);
});
test("lost board acknowledgment, lost inspection acknowledgment and exact actor/digest receipts", async () => {
  const f = await staffFixture(isolated.client), boardSave = f.deps.board.save;
  let once = true;
  f.deps.board.save = async (...args) => {const result = await boardSave(...args); if (once) {once = false; throw Error("lost ack");} return result;};
  let s = await f.initialize();
  const original = f.persistence.cas.bind(f.persistence);
  f.persistence.cas = async (...args) => {await original(...args); throw Error("lost evidence ack");};
  const request = {visitId: "visit-one", requestId: randomUUID(), revision: s.inspection!.revision,
    command: {type: "save", sheet: "fixture@1", item: "tire.lf", finding: full()}};
  await assert.rejects(mutateStaff(request, f.deps), /lost evidence ack/);
  f.persistence.cas = original;
  s = await mutateStaff(request, f.deps);
  assert.equal(s.inspection!.revision, 2);
  assert.equal((await f.persistence.read(1)).events.filter(e => e.requestId === request.requestId).length, 1);
  await assert.rejects(mutateStaff({...request, command: {...request.command, finding: {...full(), notes: "different"}}}, f.deps), /conflicts/);
  f.setAccess({actor: "other"});
  await assert.rejects(mutateStaff(request, f.deps), /conflicts/);
});
test("interrupted binding recovers original request after restart without new visit or provider action", async () => {
  const f = await staffFixture(isolated.client), original = f.repository.commit.bind(f.repository);
  const request = {visitId: "visit-one", requestId: randomUUID(), revision: 0, command: {type: "initialize", boardRevision: 1}};
  f.repository.commit = async () => {throw Error("storage unavailable");};
  await assert.rejects(mutateStaff(request, f.deps), /pending/);
  const pending = await snapshot("visit-one", f.deps);
  assert.equal(pending.bindingRequest!.requestId, request.requestId);
  await assert.rejects(mutateStaff({...request, requestId: randomUUID()}, f.deps), /original/);
  f.repository.commit = original;
  await mutateStaff(request, f.deps);
  assert.equal((await f.deps.board.read(1)).dviAdmissions!.length, 1);
  assert.equal((await f.deps.board.read(1)).visits.length, 2);
});
test("competing edits reject stale revision without overwriting; sheet switch preserves evidence and manual choices", async () => {
  const f = await staffFixture(isolated.client), s = await f.initialize();
  const request = {visitId: "visit-one", revision: s.inspection!.revision,
    command: {type: "save", sheet: "fixture@1", item: "tire.lf", finding: full()}};
  const results = await Promise.allSettled([mutateStaff({...request, requestId: randomUUID()}, f.deps), mutateStaff({...request, requestId: randomUUID()}, f.deps)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  let current = await snapshot("visit-one", f.deps);
  current = await mutateStaff({visitId: "visit-one", revision: current.inspection!.revision, requestId: randomUUID(),
    command: {type: "select", sheet: "other@1", keepActive: false}}, f.deps);
  assert.equal(current.inspection!.sheets[0].active, false);
  assert.equal(current.inspection!.sheets[0].results["tire.lf"].values.inner, 7);
  assert.deepEqual(current.inspection!.sheets[1].results, {});
  current = await mutateStaff({visitId: "visit-one", revision: current.inspection!.revision, requestId: randomUUID(),
    command: {type: "select", sheet: "fixture@1", keepActive: true}}, f.deps);
  assert.equal(current.inspection!.sheets.filter(s => s.active).length, 2);
  assert.equal(current.inspection!.sheets[0].selection, "manual");
});
test("green needs documentation, reasoned N/A, blank wheel/battery fields and original units", async () => {
  const template = STAFF_SHEET_TEMPLATES[0], state = initialInspection(template);
  const next = applyStaffCommand(state, {type: "save", sheet: "manual-safety@1", item: "tire.lf",
    finding: {...blankFinding(), rating: "green", values: {unit: "mm", inner: 5.5}}}, [template], "actor", new Date().toISOString(), false);
  assert.equal(next.sheets[0].results["tire.rf"], undefined);
  assert.equal(next.sheets[0].results["battery"], undefined);
  assert.equal(next.sheets[0].results["tire.lf"].values.unit, "mm");
  assert.ok(missingRequirements(next).some(e => e.message === "Evaluation notes"));
  assert.ok(missingRequirements(next).some(e => e.message === "Center tread"));
  assert.throws(() => applyStaffCommand(state, {type: "save", sheet: "manual-safety@1", item: "tire.lf",
    finding: {...blankFinding(), rating: "na"}}, [template], "actor", new Date().toISOString(), false), /reason/);
});
test("photos persist with provenance, exact retries, cross-item/shop access denied, closed/revoked mid-upload remain internal", async () => {
  const f = await staffFixture(isolated.client);
  await f.initialize(); let s = await save(f);
  const request = {visitId: "visit-one", sheet: "fixture@1", item: "tire.lf", revision: s.inspection!.revision,
    requestId: randomUUID(), mime: "image/png", provenance: "upload"};
  s = await attachStaffPhoto(request, png, f.deps, f.media);
  const photo = s.inspection!.sheets[0].results["tire.lf"].photos[0];
  assert.deepEqual((await readStaffPhoto("visit-one", "fixture@1", "tire.lf", photo.id, f.deps, f.media)).bytes, png);
  await attachStaffPhoto(request, png, f.deps, f.media);
  assert.equal(await f.db.collection(`${STAFF_MEDIA_BUCKET}.files`).countDocuments(), 1);
  await assert.rejects(readStaffPhoto("visit-two", "fixture@1", "tire.lf", photo.id, f.deps, f.media));
  await assert.rejects(readStaffPhoto("visit-one", "fixture@1", "tire.rf", photo.id, f.deps, f.media));
  const upload = f.media.upload.bind(f.media);
  f.media.upload = async (...args) => {await upload(...args); const board = await f.deps.board.read(1); board.visits[0].closed = true; board.revision++; await f.deps.board.save(1, board.revision - 1, board);};
  const failed = {...request, revision: s.inspection!.revision, requestId: randomUUID()};
  await assert.rejects(attachStaffPhoto(failed, png, f.deps, f.media), /Closed/);
  const orphan = (await f.persistence.read(1)).uploads.find(u => u.requestId === failed.requestId)!;
  await assert.rejects(readStaffPhoto("visit-one", "fixture@1", "tire.lf", orphan.photo.id, f.deps, f.media), /not attached/);
  assert.ok((await snapshot("visit-one", f.deps)).inspection);
  assert.equal((await snapshot("visit-one", f.deps)).canEdit, false);
  const abandoned = await f.repository.abandonPhotos(1, "2099-01-01T00:00:00.000Z");
  for (const id of abandoned) await f.media.deleteAbandoned(id);
  assert.equal(await f.db.collection(`${STAFF_MEDIA_BUCKET}.files`).countDocuments(), 1);
  f.setAccess({shopId: 2});
  await assert.rejects(readStaffPhoto("visit-one", "fixture@1", "tire.lf", photo.id, f.deps, f.media));
});
test("fresh permission revocation during media and rollback block sinks but preserve read evidence", async () => {
  const f = await staffFixture(isolated.client); await f.initialize(); const s = await save(f);
  const upload = f.media.upload.bind(f.media);
  f.media.upload = async (...args) => {await upload(...args); f.setAccess({canEdit: false, enabled: false});};
  await assert.rejects(attachStaffPhoto({visitId: "visit-one", sheet: "fixture@1", item: "tire.lf",
    revision: s.inspection!.revision, requestId: randomUUID(), mime: "image/png", provenance: "camera"}, png, f.deps, f.media), /disabled/);
  const read = await snapshot("visit-one", f.deps);
  assert.equal(read.inspection!.sheets[0].results["tire.lf"].photos.length, 0);
  assert.equal(read.enabled, false);
  assert.equal(effectiveInspectionPermission({...f.access.authority, enterpriseGoverned: ["edit"], enterprise: {}, individual: {edit: "allow"}}, 1, "edit").allowed, false);
  assert.equal(effectiveInspectionPermission({...f.access.authority, individual: {publish: "allow"}}, 1, "publish").allowed, false);
});
