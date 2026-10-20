import test, {before, after} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {isolatedStaffDatabase, staffFixture} from "./helpers/staff-inspection-fixture";
import {ROArrivalPhotos} from "../lib/data/repositories/ro-arrival-photos";
import {mutateStaff, snapshot} from "../lib/auto-dvi/staff/service";
import {blankFinding, missingRequirements} from "../lib/auto-dvi/staff/model";
import {STAFF_MEDIA_BUCKET} from "../lib/data/repositories/workflow-inspections";

let isolated: Awaited<ReturnType<typeof isolatedStaffDatabase>>;
before(async () => {isolated = await isolatedStaffDatabase(27826);});
after(async () => {await isolated?.close();});
async function setup() {
  const f = await staffFixture(isolated.client), workOrderId = randomUUID();
  const board = await f.deps.board.read(1);
  Object.assign(board.visits[0], {provider: "protractor", sourceId: workOrderId, sourceStatus: "WorkOrder"});
  await f.deps.board.save(1, board.revision, board);
  f.sheet.items[0].photoRequired = true;
  f.setAccess({config: {...f.access.config!, sheets: [f.sheet, f.other]}});
  const photos = new ROArrivalPhotos(async () => f.db);
  f.deps.arrivalPhotos = photos;
  await f.initialize();
  const photo = await photos.put(1, workOrderId, randomUUID(), "image/png", Buffer.from("89504e470d0a1a0a0000","hex"));
  const command = {type: "associate-arrival", sheet: "fixture@1", item: "tire.lf", mediaId: photo.id};
  const request = async (cmd = command) => ({visitId: "visit-one", requestId: randomUUID(),
    revision: (await snapshot("visit-one", f.deps)).inspection!.revision, command: cmd});
  const evaluate = async () => mutateStaff({...await request(), command: {type: "save", sheet: "fixture@1",
    item: "tire.lf", finding: {...blankFinding(), rating: "green", notes: "Examined"}}}, f.deps);
  return {f, photos, photo, workOrderId, command, request, evaluate};
}
test("explicit evaluated association preserves provenance, requirements and exact/new-request deduplication without media copies", async () => {
  const {f, photos, photo, workOrderId, request, evaluate} = await setup();
  await assert.rejects(mutateStaff(await request(), f.deps), /Save an evaluation/);
  await evaluate();
  const req = await request();
  const first = await mutateStaff(req, f.deps);
  const again = await mutateStaff(req, f.deps);
  assert.deepEqual(again.inspection, first.inspection);
  const repeated = await mutateStaff(await request(), f.deps);
  assert.deepEqual(repeated.inspection, first.inspection);
  const finding = first.inspection!.sheets[0].results["tire.lf"];
  assert.equal(finding.rating, "green");
  assert.equal(finding.arrivalPhotos!.length, 1);
  assert.equal(finding.arrivalPhotos![0].provenance, "arrival");
  assert.equal(finding.arrivalPhotos![0].workOrderId, workOrderId);
  assert.equal(finding.arrivalPhotos![0].actor, f.access.actor);
  assert.equal(finding.photos.length, 0);
  assert.ok(missingRequirements(first.inspection!).some(r => r.message === "Photo"));
  assert.ok(missingRequirements(first.inspection!).some(r => r.message !== "Photo"));
  assert.equal((await photos.list(1, workOrderId)).length, 1);
  assert.equal(await f.db.collection(`${STAFF_MEDIA_BUCKET}.files`).countDocuments(), 0);
  assert.equal(await f.db.collection("guided_ro_arrival_photos").countDocuments(), 1);
  await evaluate();
  assert.equal((await snapshot("visit-one", f.deps)).inspection!.sheets[0].results["tire.lf"].arrivalPhotos![0].id, photo.id);
});
test("cross-shop, cross-visit, read-only, stale and closed associations are denied", async () => {
  const {f, photos, workOrderId, command, request, evaluate} = await setup();
  await evaluate();
  const bytes = Buffer.from("89504e470d0a1a0a0000","hex");
  for (const [shop, wo] of [[2, workOrderId], [1, randomUUID()]] as const) {
    const foreign = await photos.put(shop, wo, randomUUID(), "image/png", bytes);
    await assert.rejects(mutateStaff(await request({...command, mediaId: foreign.id}), f.deps), /not found/);
  }
  const stale = await request();
  await evaluate();
  await assert.rejects(mutateStaff(stale, f.deps), /changed/);
  f.setAccess({canEdit: false});
  await assert.rejects(mutateStaff(await request(), f.deps), /not permitted/);
  f.setAccess({canEdit: true});
  const board = await f.deps.board.read(1);
  board.visits[0].closed = true;
  await f.deps.board.save(1, board.revision, board);
  await assert.rejects(mutateStaff(await request(), f.deps), /Closed/);
});
