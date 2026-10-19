import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoClient } from "mongodb";
import { randomUUID } from "node:crypto";
import { MongoStaffPersistence, StaffMediaStorage } from "../../lib/data/repositories/workflow-inspections";
import { StaffRepository } from "../../lib/auto-dvi/staff/store";
import { STAFF_SHEET_TEMPLATES, type StaffSheet } from "../../lib/auto-dvi/staff/model";
import { emptyBoard, type Board } from "../../lib/shop-dispatch/model";
import type { StaffDependencies } from "../../lib/auto-dvi/staff/service";
import type { StaffAccess } from "../../lib/auto-dvi/staff/access";

export async function isolatedStaffDatabase(port: number) {
  const directory = await mkdtemp(join(tmpdir(), "staff-inspection-"));
  const daemon = spawn("mongod", ["--dbpath", directory, "--bind_ip", "127.0.0.1", "--port", String(port), "--quiet"], {stdio: "ignore"});
  const uri = `mongodb://127.0.0.1:${port}/?directConnection=true`;
  const client = new MongoClient(uri, {serverSelectionTimeoutMS: 300, socketTimeoutMS: 5000});
  let ready = false;
  for (let n = 0; n < 80; n++) {
    try {await client.connect(); await client.db("admin").command({ping: 1}); ready = true; break;}
    catch {await new Promise(resolve => setTimeout(resolve, 100));}
  }
  if (!ready) {daemon.kill(); throw Error("Isolated Mongo did not start");}
  return {client, uri, async close() {
    await client.close();
    const exited = new Promise(resolve => daemon.once("exit", resolve)); daemon.kill("SIGTERM"); await exited;
    await rm(directory, {recursive: true, force: true});
  }};
}
export function syntheticVisit(id: string) {
  return {id, provider: "manual" as const, sourceId: null, sourceStatus: null, sourceFetchedAt: null, ro: "REPEATED-RO", vin: "1HGCM82633A004352", vehicle: "Synthetic fixture vehicle",
    customer: "Synthetic customer", arrivalAt: null, promiseAt: null, closed: false,
    transport: {customerPlan: "unknown", ride: "none", loaner: "none", loanerId: "", pickupAt: null, notes: ""}} as Board["visits"][number];
}
export async function staffFixture(client: MongoClient, name = `staff_${randomUUID().replaceAll("-", "")}`) {
  const db = client.db(name);
  const initial = emptyBoard(); initial.revision = 1; initial.visits = [syntheticVisit("visit-one"), syntheticVisit("visit-two")];
  await db.collection("fixture_boards").insertOne({_id: "shop:1", ...initial} as any);
  const persistence = new MongoStaffPersistence(async () => db), repository = new StaffRepository(persistence);
  const sheet: StaffSheet = {...structuredClone(STAFF_SHEET_TEMPLATES[0]), id: "fixture", name: "Approved fixture sheet",
    items: [structuredClone(STAFF_SHEET_TEMPLATES[0].items[0])]};
  const other: StaffSheet = {...structuredClone(sheet), id: "other", name: "Second approved sheet"};
  let authority: StaffAccess = {
    shopId: 1, actor: "technician-fixture", email: "technician@example.invalid", enabled: true, canEdit: true, canReview: false,
    config: {version: 1, enabledShopIds: [1], sheets: [sheet, other], defaultSheet: "fixture@1", rules: {}, individual: {}},
    authority: {actorId: "technician-fixture", currentShopId: 1, member: true, roles: ["technician"], enterprise: {}, enterpriseGoverned: [], local: {}, individual: {}},
  };
  const deps: StaffDependencies = {repository, now: () => new Date().toISOString(), access: async () => {
    if (!authority.authority.member) throw Error("Membership revoked");
    return structuredClone(authority);
  }, board: {
    read: async shop => {
      const row = await db.collection("fixture_boards").findOne({_id: `shop:${shop}`} as any);
      if (!row) return emptyBoard();
      const {_id, ...value} = row; return value as unknown as Board;
    },
    save: async (shop, revision, value) => (await db.collection("fixture_boards")
      .replaceOne({_id: `shop:${shop}`, revision} as any, {_id: `shop:${shop}`, ...value} as any)).modifiedCount === 1,
  }};
  return {db, deps, repository, persistence, sheet, other, media: new StaffMediaStorage(async () => db),
    get access() {return authority;}, setAccess(value: Partial<StaffAccess>) {authority = {...authority, ...value};},
    async initialize(visitId = "visit-one", requestId = randomUUID()) {
      const {mutateStaff} = await import("../../lib/auto-dvi/staff/service");
      return mutateStaff({visitId, requestId, revision: 0, command: {type: "initialize", boardRevision: (await deps.board.read(1)).revision}}, deps);
    },
  };
}
