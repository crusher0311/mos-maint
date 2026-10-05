/**
 * Focused source-contract checks for Task #1272's Rates panel hardening.
 *
 * The side panel is a classic browser script whose DOM/bootstrap dependencies
 * are not importable under tsx. Keep this test read-only: it verifies the
 * request snapshots, cache identity/revision guards, invalidation points, and
 * Basic-session write gates without making any extension or API calls.
 *
 * Run: `npx tsx tests/extension-sidepanel-labor-rates-task-1272.smoke.ts`
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sidepanel = readFileSync(
  join(__dirname, "..", "mos-tools-extension", "sidepanel.js"),
  "utf8",
);

let passed = 0;
function check(name: string, condition: boolean, detail?: string) {
  assert.ok(condition, detail || name);
  passed += 1;
  console.log(`✓ ${name}`);
}

function functionBody(name: string, nextName: string): string {
  const start = sidepanel.indexOf(`function ${name}`);
  assert.ok(start >= 0, `missing ${name}`);
  const end = sidepanel.indexOf(`function ${nextName}`, start + 1);
  return sidepanel.slice(start, end >= 0 ? end : undefined);
}

const load = functionBody("loadLaborRates", "renderLaborRateRules");
const save = functionBody("handleSaveRateGroup", "handleEditRateGroup");
const deleteRate = functionBody("handleDeleteRateGroup", "handleApplyLaborRateNow");
const apply = functionBody("handleApplyLaborRateNow", "populateStickerIntervalOptions");

console.log("Task #1272: Rates panel context/cache contracts");

check(
  "GET snapshots currentContext before sending",
  load.includes("const requestContext = getRatesContextSnapshot()") &&
    load.includes("action: 'GET_LABOR_RATE_RULES'") &&
    load.includes("context: requestContext"),
);
check(
  "SAVE sends the captured context and displayed revision",
  save.includes("const requestContext = getRatesContextSnapshot()") &&
    save.includes("currentLaborRateRulesContext") &&
    save.includes("expectedRevision") &&
    save.includes("context: requestContext"),
);
check(
  "APPLY sends the captured context rather than mutable global state",
  apply.includes("const requestContext = getRatesContextSnapshot({ requiresRo: true })") &&
    apply.includes("action: 'APPLY_LABOR_RATE_NOW'") &&
    apply.includes("context: requestContext"),
);
check(
  "GET stores displayed rules context and revision",
  load.includes("currentLaborRateRulesRevision = Number(result.revision ?? 0)") &&
    load.includes("currentLaborRateRulesContext = requestContext"),
);
check(
  "late GET responses are dropped before painting",
  load.includes("if (!isCurrentLaborRateOperation(operation)) return;") &&
    load.includes("laborRateResponseMatchesContext(result, requestContext)") &&
    load.includes("renderLaborRateRules()"),
);
check(
  "late SAVE responses cannot merge old rules",
  save.includes("if (!isCurrentLaborRateOperation(operation))") &&
    save.includes("currentLaborRateRules = result.rules || updatedRules") &&
    save.includes("currentLaborRateRulesContext = requestContext"),
);
check(
  "late APPLY responses cannot report success for a new RO",
  apply.includes("if (!isCurrentLaborRateOperation(operation))") &&
    apply.includes("active shop, repair order, or browser tab changed"),
);
check(
  "cache identity includes provider, shop, source tab, and RO",
  sidepanel.includes("function laborRateContextKey(context)") &&
    sidepanel.includes("function laborRateContextScopeKey(context)") &&
    /provider:\s*context\.provider/.test(sidepanel) &&
    /shopId:\s*context\.shopId/.test(sidepanel) &&
    /tabId:\s*tabId/.test(sidepanel) &&
    /roId:\s*context\.roId/.test(sidepanel),
);
check(
  "shop/tab/RO changes invalidate displayed rules",
  sidepanel.includes("laborRateContextKey(prevContext) !== laborRateContextKey(context)") &&
    sidepanel.includes("invalidateLaborRateState('shop, tab, or repair-order context changed')"),
);
check(
  "leaving the Rates panel invalidates in-flight work",
  sidepanel.includes("currentTab === 'rates' && tab !== 'rates'") &&
    sidepanel.includes("invalidateLaborRateState('panel tab changed')"),
);
check(
  "session changes invalidate the Rates cache",
  sidepanel.includes("updateLaborRateSession(authStatus)") &&
    sidepanel.includes("invalidateLaborRateState('session changed')") &&
    sidepanel.includes("invalidateLaborRateState('session ended')"),
);
check(
  "applied broadcasts are filtered by current RO/tab/session",
  sidepanel.includes("if (!laborRateAppliedBroadcastMatchesCurrent(message)) return;") &&
    sidepanel.includes("message.sessionDiscriminator") &&
    sidepanel.includes("laborRateContextScopeKey"),
);
check(
  "Basic sessions retain every labor-rate mutation gate",
  save.includes("if (!currentUserCanWrite) { notifyReadOnlyBlocked(); return; }") &&
    deleteRate.includes("if (!currentUserCanWrite) { notifyReadOnlyBlocked(); return; }") &&
    apply.includes("if (!currentUserCanWrite) { notifyReadOnlyBlocked(); return; }") &&
    sidepanel.includes("'#rate-form-save', '.rate-group-delete-btn'"),
);
check(
  "errors explain session, access, context, and location recovery",
  sidepanel.includes("Your MOS.Tools session may have expired") &&
    sidepanel.includes("You do not have permission to manage labor rates") &&
    sidepanel.includes("active shop or browser tab changed") &&
    sidepanel.includes("Verify the active shop"),
);

console.log(`\nAll ${passed} Task #1272 sidepanel assertions passed.`);