import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoClient } from "mongodb";
import { pilotEvidence, pilotHash, pilotInRange, PILOT_CONTROL } from "../lib/tire-dot-pilot";
import { tickTirePilot } from "../lib/tire-dot-pilot-worker";
import { createTirePilotManualBudget } from "../lib/tire-dot-manual-budget";

const invoice = (id = 1) => ({ id, shopId: 10, repairOrderNumber: id,
  postedDate: "2026-10-15T10:00:00Z", repairOrderStatus: { code: "POSTED", name: "Posted" },
  milesIn: 123, customer: { firstName: "private" }, customerConcerns: ["private"],
  jobs: [{ id: 4, authorized: true, note: "private",
    parts: [{ id: 5, name: "Tire", quantity: 2, dotNumbers: ["001", "001"] }] }] });
test("pilot retains repeated DOT evidence and excludes PII; exact October UTC range", () => {
  const data = pilotEvidence(invoice(), 10);
  assert.deepEqual(data.jobs[0].parts[0].dotNumbers, ["001", "001"]);
  assert.equal(data.customer, undefined);
  assert.equal(data.customerConcerns, undefined);
  assert.equal(data.jobs[0].note, undefined);
  assert.equal(pilotInRange({ postedDate: "2026-10-01T00:00:00Z" }), true);
  assert.equal(pilotInRange({ postedDate: "2026-11-01T00:00:00Z" }), false);
  const previousTZ = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  assert.equal(pilotInRange({ postedDate: "2026-10-31T23:59:59" }), true);
  if (previousTZ === undefined) delete process.env.TZ; else process.env.TZ = previousTZ;
  assert.throws(() => pilotEvidence(invoice(), 11));
  assert.equal(pilotEvidence({ ...invoice(), jobs: undefined }, 10).jobs, undefined);
});

test("real Mongo: all invoices, two-pass verification, leases, retries, publication recovery, and throttling", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tire-pilot-"));
  const server = spawn("mongod", ["--dbpath", directory, "--bind_ip", "127.0.0.1", "--port", "27933", "--quiet"],
    { env: { PATH: process.env.PATH, HOME: directory, NODE_ENV: "test" }, stdio: "ignore" });
  const client = new MongoClient("mongodb://127.0.0.1:27933/pilot", { serverSelectionTimeoutMS: 300 });
  try {
    for (let i = 0; ; i++) {
      try { await client.connect(); break; } catch (e) {
        if (i > 25) throw e;
        await new Promise(r => setTimeout(r, 200));
      }
    }
    const db = client.db();
    await db.collection("tire_dot_pilot_evidence").createIndex({ generation: 1, shopId: 1, key: 1 },
      { unique: true, name: "pilot_generation_shop_key" });
    let now = new Date("2026-10-31T07:00:00Z"), calls = 0;
    const locations = [{ shopId: 1, providerShopId: 10, timezone: "America/Chicago" }];
    const control = db.collection<any>("tire_dot_pilot_control");
    const builds = db.collection<any>("tire_dot_pilot_generations");
    const evidence = db.collection<any>("tire_dot_pilot_evidence");
    const reset = async () => {
      await Promise.all([control.deleteMany({}), builds.deleteMany({}), evidence.deleteMany({})]);
      await control.insertOne({ _id: PILOT_CONTROL, enabled: true, enterpriseId: "e", nextAt: now });
      calls = 0;
    };
    const deps = {
      now: () => now, locations: async () => locations,
      page: async (_l: any, page: number, before: () => Promise<void>) => {
        await before(); calls++;
        // Include a non-tire invoice: no candidate filtering in discovery.
        return { content: [invoice(), { ...invoice(2), jobs: [] }],
          number: page, size: 50, totalElements: 2, totalPages: 1 };
      },
    };
    const advance = () => { now = new Date(now.getTime() + 11_000); };
    await reset();
    const first = await Promise.all([tickTirePilot(db, deps), tickTirePilot(db, deps)]);
    assert.equal(calls, 1); assert.ok(first.some(r => r.status === "idle"));
    assert.equal((await control.findOne({ _id: PILOT_CONTROL }))?.published, undefined);
    advance(); assert.equal((await tickTirePilot(db, deps)).status, "ready");
    let c = await control.findOne({ _id: PILOT_CONTROL });
    const published = await builds.findOne({ _id: c!.published });
    assert.equal(published?.locations[0].invoices, 2);
    assert.equal(published?.finalMonth, false);
    assert.equal(await evidence.countDocuments({ generation: c!.published, verified: true }), 2);
    // Simulate loss of the pointer-publication acknowledgement.
    await control.updateOne({ _id: PILOT_CONTROL }, { $set: { build: c!.published, nextAt: now },
      $unset: { published: "" } });
    assert.equal((await tickTirePilot(db, deps)).status, "ready"); assert.equal(calls, 2);
    await reset(); await tickTirePilot(db, deps); advance();
    const changed = { ...deps, page: async (l: any, p: number, before: () => Promise<void>) => {
      const data = await deps.page(l, p, before); data.content[0].milesIn = 999; return data;
    } };
    await tickTirePilot(db, changed);
    c = await control.findOne({ _id: PILOT_CONTROL });
    assert.equal(c?.failure, "provider_evidence_changed"); assert.equal(c?.published, undefined);
    await reset();
    const throttled = { ...deps, page: async (_l: any, _p: number, before: () => Promise<void>) => {
      await before(); calls++; throw Object.assign(Error("throttled"), { status: 429 });
    } };
    await tickTirePilot(db, throttled); await tickTirePilot(db, throttled);
    assert.equal(calls, 1);
    assert.equal((await control.findOne({ _id: PILOT_CONTROL }))?.failure, "provider_throttled");
    await reset(); now = new Date("2026-10-31T18:00:00Z");
    await tickTirePilot(db, deps); assert.equal(calls, 0);
    await reset();
    const manualBudget = createTirePilotManualBudget(["--daytime-once"], () => now)!;
    assert.equal((await tickTirePilot(db, { ...deps, manualBudget })).status, "refreshing");
    assert.equal(calls, 1);
    assert.equal(manualBudget.requests, 1);
    advance();
    assert.equal((await tickTirePilot(db, { ...deps, manualBudget })).status, "ready");
    assert.equal(manualBudget.requests, 2);
    // The physical request guard rechecks expiry after a limiter wait.
    await reset();
    const expiringBudget = createTirePilotManualBudget(["--daytime-once"], () => now)!;
    const delayed = { ...deps, manualBudget: expiringBudget,
      page: async (l: any, p: number, before: () => Promise<void>) => {
        now = new Date(now.getTime() + 15 * 60_000);
        return deps.page(l, p, before);
      } };
    assert.equal((await tickTirePilot(db, delayed)).status, "deferred");
    assert.equal(calls, 0);
    assert.equal(expiringBudget.requests, 0);
    // Final-checkpoint crash recovery needs no additional provider request.
    now = new Date("2026-11-01T07:00:00Z"); await reset(); await tickTirePilot(db, deps);
    c = await control.findOne({ _id: PILOT_CONTROL });
    await evidence.updateMany({ generation: c!.build }, { $set: { verified: true } });
    await builds.updateOne({ _id: c!.build }, { $set: { pass: 1, shopIndex: 1, page: 0 } });
    advance(); await tickTirePilot(db, deps);
    assert.equal(calls, 1);
    assert.equal((await builds.findOne({ state: "published" }))?.finalMonth, true);
  } finally {
    await client.close(); server.kill("SIGTERM");
    await new Promise(resolve => server.once("exit", resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
