/**
 * Task #1292 — offline Rates-panel consent behavior.
 *
 * Executes the real sidepanel form functions against a minimal DOM fixture.
 * No browser, application server, database, provider, or network is used.
 *
 * Run: npx tsx tests/extension-labor-consent-ui-task-1292.smoke.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as vm from "node:vm";

const root = join(__dirname, "..");
const sidepanel = readFileSync(
  join(root, "mos-tools-extension", "sidepanel.js"),
  "utf8",
);
const dashboard = readFileSync(
  join(root, "app/dashboard/settings/labor-rates/page.tsx"),
  "utf8",
);
const sidepanelHtml = readFileSync(
  join(root, "mos-tools-extension/sidepanel.html"),
  "utf8",
);

const start = sidepanel.indexOf("let originalRateFormCategoryScope");
const end = sidepanel.indexOf("function handleEditRateGroup(", start);
assert.ok(start >= 0 && end > start, "Rates form behavior boundary is missing");

function element(value = "") {
  const listeners = new Map<string, Function>();
  return {
    value,
    checked: false,
    disabled: false,
    textContent: "",
    dataset: {} as Record<string, string>,
    style: { display: "" },
    classList: {
      add() {},
      remove() {},
      toggle() {},
    },
    addEventListener(type: string, callback: Function) {
      listeners.set(type, callback);
    },
    removeEventListener(type: string, callback: Function) {
      if (listeners.get(type) === callback) listeners.delete(type);
    },
    dispatch(type: string) {
      listeners.get(type)?.();
    },
    focus() {},
  };
}

const elements: Record<string, ReturnType<typeof element>> = {
  ratesForm: element(),
  ratesAddBtn: element(),
  rateFormName: element(),
  rateFormMakes: element(),
  rateFormModels: element(),
  rateFormCategories: element(),
  rateFormFuelType: element(),
  rateFormCustomerType: element(),
  rateFormTags: element(),
  rateFormRate: element(),
  rateFormPriority: element("0"),
  rateFormEditId: element(),
  rateFormSaveText: element(),
  rateFormApplyAllWrap: element(),
  rateFormApplyAllLabor: element(),
  rateFormRepriceCategoryWrap: element(),
  rateFormRepriceCategoryLabor: element(),
  rateFormOverrideCatWrap: element(),
  rateFormOverrideCategoryRates: element(),
  rateFormSave: element(),
};

const color = {
  dataset: { color: "#3B82F6" },
  classList: { add() {}, remove() {}, toggle() {} },
};
let capturedRules: any[] = [];
const context = { provider: "tekmetric", shopId: "shop-1", roId: "ro-1", _tabId: 7 };
const quietConsole = { log() {}, warn() {}, error() {} };

const sandbox: any = {
  console: quietConsole,
  elements,
  currentUserCanWrite: true,
  currentLaborRateRules: [],
  currentLaborRateRulesRevision: 3,
  currentLaborRateRulesSmsShopId: "shop-1",
  currentLaborRateRulesContext: context,
  document: {
    querySelector(selector: string) {
      return selector.includes("rate-color-swatch") ? color : null;
    },
    querySelectorAll() {
      return [color];
    },
  },
  getRatesContextSnapshot: () => context,
  laborRateContextKey: (value: any) => JSON.stringify(value),
  startLaborRateOperation: () => ({ id: 1 }),
  isCurrentLaborRateOperation: () => true,
  laborRateResponseMatchesContext: () => true,
  sendMessage: async (message: any) => {
    capturedRules = structuredClone(message.rules);
    return {
      success: true,
      rules: structuredClone(message.rules),
      revision: 4,
      smsShopId: "shop-1",
    };
  },
  renderLaborRateRules() {},
  showNotification() {},
  applyMutationControlLock() {},
  notifyReadOnlyBlocked() {
    throw new Error("unexpected read-only gate");
  },
  laborRateErrorMessage: () => "unexpected save error",
};

vm.createContext(sandbox);
vm.runInContext(
  `${sidepanel.slice(start, end)}
this.__showRateForm = showRateForm;
this.__handleCategoryInput = handleRateCategoryScopeInput;
this.__saveRateGroup = handleSaveRateGroup;`,
  sandbox,
);

function setBaseForm(name: string, rate = "150") {
  elements.rateFormName.value = name;
  elements.rateFormRate.value = rate;
  elements.rateFormPriority.value = "1";
}

async function run() {
  console.log("Task #1292: offline Rates-panel consent behavior");

  // Create and persist an RO-level opt-in.
  sandbox.__showRateForm(null);
  setBaseForm("RO default");
  elements.rateFormApplyAllLabor.checked = true;
  elements.rateFormOverrideCategoryRates.checked = true;
  await sandbox.__saveRateGroup();
  assert.equal(capturedRules.length, 1);
  assert.equal(capturedRules[0].applyToAllLabor, true);
  assert.equal(capturedRules[0].repriceExistingCategoryLabor, false);
  assert.equal(capturedRules[0].overrideCategoryRates, true);

  // Reload/edit uses strict true and never derives consent from override.
  const savedRoRule = structuredClone(capturedRules[0]);
  sandbox.__showRateForm({ ...savedRoRule, applyToAllLabor: "true" });
  assert.equal(elements.rateFormApplyAllLabor.checked, false);
  sandbox.__showRateForm({ ...savedRoRule, applyToAllLabor: true });
  assert.equal(elements.rateFormApplyAllLabor.checked, true);

  // Moving an RO rule into category scope clears incompatible consent.
  elements.rateFormCategories.value = "Brake";
  elements.rateFormCategories.dispatch("input");
  assert.equal(elements.rateFormApplyAllLabor.checked, false);
  assert.equal(elements.rateFormOverrideCategoryRates.checked, false);
  elements.rateFormRepriceCategoryLabor.checked = true;
  await sandbox.__saveRateGroup();
  const savedCategoryRule = capturedRules.find(rule => rule.id === savedRoRule.id);
  assert.equal(savedCategoryRule.applyToAllLabor, false);
  assert.equal(savedCategoryRule.repriceExistingCategoryLabor, true);
  assert.equal(savedCategoryRule.overrideCategoryRates, false);

  // Reload preserves category consent, but any category-scope edit clears it.
  sandbox.__showRateForm(savedCategoryRule);
  assert.equal(elements.rateFormRepriceCategoryLabor.checked, true);
  elements.rateFormCategories.value = "Brake, Diagnostic";
  elements.rateFormCategories.dispatch("input");
  assert.equal(elements.rateFormRepriceCategoryLabor.checked, false);
  await sandbox.__saveRateGroup();
  assert.equal(
    capturedRules.find(rule => rule.id === savedRoRule.id)
      .repriceExistingCategoryLabor,
    false,
  );

  // Removing category scope also clears category consent and saves fail-closed.
  sandbox.__showRateForm({ ...savedCategoryRule, repriceExistingCategoryLabor: true });
  elements.rateFormCategories.value = "";
  elements.rateFormCategories.dispatch("input");
  assert.equal(elements.rateFormRepriceCategoryLabor.checked, false);
  await sandbox.__saveRateGroup();
  const returnedRoRule = capturedRules.find(rule => rule.id === savedRoRule.id);
  assert.equal(returnedRoRule.applyToAllLabor, false);
  assert.equal(returnedRoRule.repriceExistingCategoryLabor, false);

  // Dashboard source shares the strict/scoped transition contract. React is
  // intentionally not mounted here; that would require the real app runtime.
  assert.match(dashboard, /editingRule\.applyToAllLabor === true/);
  assert.match(dashboard, /editingRule\.repriceExistingCategoryLabor === true/);
  assert.match(
    dashboard,
    /updated\[index\]\.type === "jobCategory"[\s\S]*repriceExistingCategoryLabor: false/,
  );
  assert.match(
    dashboard,
    /removed\?\.type === "jobCategory"[\s\S]*repriceExistingCategoryLabor: false/,
  );
  assert.match(sidepanelHtml, /id="rate-form-apply-all-labor"/);
  assert.match(sidepanelHtml, /id="rate-form-reprice-category-labor"/);
  assert.match(sidepanelHtml, /RO-default updates are temporarily blocked/);

  console.log("✓ create/edit/save/reload preserves only strict explicit consent");
  console.log("✓ category scope transitions clear incompatible or stale consent");
  console.log("✓ dashboard and sidepanel expose the same fail-closed UI contract");
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});