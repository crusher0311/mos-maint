import test from "node:test";
import assert from "node:assert/strict";
import { ShopSummaryCache, shopIdVariants } from "../lib/platform-shops-read";
import { apiFixture } from "./helpers/platform-shops-fixture";

test("cache coalesces, expires, bounds storage, and never caches failure", async () => {
  let now = 0, calls = 0;
  const cache = new ShopSummaryCache(30, 2, () => now);
  const load = async () => { calls++; return [calls]; };
  assert.deepEqual(await Promise.all([cache.read("a", load), cache.read("a", load)]), [[1], [1]]);
  now = 29; await cache.read("a", load); assert.equal(calls, 1);
  now = 31; await cache.read("a", load); assert.equal(calls, 2);
  await cache.read("b", load); await cache.read("c", load);
  await cache.read("a", load); assert.equal(calls, 5);
  await assert.rejects(cache.read("bad", async () => { throw Error(); }));
  assert.deepEqual(await cache.read("bad", load), [6]);
  assert.deepEqual(shopIdVariants([1, "1", "legacy"]), ["1", 1, "legacy"]);
});

test("API authorizes every mode before datastore access", async () => {
  const { f, get } = await apiFixture();
  for (const view of ["core", "summary", "history", "legacy"]) {
    f.signedIn = false; assert.equal((await get(view, "1")).status, 401);
    f.signedIn = true; f.admin = false; assert.equal((await get(view, "1")).status, 403);
  }
  assert.equal(f.calls.length, 0);
});

test("core preserves fleet decisions and identity while optional reads are slow or failed", async () => {
  const { f, get } = await apiFixture();
  f.delay = 100; f.fail = "vehicles";
  const core = await (await get("core")).json();
  assert.equal(core.shops.length, 1000);
  assert.equal(core.shops[0].enterpriseName, "Fixture Enterprise");
  assert.equal(core.shops[0].reviewStatus, "pending");
  assert.equal(core.shops[0].billing.status, "active");
  assert.equal(core.shops[0].vehicleCount, null);
  assert.deepEqual(f.calls.map(c => c.name), ["enterprise_accounts"]);
  const summary = await (await get("summary")).json();
  assert.equal(summary.shops[0].vehicleCount, null);
  assert.equal(summary.shops[0].userCount, 5);
  assert.equal(summary.shops[0].backfill.totalJobsIndexed, 50);
  assert.ok(summary.shops[0].unavailable.includes("vehicles"));
  assert.equal(f.calls.some(c => c.name === "audit_logs"), false);
  const vin = f.calls.find(c => c.name === "vins")!;
  assert.equal(vin.pipeline[0].$match.shopId.$in.length, 1000);
  f.pg = true;
  f.shops[0] = { ...f.shops[0], _id: undefined } as any;
  const pg = await (await get("core")).json();
  assert.equal(pg.shops[0]._id, "1");
  assert.equal(pg.shops[0].enterpriseName, "PG Enterprise");
});

test("history is demand-only, bounded and merges legacy reminders without duplicates", async () => {
  const { f, get } = await apiFixture();
  assert.equal((await get("history")).status, 400);
  const body = await (await get("history", "1")).json();
  assert.equal(body.shops.length, 1);
  assert.equal(body.shops[0].cardCaptureEmailHistory.length, 10);
  assert.equal(body.shops[0].cardCaptureEmailHistory.filter((e: any) => e.daysLeft === 7 && e.sentAt === "2026-01-01T00:00:00.000Z").length, 1);
  assert.equal(f.maxAccumulated, 10);
  const audit = f.calls.find(c => c.name === "audit_logs")!;
  assert.deepEqual(audit.pipeline[0].$match.shopId.$in, ["1", 1]);
  assert.equal(audit.options.maxTimeMS, 5000);
});

test("fallback failure is unavailable, real counters win, repeat summaries reuse counts", async () => {
  const { f, get } = await apiFixture();
  f.fail = "job_index";
  let body = await (await get("summary")).json();
  assert.equal(body.shops[0].backfill.totalJobsIndexed, null);
  f.fail = "";
  body = await (await get("summary")).json();
  assert.equal(body.shops[0].backfill.totalJobsIndexed, 50);
  f.counter = 100;
  body = await (await get("summary")).json();
  assert.equal(body.shops[0].backfill.totalJobsIndexed, 100);
  assert.equal(f.calls.filter(c => c.name === "vehicles").length, 1);
  assert.equal(f.calls.filter(c => c.name === "job_index").length, 2);
});

test("measured isolated baseline versus split list and repeat-load, 1000 shops / 100k audit events", async () => {
  const baseline = await apiFixture({ baseline: true });
  const split = await apiFixture();
  baseline.f.delay = split.f.delay = 120;
  const measure = async (fn: () => Promise<Response>) => {
    const start = performance.now(); await (await fn()).json(); return Math.round(performance.now() - start);
  };
  const before = await measure(() => baseline.get());
  const core = await measure(() => split.get("core"));
  const summary = await measure(() => split.get("summary"));
  const repeat = await measure(() => split.get("summary"));
  console.log("ISOLATED_TIMINGS", { before, core, summary, repeat });
  assert.ok(before >= 200);
  assert.ok(core < 100, `core took ${core}ms`);
  assert.ok(repeat < summary);
});
