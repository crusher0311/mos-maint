import test from "node:test";
import assert from "node:assert/strict";
import { tireDotDeps as d, requestTireRun, readableTireRun, processNextTireRun, processTireRunBatch, tireRunResponse } from "../lib/tire-dot-report-service";
import { reportingScopeDependencies as scopeDeps } from "../lib/reporting-scope";
import { rawInvoice } from "./tire-dot-report.test";
import type { TireDotRun } from "../lib/data/repositories/tire-dot-report-runs";
d.findTirePilot = async () => null;

test("new local runs pin authoritative zones, reject missing zones, and preserve legacy UTC requests", async () => {
  const old = { ...d };
  const flag = process.env.REPORTING_TIRE_DOT_ENABLED;
  try {
    process.env.REPORTING_TIRE_DOT_ENABLED = "true";
    let zone: string | undefined = "America/Chicago";
    d.resolveReportingScope = async () => ({ kind: "shop", shopIds: [1], shops: [{ shopId: 1, name: "Fixture" }] }) as any;
    d.listShopsByShopIds = async (_ids, projection) => {
      assert.equal(projection?.["tekmetric.shopId"], 1);
      assert.equal(projection?.timezone, 1);
      return [{ shopId: 1, tekmetric: { shopId: 10 }, timezone: zone }] as any;
    };
    d.findTirePilot = async () => null;
    d.createTireRun = async input => input as any;
    const input = { dateRange: { start: "2026-10-01", end: "2026-10-31" }, locationIds: [1],
      scope: { kind: "shop", shopId: 1 }, timeZones: { 1: "Asia/Tokyo" } };
    const session = { email: "fixture@example.test" };
    const local = await requestTireRun(session, { ...input, dateBasis: "shop-local" });
    assert.deepEqual(local.definition.timeZones, { 1: "America/Chicago" });
    assert.deepEqual(local.partial.timeZones, local.definition.timeZones);
    const legacy = await requestTireRun(session, input);
    assert.equal(legacy.definition.timeZones, undefined);
    zone = undefined;
    await assert.rejects(requestTireRun(session, { ...input, dateBasis: "shop-local" }), /valid timezone/);
  } finally {
    Object.assign(d, old);
    if (flag === undefined) delete process.env.REPORTING_TIRE_DOT_ENABLED;
    else process.env.REPORTING_TIRE_DOT_ENABLED = flag;
  }
});

test("report batches preserve pilot scope, sequential checkpoints, budgets, and cancellation", async () => {
  const original = { ...d };
  const flag = process.env.REPORTING_TIRE_DOT_ENABLED;
  try {
    process.env.REPORTING_TIRE_DOT_ENABLED = "true";
    let claims = 0, saves = 0, checks = 0, reads = 0, failures = 0, time = 0;
    let stop = false, idle = false, revoked = false, advance = 0;
    d.resolveReportingScope = async () => ({ kind: "enterprise", enterpriseId: "pilot",
      shopIds: [1], shops: [{ shopId: 1, name: "Fixture" }] }) as any;
    d.listShopsByShopIds = async () => [{ shopId: 1, tekmetric: { shopId: 10 } }] as any;
    const pilot: any = { generation: "pinned", enterpriseId: "pilot",
      start: "2026-10-01", end: "2026-10-31", locations: [{ shopId: 1, providerShopId: 10 }],
      warnings: [] };
    d.findTirePilot = async () => pilot;
    d.validateTirePilot = async () => { checks++; if (revoked) throw Error("revoked"); };
    d.createTireRun = async input => ({ ...input, _id: "fixture", shopIndex: 0, cursor: null }) as any;
    const run = await requestTireRun({ email: "fixture@example.test" }, {
      scope: { kind: "enterprise", enterpriseId: "pilot" }, locationIds: [1],
      dateRange: { start: "2026-10-01", end: "2026-10-31" },
    });
    checks = 0;
    d.claimTireRun = async pilotOnly => {
      assert.equal(pilotOnly, true, "dedicated worker must not claim generic reports");
      assert.equal(claims, saves + failures, "previous page must finish before another claim");
      if (idle) return null;
      claims++; return run;
    };
    d.findReportingRecipient = async () => ({ email: run.requestedBy }) as any;
    d.readTireSourcePage = async () => { throw Error("raw source forbidden"); };
    d.readTirePilotPage = async selection => {
      assert.equal(selection.generation, "pinned");
      reads++;
      return Array.from({ length: 25 }, (_, i) => ({ key: `${reads}-${i}`, doc: {} }));
    };
    d.saveTireRun = async () => { saves++; time += advance; return {} as any; };
    d.failTireRun = async () => { failures++; };
    const options = { pilotOnly: true, now: () => time, shouldStop: () => stop };
    assert.equal((await processTireRunBatch(options)).length, 10);
    assert.equal(saves, 10); assert.equal(checks, 10); assert.equal(reads, 10);
    advance = 8000;
    assert.equal((await processTireRunBatch(options)).length, 2, "stop starting pages at 15s");
    stop = true;
    assert.equal((await processTireRunBatch(options)).length, 0);
    stop = false; idle = true;
    assert.equal((await processTireRunBatch(options)).length, 1, "empty queue exits immediately");
    idle = false; revoked = true;
    const before = reads;
    const failed = await processTireRunBatch(options);
    assert.equal(failed.length, 1); assert.equal(failed[0].status, "failed");
    assert.equal(reads, before, "revocation blocks the next read");
    assert.equal(failures, 1);
  } finally {
    Object.assign(d, original);
    if (flag === undefined) delete process.env.REPORTING_TIRE_DOT_ENABLED;
    else process.env.REPORTING_TIRE_DOT_ENABLED = flag;
  }
});

test("pilot generations bypass raw scans but keep scope checks and pinned evidence", async () => {
  const original = { ...d }, flag = process.env.REPORTING_TIRE_DOT_ENABLED;
  try {
    delete process.env.REPORTING_TIRE_DOT_ENABLED;
    d.resolveReportingScope = async () => ({ kind: "enterprise", enterpriseId: "pilot",
      shopIds: [1], shops: [{ shopId: 1, name: "Fixture" }] }) as any;
    d.listShopsByShopIds = async () => [{ shopId: 1, tekmetric: { shopId: 10 } }] as any;
    const pilot: any = { generation: "generation-a", enterpriseId: "pilot",
      start: "2026-10-01", end: "2026-10-31", startedAt: "2026-10-31T06:00:00Z",
      finishedAt: "2026-10-31T07:00:00Z", finalMonth: false,
      locations: [{ shopId: 1, providerShopId: 10, invoices: 1 }], warnings: [] };
    d.findTirePilot = async () => pilot;
    let revoked = false, saved: any;
    d.validateTirePilot = async () => { if (revoked) throw Error("scope changed"); };
    d.createTireRun = async input => ({ ...input, _id: "a", status: "queued",
      shopIndex: 0, cursor: null }) as any;
    const run = await requestTireRun({ email: "fixture@example.test" }, {
      scope: { kind: "enterprise", enterpriseId: "pilot" },
      dateRange: { start: "2026-10-01", end: "2026-10-31" }, locationIds: [1],
    });
    assert.equal(run.sourceMode, "pilot"); assert.equal(run.pilot?.generation, "generation-a");
    assert.ok(run.partial.coverage.reasons.some(r => r.includes("MONTH TO DATE")));
    d.claimTireRun = async () => run;
    d.findReportingRecipient = async () => ({ email: run.requestedBy }) as any;
    d.readTireSourcePage = async () => { throw Error("legacy raw scan forbidden"); };
    d.readTirePilotPage = async selection => { assert.equal(selection.generation, "generation-a"); return []; };
    d.saveTireRun = async value => { saved = value; return {} as any; };
    await processNextTireRun(); assert.ok(saved);
    d.findTireRun = async () => run;
    revoked = true;
    await assert.rejects(readableTireRun({ email: run.requestedBy }, "a"), /scope changed/);
  } finally {
    Object.assign(d, original);
    if (flag === undefined) delete process.env.REPORTING_TIRE_DOT_ENABLED; else process.env.REPORTING_TIRE_DOT_ENABLED = flag;
  }
});

test("current enterprise grants protect submission, polling, exports, and resumed worker pages", async () => {
  process.env.REPORTING_TIRE_DOT_ENABLED = "true";
  let grants = [311, 32];
  const shops: any[] = [311, 32, 99].map(shopId => ({ shopId, name: `Fixture ${shopId}`, enterpriseId: shopId === 99 ? "other" : "e", tekmetric: { shopId } }));
  shops[1].tekmetricShopId = 32;
  delete shops[1].tekmetric;
  scopeDeps.getEnterpriseById = async id => ({ _id: id, shopIds: id === "e" ? [311, 32] : [99] }) as any;
  scopeDeps.findShopByShopId = async id => shops.find(s => s.shopId === id);
  scopeDeps.listShopsByShopIds = d.listShopsByShopIds = async ids => shops.filter(s => ids.includes(s.shopId));
  scopeDeps.listReportingUserShopAssignments = async () => [{ shopIds: grants }];
  const user: any = { email: "fixture@example.test", shopId: 311, role: "owner", enterpriseId: "e", active: true };
  let persisted: TireDotRun;
  let reads = 0;
  d.tireSourceMode = () => "mongo";
  d.createTireRun = async input => (persisted = { ...input, _id: "a".repeat(36), status: "queued", stage: "queued", queuedAt: new Date(), heartbeatAt: new Date(), shopIndex: 0, cursor: null });
  d.findTireRun = async () => structuredClone(persisted);
  d.claimTireRun = async () => ({ ...structuredClone(persisted), lease: "lease", status: "running" });
  d.findReportingRecipient = async () => user;
  d.readTireSourcePage = async () => { reads++; return [{ key: "cursor", doc: rawInvoice() }]; };
  d.saveTireRun = async (run, done) => {
    persisted = structuredClone(run);
    if (done) { persisted.status = "succeeded"; persisted.result = persisted.partial; persisted.result.generatedAt = new Date().toISOString(); }
    return {} as any;
  };
  d.failTireRun = async (run, error) => { persisted = { ...run, status: "failed", error }; };
  const input = { scope: { kind: "enterprise", enterpriseId: "e" }, dateRange: { start: "2024-08-14", end: "2024-08-14" }, locationIds: [311, 32] };
  await assert.rejects(requestTireRun(user, { ...input, locationIds: [99] }), /authorized/);
  await assert.rejects(requestTireRun(user, { ...input, dateRange: { start: "bad" } }), /valid/);
  const run = await requestTireRun(user, input);
  await readableTireRun(user, run._id);
  assert.equal(reads, 0, "submission and polling never read source history");
  await assert.rejects(readableTireRun({ ...user, email: "another@test.invalid" }, run._id), /not found/);
  await processNextTireRun();
  assert.equal(reads, 1); assert.equal(persisted!.shopIndex, 1);
  await processNextTireRun();
  assert.equal(persisted!.result?.invoices.length, 2);
  assert.equal(tireRunResponse(persisted!).stale, false);
  persisted!.result!.generatedAt = "2020-01-01T00:00:00Z";
  assert.equal(tireRunResponse(persisted!).stale, true);
  grants = [311];
  await assert.rejects(readableTireRun(user, run._id), /authorized/);
  const before = reads; await processNextTireRun();
  assert.equal(reads, before, "revoked run must not query more history");
  assert.equal(persisted!.status, "failed");
});
