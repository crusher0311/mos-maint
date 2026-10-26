import test from "node:test";
import assert from "node:assert/strict";
import { apiFixture } from "./helpers/platform-shops-fixture";
import { paginateShops, summaryShopIds } from "../lib/platform-shops-pagination";
import { ShopReadLimiter, ShopSummaryCache } from "../lib/platform-shops-read";

test("1000-shop page performs no expensive summaries; pagination and bulk scope are fleet-wide", async () => {
  const { f, get } = await apiFixture();
  const first = await (await get("page")).json();
  assert.equal(first.shops.length, 50);
  assert.equal(first.pagination.total, 1000);
  assert.equal(first.bulkEligibleShops.length, 1000);
  assert.equal(first.bulkApprovePendingShops.length, 334);
  assert.deepEqual(f.calls.map(c => c.name), ["enterprise_accounts"]);
  const second = await (await get("page", undefined, "page=2")).json();
  assert.equal(second.shops[0].shopId, 51);
  const found = await (await get("page", undefined, "search=Fixture%20Shop%20999")).json();
  assert.equal(found.shops.length, 1);
  assert.equal(found.shops[0].shopId, 999);
  assert.equal((await get("legacy")).status, 400);
});

test("summary scopes are strictly capped and history remains on demand", async () => {
  assert.equal(summaryShopIds(new URLSearchParams()), null);
  assert.equal(summaryShopIds(new URLSearchParams({shopIds: Array.from({length:51},(_,i)=>String(i)).join(",")})), null);
  assert.equal(summaryShopIds(new URLSearchParams({shopIds:"$ne"})), null);
  const { f, get } = await apiFixture();
  const body = await (await get("summary")).json();
  assert.equal(body.shops.length, 2);
  for (const call of f.calls.filter(c => !["enterprise_accounts"].includes(c.name))) {
    assert.ok((call.pipeline[0]?.$match?.shopId?.$in || []).length <= 4);
  }
});

test("concurrency and queue are bounded across requests", async () => {
  const limiter = new ShopReadLimiter(2, 1);
  let release!: () => void, active = 0, peak = 0;
  const gate = new Promise<void>(r => {release = r;});
  const load = () => limiter.run(async () => {active++; peak=Math.max(peak,active); await gate; active--;});
  const a=load(), b=load(), c=load();
  await assert.rejects(load(), /busy/);
  release(); await Promise.all([a,b,c]);
  assert.equal(peak,2);
});

test("failed refresh reuses bounded stale statistics and cools down failures", async () => {
  let now=0,calls=0;
  const cache=new ShopSummaryCache(30,2,()=>now);
  await cache.read("a",async()=>[5],true);
  now=31;
  const fail=async()=>{calls++;throw Error("busy");};
  assert.deepEqual(await cache.read("a",fail,true),[5]);
  assert.deepEqual(await cache.read("a",fail,true),[5]);
  assert.equal(calls,1);
  now=400_000;
  await assert.rejects(cache.read("a",fail,true));
  await assert.rejects(cache.read("a",fail,true));
  assert.equal(calls,2);
});

test("search, trial, review, KPI and activity filters precede paging and preserve bulk scope", () => {
  const rows=Array.from({length:120},(_,i)=>({shopId:i+1,name:`Shop ${i}`,enterpriseName:"Fleet",
    billing:{status:"trial",plan:"starter"},trial:{endsAt:"2030-01-01",daysLeft:2},
    reviewStatus:"pending",createdAt:"2026-01-01",cardOnFile:false,
    stickerActivity:{inactive:true,state:"known",sortAt:"2026-01-01"}}));
  const result=paginateShops(rows,new URLSearchParams("search=fleet&trialFilter=ending_3&reviewFilter=needs_review&kpiFilter=activeOrTrial&stickerOutreachOnly=true&page=2"));
  assert.equal(result.shops.length,50);
  assert.equal(result.pagination.total,120);
  assert.equal(result.bulkEligibleShops.length,120);
  assert.equal(result.bulkApprovePendingShops.length,120);
});
