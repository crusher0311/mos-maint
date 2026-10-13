import "./helpers/deny-network-egress";
import assert from "node:assert/strict";
import { AVID_HISTORY as P } from "../lib/protractor-avid-history-policy";
import { historyEndpoint, matchesHistoryRequest, validateHistoryGrant, type ShopHistoryGrant } from "../lib/protractor-shop-history-policy";
import { historyBindingDigest, runWithShopHistory, historyContextError } from "../lib/integrations/protractor/shop-history-context";
import { createMongoExpressionCollection } from "./helpers/mongo-expression-collection";
import { __protractorPhysicalTransportTestHooks as hooks, confirmProtractorPhysicalTransportLease as confirm } from "../lib/data/repositories/api-usage";
const now = new Date("2026-10-13T22:01:00Z");
const grant: ShopHistoryGrant = {
  version: 3, shopId: 457, from: P.from, until: P.until,
  runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  canaryGeneration: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  bindingDigest: historyBindingDigest(457, "avid-test"),
  notBefore: new Date(P.start), expiresAt: new Date(P.end),
  maxRequests: 2000, consumedRequests: 1999, stopped: false,
};
const request = { runId: grant.runId, shopId: 457, day: "2026-10-13", pilot: "avid" as const };
function fixture() {
  return createMongoExpressionCollection({
    _id: "protractor-physical-transport-v1", ownerToken: "lease", leaseExpiresAt: new Date(+now + 90000),
    operatorStop: { active: false }, ownerCanaryGeneration: grant.canaryGeneration,
    avidHistory: { ...grant }, aftonPilot: { consumedRequests: 12, stopped: true },
    shopHistory: { consumedRequests: 427, stopped: true }, jwtOvernight: { consumedRequests: 419, stopped: true },
    canary: { generation: grant.canaryGeneration, mode: "live", scope: "callbacks_and_interactive",
      requiresCallback: false, requiresRelay: true, workersSuspendedConfirmed: true,
      startedAt: new Date("2026-09-15T11:52:46Z"), maxAdmissions: null, remainingAdmissions: null,
      consumedAdmissions: 0, audit: [], auditTruncatedAdmissions: 0 },
  }, { now: () => now });
}
async function main() {
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone: P.timezone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" });
  assert.equal(clock.format(new Date(P.start)), "18:00");
  assert.equal(clock.format(new Date(P.end)), "06:55");
  assert.equal((Date.parse(P.until) - Date.parse(P.from)) / 86400000, 730);
  validateHistoryGrant(grant);
  for (const patch of [{ version: 1 }, { version: 2 }, { shopId: 139 }, { maxRequests: 2001 },
    { maxRequests: 2.5 }, { from: "2024-10-13" }, { stopped: undefined },
    { expiresAt: new Date("2026-10-15T10:55:00Z") }])
    assert.throws(() => validateHistoryGrant({ ...grant, ...patch } as ShopHistoryGrant));
  assert.ok(historyEndpoint({ ...request, day: P.from }, 0));
  for (const patch of [{ day: "2024-10-13" }, { day: P.until }, { day: "2026-02-30" }, { shopId: 538 }, { pilot: "afton" }])
    assert.throws(() => historyEndpoint({ ...request, ...patch } as any, 0));
  assert.throws(() => historyEndpoint(request, 100));
  const endpoint = historyEndpoint(request, 0);
  assert.ok(matchesHistoryRequest(request, endpoint, "GET", 457));
  for (const [path, method, shop, body] of [[endpoint, "POST", 457], [endpoint, "GET", 139],
    [endpoint, "GET", 457, {}], ["/WorkOrder/abc", "GET", 457], [endpoint + "&extra=1", "GET", 457]] as any[])
    assert.ok(!matchesHistoryRequest(request, path, method, shop, body));
  let col = fixture();
  const old = hooks.getDb, oldNow = Date.now;
  const context = { historyRequest: request, historyBindingDigest: grant.bindingDigest,
    requireTimedTrial: true, transport: "relay" as const, environment: "production" as const };
  hooks.getDb = async () => ({ collection: () => col }) as any;
  Date.now = () => +now;
  try {
    assert.deepEqual(await Promise.all([confirm("lease", context), confirm("lease", context)]), [true, false]);
    assert.equal(col.row.avidHistory.consumedRequests, 2000);
    assert.equal(col.row.aftonPilot.consumedRequests, 12);
    assert.equal(col.row.shopHistory.consumedRequests, 427);
    assert.equal(col.row.jwtOvernight.consumedRequests, 419);
    for (const patch of [{ stopped: true }, { consumedRequests: 2000 }, { maxRequests: "2000" },
      { consumedRequests: -1 }, { canaryGeneration: "changed" }, { bindingDigest: "wrong" },
      { expiresAt: new Date(+now - 1) }, { notBefore: new Date(+now + 1000) }]) {
      col = fixture(); Object.assign(col.row.avidHistory, patch);
      assert.equal(await confirm("lease", context), false);
    }
    for (const patch of [{ transport: "direct" }, { environment: "development" },
      { callbackReceivedAt: now }, { interactiveShopId: 457 }, { historyBindingDigest: "wrong" }]) {
      col = fixture(); assert.equal(await confirm("lease", { ...context, ...patch } as any), false);
    }
    col = fixture(); col.row.operatorStop.active = true;
    assert.equal(await confirm("lease", context), false);
    col = fixture(); col.row.canary.workersSuspendedConfirmed = false;
    assert.equal(await confirm("lease", context), false);
    col = fixture(); const write = col.findOneAndUpdate.bind(col);
    col.findOneAndUpdate = async (...args: any[]) => { await (write as any)(...args); throw Error("ack lost"); };
    await assert.rejects(confirm("lease", context));
    assert.equal(col.row.avidHistory.consumedRequests, 2000);
    await runWithShopHistory(grant, request, async () => {
      assert.equal(historyContextError(457, "avid-test"), null);
      assert.ok(historyContextError(139, "avid-test"));
    });
    await assert.rejects(runWithShopHistory(grant, { ...request, pilot: "afton" }, async () => {}));
    Date.now = () => Date.parse(P.end);
    await assert.rejects(runWithShopHistory(grant, request, async () => {}));
  } finally { hooks.getDb = old; Date.now = oldNow; }
  console.log("Avid: dated 24-month scope, Eastern cutoff, atomic budget, isolation, stop, context and lost-ack checks passed");
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
