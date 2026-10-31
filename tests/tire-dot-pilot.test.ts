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
import { nullableAuthorizationInvoice } from "./fixtures/tekmetric-null-authorization";

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
    const sourceDeps = { ...deps, page: async (_l: any, page: number, before: () => Promise<void>) => {
      await before(); calls++;
      return { content: [nullableAuthorizationInvoice()], number: page, size: 50,
        totalElements: 1, totalPages: 1 };
    } };
    await reset();
    assert.equal((await tickTirePilot(db, sourceDeps)).status, "refreshing");
    advance();
    assert.equal((await tickTirePilot(db, sourceDeps)).status, "ready");
    const sourceControl = await control.findOne({ _id: PILOT_CONTROL });
    const retained = await evidence.findOne({ generation: sourceControl!.published });
    assert.equal(retained!.verified, true);
    assert.equal(retained!.data.jobs[1].authorized, null);
    assert.equal(retained!.data.jobs[2].authorized, null);
    assert.equal(sourceControl!.invoiceCount, 1);
    // Nullable authorization does not permit missing/malformed payload fields.
    for (const bad of ["missing_authorized", "string_authorized", "missing_parts", "missing_jobs", "invalid_date"]) {
      await reset();
      const invalid = { ...sourceDeps, page: async (l: any, p: number, before: () => Promise<void>) => {
        const page = await sourceDeps.page(l, p, before);
        const row: any = page.content[0];
        if (bad === "missing_authorized") delete row.jobs[0].authorized;
        if (bad === "string_authorized") row.jobs[0].authorized = "true";
        if (bad === "missing_parts") delete row.jobs[0].parts;
        if (bad === "missing_jobs") delete row.jobs;
        if (bad === "invalid_date") row.postedDate = "invalid";
        return page;
      } };
      assert.equal((await tickTirePilot(db, invalid)).status, "deferred");
      const rejected = await control.findOne({ _id: PILOT_CONTROL });
      assert.equal(rejected!.failure, "incomplete_invoice_payload");
      assert.equal(rejected!.published, undefined);
    }
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
    const mismatchBuild = await builds.findOne({ state: "failed", failure: "provider_evidence_changed" });
    assert.deepEqual(mismatchBuild?.mismatch.changedPaths, ["invoice.milesIn"]);
    assert.equal(mismatchBuild?.mismatch.shopId, 1);
    assert.equal(mismatchBuild?.mismatch.invoiceId, 1);
    assert.equal(mismatchBuild?.mismatch.contentChanged, true);
    assert.equal(mismatchBuild?.mismatch.pageChanged, false);
    assert.ok(!JSON.stringify(mismatchBuild?.mismatch).includes("private"));
    // Diagnostics are optional: a storage failure must not turn a mismatch
    // into a retryable generic error, publication, or checkpoint advancement.
    await reset(); await tickTirePilot(db, deps); advance();
    const unavailableDiagnosticsDb = { collection(name: string) {
      const collection = db.collection(name);
      if (name !== "tire_dot_pilot_generations") return collection;
      return new Proxy(collection, { get(target, property) {
        if (property === "updateOne") return (filter: any, update: any, options: any) => {
          if (update.$set?.mismatch) throw Error("private diagnostic storage failure");
          return target.updateOne(filter, update, options);
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    } };
    await tickTirePilot(unavailableDiagnosticsDb as any, changed);
    c = await control.findOne({ _id: PILOT_CONTROL });
    assert.equal(c?.failure, "provider_evidence_changed");
    assert.equal(c?.published, undefined);
    assert.equal(c?.build, null);
    assert.equal((await builds.findOne({ state: "failed" }))?.mismatch, undefined);
    await reset();
    const throttled = { ...deps, page: async (_l: any, _p: number, before: () => Promise<void>) => {
      await before(); calls++; throw Object.assign(Error("throttled"), { status: 429 });
    } };
    await tickTirePilot(db, throttled); await tickTirePilot(db, throttled);
    assert.equal(calls, 1);
    assert.equal((await control.findOne({ _id: PILOT_CONTROL }))?.failure, "provider_throttled");
    for (const status of [400, 401, 403, 429, 500, 503]) {
      await reset();
      await tickTirePilot(db, { ...deps, page: async (_l, _p, before) => {
        await before(); calls++;
        throw Object.assign(Error("provider_http_error"), { status, body: "private upstream body" });
      } });
      const failed = await control.findOne({ _id: PILOT_CONTROL });
      assert.equal(failed.failureHttpStatus, status);
      assert.equal(failed.failure, status === 429 ? "provider_throttled" : "provider_http_error");
      assert.equal(failed.nextAt.getTime(), now.getTime() + 60 * 60_000);
      assert(!JSON.stringify(failed).includes("private"));
      await tickTirePilot(db, deps);
      assert.equal(calls, 1, "cooldown prevents another request");
      now = new Date(now.getTime() + 60 * 60_000);
      await tickTirePilot(db, deps);
      assert.equal((await control.findOne({ _id: PILOT_CONTROL }))?.failureHttpStatus, null);
      now = new Date("2026-10-31T07:00:00Z");
    }
    await reset(); now = new Date("2026-10-31T18:00:00Z");
    await tickTirePilot(db, deps); assert.equal(calls, 0);
    await reset();
    const manualBudget = createTirePilotManualBudget(["--daytime-once"], () => now)!;
    const original = await control.findOne({ _id: PILOT_CONTROL });
    for (let i = 0; i < 4; i++) {
      assert.equal((await tickTirePilot(db, deps)).status, "waiting_for_overnight_window");
      assert.deepEqual(await control.findOne({ _id: PILOT_CONTROL }), original,
        "ineligible scheduler neither leases nor reschedules shared work");
    }
    const interleaved = await Promise.all([
      tickTirePilot(db, deps), tickTirePilot(db, { ...deps, manualBudget }),
    ]);
    assert(interleaved.some(r => r.status === "refreshing"));
    assert.equal(calls, 1);
    assert.equal(manualBudget.requests, 1);
    const progress = await control.findOne({ _id: PILOT_CONTROL });
    assert.equal((await tickTirePilot(db, { ...deps, manualBudget })).reason, "next_attempt_not_due");
    assert.equal(calls, 1, "manual run still honors page pacing");
    advance();
    for (let i = 0; i < 4; i++) {
      assert.equal((await tickTirePilot(db, deps)).status, "waiting_for_overnight_window");
      assert.deepEqual(await control.findOne({ _id: PILOT_CONTROL }), progress);
    }
    assert.equal((await tickTirePilot(db, { ...deps, manualBudget })).status, "ready");
    assert.equal(manualBudget.requests, 2);
    // Preflight cannot steal another worker's lease, bypass cooldowns, or
    // spend an expired/exhausted allowance even if no scheduled worker runs.
    for (const gate of ["disabled", "cooldown", "lease", "expired", "exhausted"]) {
      await reset();
      const budget = createTirePilotManualBudget(["--daytime-once"], () => now)!;
      if (gate === "disabled") await control.updateOne({ _id: PILOT_CONTROL }, { $set: { enabled: false } });
      if (gate === "cooldown") await control.updateOne({ _id: PILOT_CONTROL },
        { $set: { nextAt: new Date(now.getTime() + 60_000), failure: "provider_throttled" } });
      if (gate === "lease") await control.updateOne({ _id: PILOT_CONTROL },
        { $set: { lease: "other", leaseUntil: new Date(now.getTime() + 60_000) } });
      if (gate === "expired") now = new Date(now.getTime() + 15 * 60_000);
      if (gate === "exhausted") for (let i = 0; i < 20; i++) budget.admit();
      const before = await control.findOne({ _id: PILOT_CONTROL });
      assert.equal((await tickTirePilot(db, { ...deps, manualBudget: budget })).status, "idle");
      assert.deepEqual(await control.findOne({ _id: PILOT_CONTROL }), before);
      assert.equal(calls, 0);
    }
    await reset();
    const unavailable = { ...deps, locations: async () => { throw Error("private lookup details"); } };
    const beforeUnavailable = await control.findOne({ _id: PILOT_CONTROL });
    assert.equal((await tickTirePilot(db, unavailable)).reason, "eligibility_unavailable");
    assert.deepEqual(await control.findOne({ _id: PILOT_CONTROL }), beforeUnavailable);
    // The preflight read is advisory; the atomic claim must reject changed state.
    now = new Date("2026-10-31T07:00:00Z"); await reset();
    const raced = { ...deps, locations: async () => {
      await control.updateOne({ _id: PILOT_CONTROL }, { $set: { nextAt: new Date(now.getTime() + 60_000) } });
      return locations;
    } };
    assert.equal((await tickTirePilot(db, raced)).reason, "claim_changed");
    assert.equal(calls, 0);
    // A continuation uses the current shop's window, not every shop's window.
    // At 09:00 UTC Chicago is open (04:00), New York is closed (05:00).
    now = new Date("2026-10-31T09:00:00Z"); await reset();
    const mixedLocations = [
      ...locations, { shopId: 2, providerShopId: 11, timezone: "America/New_York" },
    ];
    const mixed = { ...deps, locations: async () => mixedLocations };
    assert.equal((await tickTirePilot(db, mixed)).status, "waiting_for_overnight_window");
    assert.equal(await builds.countDocuments({}), 0, "new builds require all windows open");
    await builds.insertOne({ _id: "mixed", state: "building", scopeHash: pilotHash(mixedLocations),
      locations: mixedLocations, pass: 0, shopIndex: 0, page: 0, requests: 0, totals: {} });
    await control.updateOne({ _id: PILOT_CONTROL }, { $set: { build: "mixed" } });
    assert.equal((await tickTirePilot(db, mixed)).status, "refreshing");
    advance();
    const beforeClosedLocation = await control.findOne({ _id: PILOT_CONTROL });
    assert.equal((await tickTirePilot(db, mixed)).status, "waiting_for_overnight_window");
    assert.deepEqual(await control.findOne({ _id: PILOT_CONTROL }), beforeClosedLocation);
    assert.equal(calls, 1, "closed second location does not make a provider request");
    // Scope changes detected in preflight never modify active manual work.
    const beforeScope = await control.findOne({ _id: PILOT_CONTROL });
    assert.equal((await tickTirePilot(db, deps)).reason, "scope_changed");
    assert.deepEqual(await control.findOne({ _id: PILOT_CONTROL }), beforeScope);
    now = new Date("2026-10-31T18:00:00Z");
    await reset();
    await control.updateOne({ _id: PILOT_CONTROL }, { $set: { failure: "incomplete_invoice_payload" } });
    await tickTirePilot(db, { ...deps, manualBudget: createTirePilotManualBudget(["--daytime-once"], () => now)! });
    assert.equal((await control.findOne({ _id: PILOT_CONTROL }))!.failure, null,
      "successful progress clears stale failure status");
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
    now = new Date("2026-11-01T18:00:00Z"); await tickTirePilot(db, deps);
    assert.equal(calls, 1);
    assert.equal((await builds.findOne({ state: "published" }))?.finalMonth, true);
  } finally {
    await client.close(); server.kill("SIGTERM");
    await new Promise(resolve => server.once("exit", resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
