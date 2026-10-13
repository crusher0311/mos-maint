import "./helpers/deny-network-egress";
import assert from "node:assert/strict";
import { createMongoExpressionCollection } from "./helpers/mongo-expression-collection";
import { __protractorPhysicalTransportTestHooks as hooks, confirmProtractorPhysicalTransportLease as confirm } from "../lib/data/repositories/api-usage";
import { AFTON_PILOT as P } from "../lib/protractor-afton-pilot-policy";
import { historyEndpoint, validateHistoryGrant, matchesHistoryRequest, type ShopHistoryGrant } from "../lib/protractor-shop-history-policy";
import { runWithShopHistory, historyBindingDigest, historyContextError, getShopHistoryContext } from "../lib/integrations/protractor/shop-history-context";
import { pilotInvoiceIds, classifyPilotIds } from "../lib/protractor-afton-pilot-report";

const now = new Date("2026-10-13T23:31:00.000Z");
const grant: ShopHistoryGrant = {
  version: 2, runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", shopId: 139,
  canaryGeneration: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  bindingDigest: historyBindingDigest(139, "test-connection"),
  from: P.day, until: P.until, notBefore: new Date(P.start), expiresAt: new Date(P.end),
  maxRequests: 100, consumedRequests: 99, stopped: false,
};
const request = { runId: grant.runId, shopId: 139, day: P.day, pilot: "afton" as const };
function fixture() {
  return createMongoExpressionCollection({
    _id: "protractor-physical-transport-v1", ownerToken: "lease", leaseExpiresAt: new Date(+now + 90_000),
    operatorStop: { active: false }, ownerCanaryGeneration: grant.canaryGeneration,
    aftonPilot: { ...grant },
    shopHistory: { stopped: true, consumedRequests: 427 },
    jwtOvernight: { stopped: true, consumedRequests: 419 },
    canary: { generation: grant.canaryGeneration, mode: "live", scope: "callbacks_and_interactive",
      requiresCallback: false, requiresRelay: true, workersSuspendedConfirmed: true,
      startedAt: new Date("2026-09-15T11:52:46Z"), maxAdmissions: null, remainingAdmissions: null,
      consumedAdmissions: 0, audit: [], auditTruncatedAdmissions: 0 },
  }, { now: () => now });
}
async function main() {
  validateHistoryGrant(grant);
  const local = new Intl.DateTimeFormat("en-GB", { timeZone: P.timezone, hourCycle: "h23",
    weekday: "short", hour: "2-digit", minute: "2-digit" });
  assert.equal(local.format(new Date(P.start)), "Tue 18:30");
  assert.equal(local.format(new Date(P.end)), "Tue 18:45");
  const endpoint = historyEndpoint(request, 0);
  assert.equal(endpoint, "/Invoice/?startDate=2026-10-12&endDate=2026-10-13&take=100&skip=0");
  for (const patch of [{ shopId: 538 }, { day: "2026-10-11" }, { pilot: undefined }])
    assert.throws(() => historyEndpoint({ ...request, ...patch }, 0));
  assert.throws(() => historyEndpoint(request, 100));
  for (const patch of [{ version: 1 }, { shopId: 538 }, { maxRequests: 101 },
    { maxRequests: 1.5 }, { consumedRequests: -1 }, { expiresAt: new Date(+now + 86_400_000) }])
    assert.throws(() => validateHistoryGrant({ ...grant, ...patch } as ShopHistoryGrant));
  assert.ok(matchesHistoryRequest(request, endpoint, "GET", 139));
  assert.ok(!matchesHistoryRequest(request, endpoint, "POST", 139));
  assert.ok(!matchesHistoryRequest(request, endpoint, "GET", 538));
  assert.ok(!matchesHistoryRequest(request, endpoint, "GET", 139, {}));
  assert.ok(!matchesHistoryRequest(request, endpoint + "&includeDetails=true", "GET", 139));
  const old = hooks.getDb, oldNow = Date.now;
  let col = fixture();
  hooks.getDb = async () => ({ collection: () => col }) as any;
  const context = { historyRequest: request, historyBindingDigest: grant.bindingDigest,
    requireTimedTrial: true, transport: "relay" as const, environment: "production" as const };
  try {
    assert.deepEqual(await Promise.all([confirm("lease", context), confirm("lease", context)]), [true, false]);
    assert.equal(col.row.aftonPilot.consumedRequests, 100);
    assert.equal(col.row.shopHistory.consumedRequests, 427);
    assert.equal(col.row.jwtOvernight.consumedRequests, 419);
    col.row.ownerToken = "next";
    assert.equal(await confirm("next", context), false);
    assert.equal(await confirm("next", { transport: "relay", environment: "production", callbackReceivedAt: now }), true,
      "Exhausted pilot must not stop organic callbacks");
    for (const patch of [{ stopped: true }, { canaryGeneration: "old" },
      { bindingDigest: "c".repeat(64) }, { maxRequests: 101 }, { maxRequests: 99.5 },
      { consumedRequests: 100 }, { expiresAt: new Date("2026-10-13T23:30:00Z") },
      { notBefore: new Date("2026-10-14T23:30:00Z") }, { from: "2026-10-11" }, { version: 1 }]) {
      col = fixture(); Object.assign(col.row.aftonPilot, patch);
      assert.equal(await confirm("lease", context), false, JSON.stringify(patch));
      assert.equal(col.row.aftonPilot.consumedRequests, patch.consumedRequests ?? 99);
    }
    for (const patch of [{ transport: "direct" }, { environment: "development" },
      { interactiveShopId: 139 }, { callbackReceivedAt: now },
      { historyBindingDigest: "wrong" }, { historyRequest: { ...request, shopId: 538 } }]) {
      col = fixture(); assert.equal(await confirm("lease", { ...context, ...patch } as any), false);
    }
    col = fixture(); col.row.operatorStop.active = true;
    assert.equal(await confirm("lease", context), false);
    col = fixture(); col.row.canary.workersSuspendedConfirmed = false;
    assert.equal(await confirm("lease", context), false);
    // Lost admission acknowledgment never refunds an already consumed attempt.
    col = fixture();
    const write = col.findOneAndUpdate.bind(col);
    col.findOneAndUpdate = async (...args: any[]) => { await (write as any)(...args); throw Error("lost ack"); };
    await assert.rejects(confirm("lease", context));
    assert.equal(col.row.aftonPilot.consumedRequests, 100);
    Date.now = () => +now;
    let captured: ReturnType<typeof getShopHistoryContext>;
    await runWithShopHistory(grant, request, async () => {
      captured = getShopHistoryContext();
      assert.equal(historyContextError(139, "test-connection"), null);
      assert.ok(historyContextError(538, "test-connection"));
      assert.ok(historyContextError(139, "changed"));
    });
    assert.equal(captured!.active, false);
    await assert.rejects(runWithShopHistory({ ...grant, stopped: true }, request, async () => {}));
    Date.now = () => Date.parse(P.end);
    await assert.rejects(runWithShopHistory(grant, request, async () => {}));
  } finally { hooks.getDb = old; Date.now = oldNow; }
  const id = "11111111-1111-4111-8111-111111111111";
  assert.deepEqual(pilotInvoiceIds({ ItemCollection: [{ ID: id }] }), [id]);
  assert.throws(() => pilotInvoiceIds({ ItemCollection: [{ ID: "not-a-guid" }] }));
  assert.throws(() => pilotInvoiceIds([{ ID: id }, { ID: id }]));
  assert.throws(() => pilotInvoiceIds({ error: "bad response" }));
  assert.equal(classifyPilotIds([id], [])[0].result, "missing_candidate");
  assert.equal(classifyPilotIds([id], [{ source_id: id, id: "one" }])[0].result, "present");
  assert.equal(classifyPilotIds([id], [{ source_id: id, id: "one" }, { source_id: id, id: "two" }])[0].result, "ambiguous");
  console.log("Afton pilot: exact dated scope, atomic cap, stop/expiry, binding, isolation and comparison checks passed");
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
