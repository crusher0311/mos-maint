import "./helpers/deny-network-egress";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";

const Module = require("module");
const originalLoad = Module._load;
let session: any = { shopId: "42" };
let restricted = true;
let checks = 0;
let configReads = 0;
const forbidden = () => { throw new Error("Restricted sync reached bulk work"); };
const mocks: Record<string, any> = {
  "@/lib/auth": { getSession: async () => session },
  "@/lib/mongo": { getDb: forbidden },
  "@/lib/data/repositories/protractor-backfill-progress": { findByShop: forbidden },
  "@/lib/data/repositories/protractor-deferred-work": {},
  "@/lib/integrations/protractor": {
    resolveProtractorConfig: async (shopId: number) => {
      assert.equal(shopId, 42);
      configReads++;
      return { configured: false };
    },
    fetchActiveWorkOrders: forbidden,
  },
  "@/lib/job-index": {},
  "@/lib/integrations/protractor/sync": { runProtractorBackfill: forbidden },
  "@/lib/integrations/protractor/onboarding": {
    assertBackgroundSyncAllowed: async () => {
      checks++;
      if (restricted) throw new Error("offline policy unavailable or restricted");
    },
  },
};
Module._load = function(id: string, ...args: any[]) {
  if (id in mocks) return mocks[id];
  return originalLoad.call(this, id, ...args);
};
const route = require("../app/api/protractor/sync/route");
Module._load = originalLoad;
const request = () => new NextRequest("http://offline.invalid/api/protractor/sync", { method: "POST" });

async function main() {
  session = null;
  assert.equal((await route.POST(request())).status, 401);
  assert.equal(checks, 0);
  session = { shopId: "invalid" };
  assert.equal((await route.POST(request())).status, 403);
  assert.equal(checks, 0);
  session = { shopId: "42" };
  const response = await route.POST(request());
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, "PROTRACTOR_HISTORY_SYNC_RESTRICTED");
  assert.match(body.error, /connection is unchanged/);
  assert.equal(checks, 1);
  assert.equal(configReads, 0, "restriction precedes config, writes, and backfill");
  restricted = false;
  assert.equal((await route.POST(request())).status, 400, "unconfigured shop remains rejected");
  assert.equal(configReads, 1);

  const source = readFileSync("app/dashboard/settings/integrations/page.tsx", "utf8");
  // Bound by handlers rather than the following component: these checks cover
  // the actual Protractor Connect implementation, not a neighboring provider.
  const start = source.indexOf("function ProtractorSection(");
  const save = source.slice(source.indexOf("async function handleSave()", start), source.indexOf("async function handleSync()", start));
  assert.doesNotMatch(save, /\/api\/protractor\/sync|setTimeout/);
  assert.match(save, /Historical imports require separate approval/);
  assert.match(source.slice(start, source.indexOf("async function handleSave()", start)), /"pending"/);
  console.log("Protractor manual sync admission and Connect UI regression checks passed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
