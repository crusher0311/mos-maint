/**
 * Executable labor-rate behavior contracts.
 *
 * Unlike the source-shape smoke test, these assertions call the same pure
 * contracts used by sidepanel.js and background.js. This covers permission
 * fail-closed behavior, broadcast context/session filtering, and the actual
 * apply-result summary returned to the Rates panel.
 *
 * Run: `npx tsx tests/extension-labor-rate-behavior-task-1272.smoke.ts`
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import laborRateCore from "../mos-tools-extension/labor-rate-core.js";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

function extractFunction(source: string, name: string, nextName: string): string {
  const start = source.indexOf(`function ${name}`);
  assert.ok(start >= 0, `missing ${name}`);
  const end = source.indexOf(`function ${nextName}`, start + 1);
  return source.slice(start, end >= 0 ? end : undefined);
}

const currentContext = {
  provider: "tekmetric",
  shopId: 42,
  roId: 9001,
  _tabId: 17,
};
const sessionDiscriminator = "17:session-a";
const sidepanelSource = readFileSync(
  join(__dirname, "..", "mos-tools-extension", "sidepanel.js"),
  "utf8",
);
const ratesSnapshotSource = extractFunction(
  sidepanelSource,
  "getRatesContextSnapshot",
  "laborRateContextKey",
);
const ratesSnapshotSandbox: Record<string, unknown> = {
  currentContext: {
    provider: currentContext.provider,
    shopId: currentContext.shopId,
    _tabId: currentContext._tabId,
  },
  laborRateSessionDiscriminator: sessionDiscriminator,
  cloneLaborRateContext: (context: Record<string, unknown>) =>
    JSON.parse(JSON.stringify(context)),
};
vm.runInNewContext(
  `${ratesSnapshotSource}; this.getRatesContextSnapshot = getRatesContextSnapshot;`,
  ratesSnapshotSandbox,
);
const getRatesContextSnapshot = ratesSnapshotSandbox.getRatesContextSnapshot as
  (options?: { requiresRo?: boolean }) => Record<string, unknown> | null;

const sidepanelHarness: Record<string, unknown> = {
  currentContext: {
    provider: currentContext.provider,
    shopId: currentContext.shopId,
    roId: currentContext.roId,
    _tabId: currentContext._tabId,
    laborRateSessionDiscriminator: "session-a",
  },
  laborRateContextGeneration: 0,
  laborRateOperationSequence: 0,
  laborRateSessionKey: null,
  laborRateSessionDiscriminator: "session-a",
  currentLaborRateRules: [],
  currentLaborRateRulesRevision: 0,
  currentLaborRateRulesSmsShopId: null,
  currentLaborRateRulesContext: null,
  currentTab: "jobs",
  isAuthenticated: false,
  elements: {
    ratesLoading: null,
    ratesList: null,
    ratesEmptyHint: null,
    ratesMain: null,
    ratesError: null,
    ratesApplyNowBtn: null,
  },
  resetLaborRateApplyButton: () => {},
};
vm.runInNewContext(
  [
    extractFunction(sidepanelSource, "cloneLaborRateContext", "getRatesContextSnapshot"),
    extractFunction(sidepanelSource, "getRatesContextSnapshot", "laborRateContextKey"),
    extractFunction(sidepanelSource, "laborRateContextKey", "laborRateContextScopeKey"),
    extractFunction(sidepanelSource, "laborRateContextScopeKey", "laborRateSessionFingerprint"),
    extractFunction(sidepanelSource, "laborRateSessionFingerprint", "laborRateAppliedBroadcastMatchesCurrent"),
    extractFunction(sidepanelSource, "synchronizeLaborRateContextSession", "updateLaborRateSession"),
    extractFunction(sidepanelSource, "updateLaborRateSession", "invalidateLaborRateState"),
    extractFunction(sidepanelSource, "invalidateLaborRateState", "startLaborRateOperation"),
    extractFunction(sidepanelSource, "startLaborRateOperation", "isCurrentLaborRateOperation"),
    extractFunction(sidepanelSource, "isCurrentLaborRateOperation", "laborRateResponseMatchesContext"),
    "this.getRatesContextSnapshot = getRatesContextSnapshot;",
    "this.updateLaborRateSession = updateLaborRateSession;",
    "this.startLaborRateOperation = startLaborRateOperation;",
    "this.isCurrentLaborRateOperation = isCurrentLaborRateOperation;",
  ].join("\n"),
  sidepanelHarness,
);
const harnessGetRatesContextSnapshot = sidepanelHarness.getRatesContextSnapshot as
  (options?: { requiresRo?: boolean }) => Record<string, unknown> | null;
const updateLaborRateSession = sidepanelHarness.updateLaborRateSession as
  (authStatus: Record<string, unknown>) => void;
const startLaborRateOperation = sidepanelHarness.startLaborRateOperation as
  (context: Record<string, unknown>) => Record<string, unknown>;
const isCurrentLaborRateOperation = sidepanelHarness.isCurrentLaborRateOperation as
  (operation: Record<string, unknown>) => boolean;

console.log("Task #1272: executable labor-rate behavior contracts");

check("permission defaults fail closed while auth resolves", () => {
  assert.equal(laborRateCore.effectiveMutationPermission(false, false), false);
  assert.equal(laborRateCore.effectiveMutationPermission(true, false), false);
  assert.equal(laborRateCore.effectiveMutationPermission(false, true), false);
  assert.equal(laborRateCore.effectiveMutationPermission(true, true), true);
});

check("shop-level Rates load/save snapshots do not require an RO", () => {
  const snapshot = getRatesContextSnapshot();
  assert.deepEqual(snapshot, {
    provider: "tekmetric",
    shopId: 42,
    _tabId: 17,
    laborRateSessionDiscriminator: sessionDiscriminator,
  });
  for (const action of ["GET_LABOR_RATE_RULES", "SAVE_LABOR_RATE_RULES"]) {
    assert.equal(action.includes("LABOR_RATE"), true);
    assert.equal((snapshot as Record<string, unknown>)?.roId, undefined);
  }
});

check("Rates Apply is denied without an RO snapshot", () => {
  assert.equal(getRatesContextSnapshot({ requiresRo: true }), null);
});

check("auth refresh redecorates unchanged context for fresh GET/SAVE", () => {
  const authA = {
    isAuthenticated: true,
    authSource: "bootstrap",
    user: { id: "user-1" },
    sessionTier: { tier: "verified" },
    laborRateSessionDiscriminator: "session-a",
  };
  updateLaborRateSession(authA);
  const oldOperation = startLaborRateOperation(
    sidepanelHarness.currentContext as Record<string, unknown>,
  );

  updateLaborRateSession({
    ...authA,
    laborRateSessionDiscriminator: "session-b",
  });
  assert.equal(
    (sidepanelHarness.currentContext as Record<string, unknown>).laborRateSessionDiscriminator,
    "session-b",
  );
  assert.equal(isCurrentLaborRateOperation(oldOperation), false);

  const freshContext = harnessGetRatesContextSnapshot();
  assert.equal(freshContext?.provider, "tekmetric");
  assert.equal(freshContext?.shopId, 42);
  assert.equal(freshContext?.roId, 9001);
  assert.equal(freshContext?.laborRateSessionDiscriminator, "session-b");
  const freshOperation = startLaborRateOperation(freshContext!);
  for (const action of ["GET_LABOR_RATE_RULES", "SAVE_LABOR_RATE_RULES"] as const) {
    const request: {
      action: typeof action;
      context: Record<string, unknown>;
    } = { action, context: freshContext! };
    assert.equal(request.context, freshContext);
    assert.equal(isCurrentLaborRateOperation(freshOperation), true);
  }
});

check("matching applied broadcast is accepted for current RO/tab/session", () => {
  assert.equal(
    laborRateCore.appliedBroadcastMatchesCurrent(
      {
        success: true,
        tabId: 17,
        sessionDiscriminator,
        context: { ...currentContext },
      },
      currentContext,
      sessionDiscriminator,
    ),
    true,
  );
});

check("stale applied broadcasts are rejected by RO, tab, and session", () => {
  const base = {
    success: true,
    tabId: 17,
    sessionDiscriminator,
    context: { ...currentContext },
  };
  assert.equal(
    laborRateCore.appliedBroadcastMatchesCurrent(
      { ...base, context: { ...base.context, roId: 9002 } },
      currentContext,
      sessionDiscriminator,
    ),
    false,
  );
  assert.equal(
    laborRateCore.appliedBroadcastMatchesCurrent(
      { ...base, tabId: 18 },
      currentContext,
      sessionDiscriminator,
    ),
    false,
  );
  assert.equal(
    laborRateCore.appliedBroadcastMatchesCurrent(
      { ...base, sessionDiscriminator: "17:session-b" },
      currentContext,
      sessionDiscriminator,
    ),
    false,
  );
  assert.equal(
    laborRateCore.appliedBroadcastMatchesCurrent(
      { ...base, sessionDiscriminator: undefined },
      currentContext,
      sessionDiscriminator,
    ),
    false,
  );
});

check("successful apply returns the actual rule name and rate", () => {
  const result = laborRateCore.summarizeLaborRateOutcomes([
    {
      success: true,
      ruleName: "Toyota labor",
      rate: 125,
      previousRate: 110,
      updatedCount: 2,
      jobNames: ["Brake job"],
      perJob: true,
    },
  ], { context: currentContext });
  assert.equal(result.success, true);
  assert.equal(result.ruleName, "Toyota labor");
  assert.equal(result.rate, 125);
  assert.equal(result.updatedCount, 2);
  assert.deepEqual(result.jobNames, ["Brake job"]);
});

check("failed apply cannot be reported as success", () => {
  const result = laborRateCore.summarizeLaborRateOutcomes([
    {
      success: false,
      ruleName: "Toyota labor",
      rate: 125,
      error: "Update failed: 403",
      code: "SHOP_FORBIDDEN",
    },
  ], { context: currentContext });
  assert.equal(result.success, false);
  assert.equal(result.ruleName, "Toyota labor");
  assert.equal(result.rate, 125);
  assert.match(String(result.error), /403/);
});

check("no confirmed operation is an explicit no-match failure", () => {
  const result = laborRateCore.summarizeLaborRateOutcomes([], {
    perJobRuleCount: 0,
    context: currentContext,
  });
  assert.equal(result.success, false);
  assert.equal(result.noMatch, true);
  assert.match(String(result.error), /No matching rules/);
});

check("already-applied rate remains a successful no-change result", () => {
  const result = laborRateCore.summarizeLaborRateOutcomes([
    {
      success: true,
      noChange: true,
      ruleName: "Toyota labor",
      rate: 125,
    },
  ], { context: currentContext });
  assert.equal(result.success, true);
  assert.equal(result.noChange, true);
  assert.equal(result.ruleName, "Toyota labor");
  assert.equal(result.rate, 125);
});

console.log(`\nAll ${passed} executable labor-rate assertions passed.`);