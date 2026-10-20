// Offline DOM regressions: all HTTP is intercepted, no provider/database access.
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const { test } = require("node:test");
const { build } = require("esbuild");
const React = require("react");
const { act } = React;
const { JSDOM } = require("jsdom");

const item = (id = "tire.lf") => ({
  id, name: id === "tire.lf" ? "Left front tire" : "Battery test",
  procedure: id === "tire.lf" ? "manual-tread-depth" : "manual-battery-test", position: id === "tire.lf" ? "lf" : "",
  fields: [{ id: "depth", label: "Tread depth", type: "number", unit: "mm" }],
  required: true, requiredFields: ["depth"], notesRequired: true, photoRequired: false, recommendationRequired: false,
});
const sheet = (id = "safety", version = 1) => ({ id, version, name: id === "safety" ? "Shop safety inspection" : "Battery inspection", items: [item(id === "safety" ? "tire.lf" : "battery")] });
const snapshot = values => ({
  scope: "shop", scopeLabel: "Cedar Motor Service", canManage: true, revision: 14,
  sheets: [sheet()], archivedSheetIds: [], defaultSheet: "safety@1",
  templates: [sheet("battery")], inspectionEnabled: true, ...values,
});
const reply = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
let components;
async function harness() {
  if (!components) {
    const bundle = await build({
      stdin: { contents: 'export { SheetManager } from "./SheetManager"; export { SheetSettingsLink } from "./SheetSettingsLink"; export { default as DispatchPilot } from "./DispatchPilot";', resolveDir: __dirname, loader: "tsx" },
      bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic",
      external: ["react", "react-dom", "zod"],
      plugins: [{ name: "offline", setup(builder) {
        builder.onResolve({ filter: /^@\/lib\/shop-dispatch\/client$/ }, () => ({ path: "board", namespace: "fixture" }));
        builder.onResolve({ filter: /^next\/link$/ }, () => ({ path: "next-link", namespace: "link-fixture" }));
        builder.onLoad({ filter: /.*/, namespace: "link-fixture" }, () => ({ contents: 'import React from "react"; export default function Link(props){return React.createElement("a",props)}', loader: "js" }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export function useDispatchBoard(){return globalThis.__dispatchFixture;}", loader: "js" }));
        builder.onLoad({ filter: /\.module\.css$/ }, () => ({ contents: "export default new Proxy({}, {get: (_, key) => key})", loader: "js" }));
      } }],
    });
    const compiled = new Module(path.join(__dirname, "offline-sheet-manager.cjs"), module);
    compiled.filename = path.join(__dirname, "offline-sheet-manager.cjs");
    compiled.paths = module.paths;
    compiled._compile(bundle.outputFiles[0].text, compiled.filename);
    components = compiled.exports;
  }
  const dom = new JSDOM("<div id='root'></div>", { url: "http://offline.invalid" });
  const keys = ["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT", "fetch", "__dispatchFixture"];
  const previous = Object.fromEntries(keys.map(key => [key, global[key]]));
  const calls = [];
  let responder = () => reply(snapshot());
  Object.assign(global, { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true });
  const { createRoot } = require("react-dom/client");
  global.fetch = async (url, options = {}) => {
    calls.push({ url, ...options });
    return responder(url, options);
  };
  dom.window.confirm = () => true;
  const root = createRoot(document.getElementById("root"));
  const render = async (name = "SheetManager", props = {}) => act(async () => root.render(React.createElement(components[name], props)));
  const button = label => [...document.querySelectorAll("button")].find(node => node.textContent === label);
  const click = async label => act(async () => {
    const node = button(label);
    assert.ok(node, `Missing button: ${label}`);
    assert.equal(node.disabled, false, `Disabled button: ${label}`);
    node.click();
  });
  const labelControl = label => {
    const node = [...document.querySelectorAll("label")].find(node => node.firstChild?.textContent === label);
    assert.ok(node, `Missing input label: ${label}`);
    return node.querySelector("input, select, textarea");
  };
  const setValue = async (label, value) => act(async () => {
    const node = labelControl(label);
    const proto = node.tagName === "SELECT" ? dom.window.HTMLSelectElement.prototype :
      node.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(node, value);
    node.dispatchEvent(new dom.window.Event(node.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
  const posts = () => calls.filter(call => call.method === "POST");
  return { calls, posts, render, button, click, labelControl, setValue, dom,
    respond(fn) { responder = fn; },
    async close() { await act(async () => root.unmount()); dom.window.close(); Object.assign(global, previous); },
  };
}

test("enterprise ownership is read-only regardless of workflow manager role; DVI availability is independent", async () => {
  const h = await harness();
  try {
    h.respond(() => reply(snapshot({ scope: "enterprise", scopeLabel: "Cedar Automotive Group", canManage: false, inspectionEnabled: false })));
    await h.render();
    assert.match(document.body.textContent, /Enterprise owned/);
    assert.match(document.body.textContent, /Read-only · Cedar Automotive Group owns/);
    assert.match(document.body.textContent, /Technician inspections are currently disabled/);
    assert.equal(h.button("Create sheet"), undefined);
    assert.equal(h.button("Set as default"), undefined);
    assert.equal(h.button("Duplicate sheet"), undefined);
    assert.equal(h.posts().length, 0);
    assert.equal(h.calls[0].url, "/api/shop-dispatch/inspection/sheets");
    assert.equal(h.calls[0].credentials, "include");
  } finally { await h.close(); }
});

test("403 alone hides the Sheets tab; network failure remains retryable, never grants management", async () => {
  const h = await harness();
  try {
    global.__dispatchFixture = {
      snapshot: { shopId: 66, actor: { email: "advisor@offline.invalid", manager: false }, serverNow: new Date().toISOString(),
        board: { revision: 1, visits: [], jobs: [], technicians: [], audit: [] } },
      error: "", busy: false, lastReceived: Date.now(), refresh() {}, needsRetry: false,
    };
    h.respond(() => reply({ error: "DVI unavailable" }, 403));
    await h.render("DispatchPilot", { key: "denied" });
    assert.equal(document.querySelector('[data-testid="pilot-sheets"]'), null);
    h.respond(() => { throw Error("Network unavailable"); });
    await h.render("DispatchPilot", { key: "network" });
    assert.ok(document.querySelector('[data-testid="pilot-sheets"]'));
    await h.click("Sheets");
    assert.match(document.body.textContent, /Network unavailable/);
    assert.equal(h.button("Create sheet"), undefined);
    h.respond(() => reply(snapshot({ canManage: false })));
    await h.click("Retry loading sheets");
    assert.match(document.body.textContent, /Shop safety inspection/);
    assert.equal(h.button("Create sheet"), undefined);
    assert.equal(h.posts().length, 0);
  } finally { await h.close(); }
});

test("new sheet copies reusable identity, reorders items, builds required select field and publishes base version zero", async () => {
  const h = await harness();
  try {
    const locks = [];
    await h.render("SheetManager", { onLockChange: value => locks.push(value) });
    await h.click("Create sheet");
    assert.equal(locks.at(-1), true);
    await h.setValue("Sheet name", "Arrival check");
    const reuse = h.labelControl("Copy a reusable item");
    await h.setValue("Copy a reusable item", reuse.options[1].value);
    await h.click("Copy item with identity");
    await h.click("Add custom item");
    // Change the second item directly by label order.
    await act(async () => {
      const inputs = [...document.querySelectorAll("label")].filter(label => label.firstChild?.textContent === "Item name").map(label => label.querySelector("input"));
      Object.getOwnPropertyDescriptor(h.dom.window.HTMLInputElement.prototype, "value").set.call(inputs[1], "Road test");
      inputs[1].dispatchEvent(new h.dom.window.Event("input", { bubbles: true }));
    });
    await act(async () => document.querySelector('[aria-label="Move item 2 up"]').click());
    await h.click("Add field");
    await h.setValue("Field label", "Road surface");
    await h.setValue("Field type", "select");
    await h.setValue("Options (one per line, up to 30)", "Dry\nWet");
    await act(async () => {
      const checkbox = [...document.querySelectorAll("label")].find(label => label.textContent === "Measurement required").querySelector("input");
      checkbox.click();
    });
    h.respond((url, options) => {
      const request = JSON.parse(options.body);
      assert.equal(request.command.sheet.version, 0);
      assert.equal(request.revision, 14);
      assert.equal(request.command.sheet.name, "Arrival check");
      assert.equal(request.command.sheet.items[0].name, "Road test");
      assert.deepEqual(request.command.sheet.items[1], item());
      const field = request.command.sheet.items[0].fields[0];
      assert.equal(field.type, "select");
      assert.deepEqual(field.options, ["Dry", "Wet"]);
      assert.deepEqual(request.command.sheet.items[0].requiredFields, [field.id]);
      return reply(snapshot({ revision: 15, sheets: [sheet(), { ...request.command.sheet, version: 1 }] }));
    });
    await h.click("Publish new version");
    assert.equal(h.posts().length, 1);
    assert.equal(locks.at(-1), false);
    assert.match(document.body.textContent, /Approved definition/);
    assert.match(document.body.textContent, /Arrival check/);
  } finally { await h.close(); }
});

test("an uncertain save retains exact UUID and payload, blocks edits/discard and navigation until acknowledged", async () => {
  const h = await harness();
  try {
    let fail = true;
    const locks = [];
    h.respond((url, options) => {
      if (!options.method) return reply(snapshot());
      if (fail) throw Error("Acknowledgment lost");
      const request = JSON.parse(options.body);
      return reply(snapshot({ revision: 15, sheets: [sheet(), { ...request.command.sheet, version: 2 }] }));
    });
    await h.render("SheetManager", { onLockChange: value => locks.push(value) });
    await h.click("Edit latest version");
    await h.setValue("Sheet name", "Safety with notes");
    await h.click("Publish new version");
    const original = h.posts()[0].body;
    const request = JSON.parse(original);
    assert.match(request.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(request.command.sheet.version, 1);
    assert.equal(locks.at(-1), true);
    assert.equal(h.button("Discard draft").disabled, true);
    assert.equal(h.button("Create sheet").disabled, true);
    assert.equal(h.labelControl("Sheet name").closest("fieldset").disabled, true);
    assert.equal(h.labelControl("Sheet name").value, "Safety with notes");
    fail = false;
    await h.click("Retry exact save");
    assert.equal(h.posts()[1].body, original);
    assert.equal(locks.at(-1), false);
    assert.match(document.body.textContent, /safety@2/);
  } finally { await h.close(); }
});

test("409 keeps draft and old revision until explicit discard/reload; no silent rebase or automatic retry", async () => {
  const h = await harness();
  try {
    let current = snapshot();
    h.respond((url, options) => options.method ? reply({ error: "Catalog revision conflict" }, 409) : reply(current));
    await h.render();
    await h.click("Edit latest version");
    await h.setValue("Sheet name", "My retained draft");
    await h.click("Publish new version");
    assert.equal(h.labelControl("Sheet name").value, "My retained draft");
    assert.equal(h.button("Publish new version").disabled, true);
    assert.equal(h.posts().length, 1);
    assert.equal(h.calls.filter(call => !call.method).length, 1, "Conflict does not fetch/rebase behind the user's back");
    current = snapshot({ revision: 19, sheets: [sheet(), { ...sheet("safety", 2), name: "Other manager's version" }] });
    await h.click("Discard draft and reload latest");
    assert.match(document.body.textContent, /Other manager's version/);
    assert.equal(h.labelControl("Preview immutable version").value, "safety@2");
    await h.click("Edit latest version");
    await h.click("Publish new version");
    assert.equal(JSON.parse(h.posts()[1].body).revision, 19);
    assert.equal(JSON.parse(h.posts()[1].body).command.sheet.version, 2);
  } finally { await h.close(); }
});

test("set-default, archive and restore require confirmation; default family cannot be archived", async () => {
  const h = await harness();
  try {
    let current = snapshot({ sheets: [sheet(), sheet("battery")] });
    h.respond((url, options) => {
      if (!options.method) return reply(current);
      const { command } = JSON.parse(options.body);
      if (command.type === "default") current = { ...current, revision: current.revision + 1, defaultSheet: command.sheet };
      else if (command.type === "archive") current = { ...current, revision: current.revision + 1, archivedSheetIds: command.archived ? [command.sheetId] : [] };
      else assert.fail("Unexpected save");
      return reply(current);
    });
    await h.render();
    assert.equal(h.button("Archive definition").disabled, true);
    await act(async () => [...document.querySelectorAll("button")].find(node => node.textContent.startsWith("Battery inspection") && node.textContent.includes("v1")).click());
    await h.click("Set as default");
    assert.equal(h.posts().length, 0);
    await h.click("Confirm change");
    assert.equal(current.defaultSheet, "battery@1");
    await act(async () => [...document.querySelectorAll("button")].find(node => node.textContent.startsWith("Shop safety inspection")).click());
    await h.click("Archive definition");
    await h.click("Confirm change");
    assert.deepEqual(current.archivedSheetIds, ["safety"]);
    assert.match(document.body.textContent, /Archived definition/);
    assert.equal(current.sheets.length, 2, "Archive does not delete immutable definitions");
    await h.click("Restore definition");
    await h.click("Confirm change");
    assert.deepEqual(current.archivedSheetIds, []);
  } finally { await h.close(); }
});

test("server semantic-identity rejection is shown without deleting or rebasing the draft", async () => {
  const h = await harness();
  try {
    h.respond((url, options) => options.method ? reply({ error: "Procedure signature differs for shared measurement identity" }, 400) : reply(snapshot()));
    await h.render();
    await h.click("Edit latest version");
    await h.setValue("Procedure identity", "changed-procedure");
    await h.click("Publish new version");
    assert.match(document.body.textContent, /Procedure signature differs/);
    assert.equal(h.labelControl("Procedure identity").value, "changed-procedure");
    assert.equal(h.button("Publish new version").disabled, false);
    assert.equal(h.button("Retry exact save"), undefined, "A definitive 400 is not an ambiguous commit");
  } finally { await h.close(); }
});

test("select field options reject empty or duplicate choices before sending, preserving the draft", async () => {
  const h = await harness();
  try {
    await h.render();
    await h.click("Edit latest version");
    await h.setValue("Field type", "select");
    await h.click("Publish new version");
    assert.equal(h.posts().length, 0);
    assert.match(document.body.textContent, /select options must be nonempty and unique/);
    await h.setValue("Options (one per line, up to 30)", "Pass\nPass");
    await h.click("Publish new version");
    assert.equal(h.posts().length, 0);
    await h.setValue("Options (one per line, up to 30)", "Pass\nNeeds attention");
    await h.click("Publish new version");
    assert.equal(h.posts().length, 1);
    assert.deepEqual(JSON.parse(h.posts()[0].body).command.sheet.items[0].fields[0].options, ["Pass", "Needs attention"]);
  } finally { await h.close(); }
});

test("settings discovery is permission gated, available with admissions off and retryable on network errors", async () => {
  const h = await harness();
  try {
    h.respond(() => reply({ error: "Not entitled" }, 403));
    await h.render("SheetSettingsLink", { key: "denied" });
    assert.equal(document.querySelector("a"), null);
    h.respond(() => { throw Error("offline"); });
    await h.render("SheetSettingsLink", { key: "network" });
    assert.equal(document.querySelector("a"), null);
    h.respond(() => reply(snapshot({ inspectionEnabled: false, canManage: false })));
    await h.click("Retry checklist access");
    const link = document.querySelector("a");
    assert.ok(link);
    assert.equal(link.getAttribute("href"), "/dashboard/settings/dvi-sheets");
    assert.match(document.body.textContent, /Managing checklists does not change rollout/);
    assert.equal(h.posts().length, 0);
  } finally { await h.close(); }
});

test("explicit draft discard can unlock navigation when DVI permission was revoked", async () => {
  const h = await harness();
  try {
    const locks = [];
    await h.render("SheetManager", { onLockChange: value => locks.push(value) });
    await h.click("Edit latest version");
    assert.equal(locks.at(-1), true);
    h.respond(() => reply({ error: "Access revoked" }, 403));
    await h.click("Discard draft");
    assert.equal(locks.at(-1), false);
    assert.match(document.body.textContent, /Inspection sheets are not available/);
    assert.equal(h.posts().length, 0);
  } finally { await h.close(); }
});
