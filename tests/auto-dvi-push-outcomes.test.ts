import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { publicDviPushOutcome, DVI_PUSH_UNCERTAIN_MESSAGE } from "../lib/auto-dvi/push-outcome";

const loader = Module as unknown as { _load: (id: string, ...args: any[]) => any };
const original = loader._load;
let packageMode = "ok", resultsMode = "ok", receiptFails = false;
let packageWrites = 0, resultsWrites = 0;
const guid = "11111111-1111-4111-8111-111111111111";
loader._load = function(id, ...args) {
  if (id === "next/server") return { NextResponse: class extends Response {
    static json(v: any, i?: ResponseInit) { return Response.json(v, i); }
  }};
  if (id === "@/lib/auth") return { getSession: async () => ({shopId: 1, email: "fixture@example.invalid"}) };
  if (id === "@/lib/extension-route-wrapper") return { withExtensionErrorMarker: (f: any) => f };
  if (id === "@/lib/extension-route-guard") return {
    checkShopFeatureGate: async () => null,
    guardExtensionShopRequest: async () => ({ok: true, mosShopId: 1, provider: "protractor", user: {}}),
  };
  if (id === "@/lib/shop-feature-access") return { AUTO_DVI_REQUIRED_FEATURES: [] };
  if (id === "@/lib/data/repositories/auto-dvi") return {
    isProtractorShop: async () => true,
    recordAutoDviApplication: async () => { if (receiptFails) throw new Error("fixture receipt lost"); },
  };
  if (id === "@/lib/auto-dvi/recommended-work") return { buildRecommendedWorkPackages: async () => ({packages: []}) };
  if (id === "@/lib/extension-analytics") return { trackPushToRO: async () => {} };
  if (id === "@/lib/integrations/protractor/interactive-context") return { runWithProtractorInteractiveTransport: (_: any, f: any) => f() };
  if (id === "@/lib/integrations/protractor") return {
    resolveProtractorConfig: async () => ({configured: true}),
    fetchWorkOrderById: async () => ({ok: true, workOrder: {ID: guid, ServicePackages: []}}),
    buildMinimalPayloadForPost: (_: any, packages: any[], pkg: any) => ({ServicePackages: {ItemCollection: [...packages, pkg]}}),
    protractorFetch: async () => {
      packageWrites++;
      if (packageMode === "throw") throw new Error("secret package timeout");
      return {ok: packageMode === "ok", error: "secret provider rejection"};
    },
    updateInspectionResults: async () => {
      resultsWrites++;
      if (resultsMode === "throw") throw new Error("secret provider timeout");
      return {ok: resultsMode === "ok", error: "secret provider rejection"};
    },
  };
  return original.call(this, id, ...args);
};
const { pushInspectionPackageToProtractor: push } = require("../lib/auto-dvi/protractor-push");
const dashboard = require("../app/api/auto-dvi/push/route");
const extension = require("../app/api/extension/auto-dvi/push/route");
const opts = {shopId: 1, workOrderGuid: guid, packageTitle: "Inspection", lineTitles: ["Inspected: Battery"],
  inspectionItems: [{name: "Battery", rating: "red"}]};

test("transport separates acknowledged packages from unconfirmed findings without replay", async () => {
  for (const mode of ["ok", "reject", "throw"]) {
    packageMode = "ok"; resultsMode = mode; packageWrites = resultsWrites = 0;
    const result = await push(opts);
    assert.equal(result.ok, true); // legacy contract
    assert.equal(result.pushOutcome.packageStatus, "acknowledged");
    assert.equal(result.pushOutcome.resultsStatus, mode === "ok" ? "acknowledged" : "uncertain");
    assert.equal(result.pushOutcome.readBackStatus, "not_performed");
    assert.equal(packageWrites, 1); assert.equal(resultsWrites, 1);
  }
  packageMode = "throw"; resultsWrites = 0;
  const result = await push(opts);
  assert.equal(result.pushOutcome.packageStatus, "uncertain");
  assert.equal(resultsWrites, 0);
  assert.doesNotMatch(result.error, /secret/);
});

test("both real route handlers retain legacy fields and surface partial, timeout and lost receipt", async () => {
  for (const route of [dashboard, extension]) {
    for (const scenario of ["ok", "reject", "throw", "receipt", "package"]) {
      packageMode = scenario === "package" ? "throw" : "ok";
      resultsMode = ["reject", "throw"].includes(scenario) ? scenario : "ok";
      receiptFails = scenario === "receipt";
      const response = await route.POST(new Request("https://offline.invalid/api/auto-dvi/push", {
        method: "POST", body: JSON.stringify({...opts, items: opts.inspectionItems, provider: "protractor"}),
      }));
      const data = await response.json();
      assert.equal(response.status, scenario === "package" ? 500 : 200);
      assert.equal(data.outcome, scenario === "ok" ? "complete" : ["receipt", "package"].includes(scenario) ? "uncertain" : "partial");
      assert.equal(data.recoveryAllowed, false);
      assert.doesNotMatch(JSON.stringify(data), /secret|fixture receipt|inspectionResultsError/);
      if (scenario !== "package") {
        assert.equal(data.ok, true);
        assert.equal(data.lineCount, 1);
        assert.equal(data.workOrderId, guid);
      }
      if (scenario !== "ok") assert.match(data.message, /Do not resend/);
    }
  }
});

// Execute the actual UI event handlers in isolation, not copies of their logic.
const panel = fs.readFileSync("app/dashboard/vehicles/[vin]/plan/AutoDviPanel.tsx", "utf8");
const dashboardHandler = panel.slice(panel.indexOf("  async function push()"), panel.indexOf("\n  return (", panel.indexOf("  async function push()")));
const sidepanel = fs.readFileSync("mos-tools-extension/sidepanel.js", "utf8");
const extensionHandler = sidepanel.slice(sidepanel.indexOf("async function handleAutoDviPush()"), sidepanel.indexOf("\nasync function handleAutoDviGenerate()"));
const extensionVerification = sidepanel.slice(sidepanel.indexOf("const autoDviVerificationByWorkOrder"), sidepanel.indexOf("async function handleAutoDviPush()"));
const extensionRender = sidepanel.slice(sidepanel.indexOf("function renderAutoDviChecklist(data)"), sidepanel.indexOf("let autoDviRecorder"));
const extensionGenerate = sidepanel.slice(sidepanel.indexOf("async function handleAutoDviGenerate()"), sidepanel.indexOf("async function autoDviLoadSavedFindings()"));
test("dashboard and extension warn and block repeat clicks for partial/uncertain or lost response", async () => {
  const partial = publicDviPushOutcome({packageStatus: "acknowledged", resultsStatus: "uncertain", readBackStatus: "not_performed"});
  const receipt = publicDviPushOutcome({packageStatus: "acknowledged", resultsStatus: "acknowledged", readBackStatus: "not_performed"}, false);
  const complete = {ok: true, lineCount: 1, inspectionResultsWritten: true,
    ...publicDviPushOutcome({packageStatus: "acknowledged", resultsStatus: "acknowledged", readBackStatus: "not_performed"})};
  for (const payload of [partial, receipt, null, undefined, complete]) {
    let error = "", success = "", locked = false, calls = 0;
    const ctx: any = {items: [{id: "a", name: "Battery"}], checked: {a: true}, findings: {}, addRecommended: false,
      vin: "FIXTURE", roNumber: "", getFinding: () => ({}), pushNeedsVerification: false, DVI_PUSH_UNCERTAIN_MESSAGE,
      setPushing() {}, setError(v: string) {error = v;}, setSuccess(v: string) {success = v;},
      setPushNeedsVerification(v: boolean) {locked = v; ctx.pushNeedsVerification = v;},
      fetch: async () => { calls++; if (!payload) throw Error("network lost"); return {ok: true, json: async () => payload}; },
    };
    vm.createContext(ctx);
    vm.runInContext(ts.transpile(dashboardHandler), ctx);
    await ctx.push();
    if (payload === complete) {
      assert.equal(locked, false); assert.ok(!error); assert.match(success, /findings also recorded/);
    } else {
      await ctx.push();
      assert.ok(locked); assert.match(error, /Do not resend/); assert.ok(!success);
    }
    assert.equal(calls, 1);

    let button: any;
    let warning: any;
    let sends = 0;
    const body = {
      set innerHTML(_html: string) {
        // Model DOM replacement, discarding the old button and its properties.
        button = {disabled: false, textContent: "Write", addEventListener() {}};
        warning = {hidden: true, textContent: ""};
      },
      classList: {remove() {}}, querySelectorAll: () => [],
    };
    const notifications: any[] = [];
    const generateButton = {disabled: false, textContent: "Generate"};
    const ext: any = {console: {error() {}}, autoDviInFlight: false, autoDviData: {items: [{id: "a", name: "Battery"}]},
      currentContext: {provider: "protractor", shopId: 1, vin: "FIXTURE", roId: "RO-A"},
      document: {getElementById: (id: string) => id === "auto-dvi-btn" ? generateButton : id === "auto-dvi-body" ? body : id === "auto-dvi-push-btn" ? button : warning,
        querySelectorAll: () => [{checked: true, dataset: {idx: "0"}}]},
      autoDviVoiceBtn: () => null, autoDviRecorder: null, escapeAutoDviHtml: (s: any) => String(s || ""),
      autoDviLoadSavedFindings: async () => {},
      autoDviGetFinding: () => ({}), planCacheKey: () => "fixture", getRecentlyCreatedWoGuid: () => guid,
      showNotification: (...args: any[]) => notifications.push(args),
      sendMessage: async () => { sends++; if (payload === null) throw Error("lost"); return payload; },
    };
    vm.createContext(ext); vm.runInContext(extensionVerification + extensionRender + extensionHandler + extensionGenerate, ext);
    const pushSend = ext.sendMessage;
    ext.sendMessage = async () => ext.autoDviData;
    await ext.handleAutoDviGenerate();
    assert.equal(button.disabled, false, "normal generation must enable an unlocked push");
    assert.equal(generateButton.disabled, false);
    ext.sendMessage = pushSend;
    await ext.handleAutoDviPush();
    assert.equal(button.disabled, payload !== complete);
    if (payload !== complete) assert.match(notifications[0][0], /Do not resend/);
    assert.equal(notifications[0][1], payload === complete ? "success" : "error");
    if (payload !== complete) {
      const oldButton = button;
      ext.renderAutoDviChecklist(ext.autoDviData);
      assert.notEqual(button, oldButton);
      assert.equal(warning.hidden, false);
      assert.match(warning.textContent, /Verification needed:.*Do not resend/);
      await ext.handleAutoDviPush();
      assert.equal(button.disabled, true);
      assert.equal(sends, 1);
      ext.currentContext.roId = "RO-B";
      ext.renderAutoDviChecklist(ext.autoDviData);
      assert.equal(button.disabled, false); assert.equal(warning.hidden, true);
      ext.currentContext.roId = "RO-A";
      ext.renderAutoDviChecklist(ext.autoDviData);
      assert.equal(button.disabled, true); assert.equal(warning.hidden, false);
      await ext.handleAutoDviPush(); assert.equal(sends, 1);
      ext.sendMessage = async () => ext.autoDviData;
      await ext.handleAutoDviGenerate();
      assert.equal(button.disabled, true, "regeneration must preserve verification lock");
      assert.equal(warning.hidden, false);
      assert.equal(generateButton.disabled, false);
      ext.sendMessage = pushSend;
      await ext.handleAutoDviPush(); assert.equal(sends, 1);
    }
  }
  assert.match(panel, /disabled=\{pushing \|\| pushNeedsVerification\}/);
  assert.match(panel, /VISIT_DVI_RELEASE_ENABLED/);
});
