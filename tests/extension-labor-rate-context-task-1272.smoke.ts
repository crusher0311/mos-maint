/**
 * Focused regression checks for Task #1272's background Rates context repair.
 *
 * These checks deliberately do not contact MOS or a provider.  The live
 * Service Solutions Garage failure has not been reproduced with production
 * credentials; the regressions below exercise the client-side defects that
 * are deterministic from the extension source and a small VM fixture.
 *
 * Run: `npx tsx tests/extension-labor-rate-context-task-1272.smoke.ts`
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as vm from "node:vm";

const root = join(__dirname, "..");
const background = readFileSync(join(root, "mos-tools-extension", "background.js"), "utf8");

function section(startMarker: string, endMarker: string) {
  const start = background.indexOf(startMarker);
  const end = background.indexOf(endMarker, start);
  assert.ok(start >= 0, `missing background marker: ${startMarker}`);
  assert.ok(end > start, `missing background end marker: ${endMarker}`);
  return background.slice(start, end);
}

console.log("background Rates context contract (Task #1272)");

const laborHandlers = section(
  'if (message.action === "GET_LABOR_RATE_RULES")',
  '// -------------------- Concern Assistant --------------------',
);
const laborHelpers = section(
  "function normalizeLaborRateProvider(provider)",
  "async function fetchLaborRateRules(",
);
const laborFetch = section(
  "async function fetchLaborRateRules(",
  "function matchRuleCondition(",
);
const laborApply = section(
  "async function autoApplyLaborRate(context, options = {})",
  "console.log(\"[MOS Tools] Background service worker loaded\")",
);

// Reproduces the original deterministic defect: the Rates GET/PUT must carry
// the provider hint as well as the SMS identity.  The server cannot reliably
// resolve a numeric identifier without that context.
assert.match(laborHandlers, /captureLaborRateContext\(message\.context/);
assert.match(laborHandlers, /smsShopId: String\(targetSmsShopId\)/);
assert.match(laborFetch, /smsShopId: String\(context\.shopId\)/);
assert.match(laborHandlers, /provider: context\.provider/);
assert.match(laborFetch, /labor-rates\?\$\{query\.toString\(\)\}/);
assert.match(laborHandlers, /labor-rates\?\$\{saveQuery\.toString\(\)\}/);
assert.match(laborHandlers, /body: JSON\.stringify\(\{[\s\S]*provider: context\.provider/);

// A Rates operation may not use the legacy URL-captured global shop
// preference.  It must use the message snapshot / active tab context.
assert.doesNotMatch(laborHandlers, /tekmetricShopId/);
assert.doesNotMatch(laborFetch, /tekmetricShopId/);
assert.doesNotMatch(laborApply, /tekmetricShopId/);
assert.match(background, /context: currentContext/);
assert.match(background, /provider, SMS shop ID, and source tab ID/);
assert.match(laborHandlers, /APPLY_LABOR_RATE_NOW[\s\S]*requireRo: true/);
assert.match(laborHelpers, /assertIncomingLaborRateSession\(source/);

// Fresh reads, revision protection, Basic-session denial, and provider-action
// grants remain in the repaired path.
assert.match(laborHandlers, /fetchLaborRateRules\(true, true, context\.shopId, context\)/);
assert.match(laborHandlers, /expectedRevision/);
assert.match(laborHandlers, /message\.action === "SAVE_LABOR_RATE_RULES"[\s\S]*mosSessionTier\?\.canMutate === false/);
assert.match(laborApply, /fetchLaborRateRules\(true, true, laborContext\.shopId, laborContext\)/);
assert.match(laborApply, /mosSessionTier\?\.canMutate === false/);
assert.match(laborApply, /MosLaborRateCore\.summarizeLaborRateOutcomes/);
assert.match(laborApply, /recordLaborRateOutcome/);
assert.match(laborApply, /Capture exactly once at initiation/);
assert.match(background, /requestProviderActionGrant\(/);
assert.match(background, /providerActionGrant = await requestProviderActionGrant\(/);
assert.match(background, /function laborRateBroadcastMetadata\(context\)/);
assert.match(background, /contextDiscriminator: laborRateContextScopeKey\(context\)/);
assert.match(background, /sessionDiscriminator: laborRateSessionDiscriminator\(context\)/);
assert.match(background, /\.\.\.laborRateBroadcastMetadata\(context\)/);

// Cache and async-response safety are part of the contract, not comments:
// context identity includes provider/shop/RO/tab/session and responses check
// both the request sequence and the current active snapshot.
assert.match(laborHelpers, /normalizeLaborRateProvider\(context\.provider\)/);
assert.match(laborHelpers, /String\(context\.shopId\)/);
assert.match(laborHelpers, /String\(context\.roId\)/);
assert.match(laborHelpers, /String\(context\._tabId\)/);
assert.match(laborHelpers, /capturedLaborRateSessionIdentity\(context\)/);
assert.match(laborFetch, /requestSequence !== laborRateRulesRequestSequence/);
assert.match(laborFetch, /assertCurrentLaborRateContext\(context\)/);
assert.match(laborHandlers, /assertCurrentLaborRateContext\(context\)/);
assert.match(laborApply, /assertCurrentLaborRateContext\(laborContext\)/);

// Execute the context identity and stale-response guard against an isolated
// fixture.  This covers numeric/string shop IDs and session rotation without
// loading Chrome APIs or issuing network requests.
const sandbox: any = {
  activeTabId: 11,
  authEpoch: 4,
  mosApiToken: "mos-session-a",
  currentSmsContext: null,
  smsContextsByTab: new Map(),
  tekmetricProofsByTab: new Map(),
  laborRateProviderSessionGenerationByTab: new Map(),
  laborRateSessionDiscriminatorForTab: (tabId: number) =>
    `4:${String(tabId)}:0`,
  String,
  Boolean,
  Error,
  Set,
  Map,
};
vm.createContext(sandbox);
vm.runInContext(
  `${laborHelpers}
this.__clone = cloneLaborRateContext;
this.__key = laborRateContextKey;
 this.__assert = assertCurrentLaborRateContext;
 this.__capture = captureLaborRateContext;`,
  sandbox,
);

const contextA = {
  provider: "tekmetric",
  shopId: 14245,
  roId: 9001,
  _tabId: 11,
};
const contextAStringId = { ...contextA, shopId: "14245" };
const contextAStringTabId = { ...contextA, _tabId: "11" };
const contextB = {
  provider: "tekmetric",
  shopId: "14246",
  roId: "9001",
  _tabId: 11,
};
const shopLevelContext = {
  provider: "tekmetric",
  shopId: 14245,
  _tabId: 11,
  laborRateSessionDiscriminator: "4:11:0",
};
sandbox.smsContextsByTab.set(11, contextA);
sandbox.tekmetricProofsByTab.set(11, {
  token: "provider-session-a",
  origin: "https://shop.tekmetric.com",
});

const snapshotA = sandbox.__clone(contextA);
const snapshotAStringId = sandbox.__clone(contextAStringId);
assert.ok(sandbox.__capture(shopLevelContext), "GET/SAVE must accept shop-level context without an RO");
assert.throws(
  () => sandbox.__capture(shopLevelContext, null, { requireRo: true }),
  (error: any) => error?.code === "LABOR_RATE_CONTEXT_REQUIRED",
  "APPLY must still require an RO context",
);
const capturedShopContext = sandbox.__capture(shopLevelContext);
const recapturedShopContext = sandbox.__clone(capturedShopContext);
assert.equal(
  recapturedShopContext.__laborRateSessionIdentity,
  capturedShopContext.__laborRateSessionIdentity,
  "recapturing an existing snapshot must preserve its private session identity",
);
assert.equal(
  sandbox.__clone({ ...shopLevelContext, laborRateSessionDiscriminator: "stale-session" }),
  null,
  "a stale incoming discriminator must not be rebound to the current session",
);
assert.equal(sandbox.__key(snapshotA), sandbox.__key(snapshotAStringId));
assert.equal(sandbox.__key(snapshotA), sandbox.__key(sandbox.__clone(contextAStringTabId)));
assert.notEqual(sandbox.__key(snapshotA), sandbox.__key({ ...snapshotA, provider: "protractor" }));
assert.notEqual(sandbox.__key(snapshotA), sandbox.__key({ ...snapshotA, shopId: "14246" }));
assert.notEqual(sandbox.__key(snapshotA), sandbox.__key({ ...snapshotA, roId: "9002" }));

sandbox.tekmetricProofsByTab.set(11, {
  token: "provider-session-b",
  origin: "https://shop.tekmetric.com",
});
assert.notEqual(
  sandbox.__key(snapshotA),
  sandbox.__key(sandbox.__clone(contextA)),
  "provider session rotation must invalidate the Rates cache identity",
);
sandbox.smsContextsByTab.set(11, contextA);
assert.throws(
  () => sandbox.__assert(snapshotA),
  (error: any) => error?.code === "STALE_LABOR_RATE_CONTEXT",
  "a response from the previous provider session must be rejected",
);

sandbox.smsContextsByTab.set(11, contextB);
assert.throws(
  () => sandbox.__assert(snapshotA),
  (error: any) => error?.code === "STALE_LABOR_RATE_CONTEXT",
);

console.log("✓ Rates requests are provider-qualified and snapshot-bound");
console.log("✓ cache identity includes provider/shop/RO/tab/session");
console.log("✓ stale context responses cannot update or apply another location");
console.log("✓ Basic/revision/provider-action safeguards remain wired");
console.log("All Task #1272 background checks passed.");
