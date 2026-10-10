// Offline regression: synthetic fixtures, in-memory bundle, no provider calls.
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const { test } = require("node:test");
const { build } = require("esbuild");
const React = require("react");
const { act } = React;
const { createRoot } = require("react-dom/client");
const { JSDOM } = require("jsdom");

test("Protractor assignments remain read-only until an explicit dispatch-plan choice", async () => {
  const bundle = await build({
    stdin: { contents: 'export {JobCard} from "./JobCard";', resolveDir: __dirname, loader: "tsx" },
    bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic",
    external: ["react", "react-dom", "zod"],
    plugins: [{ name: "offline-css", setup(build) {
      build.onLoad({ filter: /\.module\.css$/ }, () => ({ contents: "export default {}", loader: "js" }));
    } }],
  });
  const compiled = new Module(path.join(__dirname, "offline-job-card.cjs"), module);
  compiled.filename = path.join(__dirname, "offline-job-card.cjs");
  compiled.paths = module.paths;
  compiled._compile(bundle.outputFiles[0].text, compiled.filename);
  const { JobCard } = compiled.exports;
  const dom = new JSDOM("<div id='root'></div>", { url: "http://offline.invalid" });
  const keys = ["window", "document", "FormData", "HTMLSelectElement", "IS_REACT_ACT_ENVIRONMENT", "fetch"];
  const previous = Object.fromEntries(keys.map(key => [key, global[key]]));
  Object.assign(global, {
    window: dom.window, document: dom.window.document, FormData: dom.window.FormData,
    HTMLSelectElement: dom.window.HTMLSelectElement, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: () => { throw new Error("Network is forbidden in this offline test"); },
  });
  const root = createRoot(document.getElementById("root"));
  const commands = [];
  const technicians = [
    { id: "local", name: "Marisol Vega", active: true, email: "" },
    { id: "matched", name: "Leon Park", sourceId: "PROVIDER-LEON", active: true, email: "" },
  ];
  const base = {
    id: "alignment", visitId: "visit", title: "Alignment", technicianId: "local", resource: null,
    status: "idle", prerequisites: [], authorized: true, sourceRemoved: false, activeMs: 120000,
    waitingMs: 0, since: null, plannedStart: null, estimatedMinutes: 35, bookMinutes: 48,
    sourceId: "package", sourceTechnicians: [{ sourceId: "provider-leon", name: "Leon Park" }],
  };
  const props = {
    actor: { manager: true, email: "manager@example.test", technicianId: null },
    now: 0, busy: false, mutate: async (command, revision) => { commands.push({ command, revision }); return true; },
  };
  let version = 0;
  const render = async (job = base, roster = technicians, overrides = {}) => {
    const board = {
      revision: 12, updatedAt: null, jobs: [job], visits: [{ id: "visit", closed: false }],
      technicians: roster, resources: [], audit: [], receipts: [], locationBrand: null,
    };
    await act(async () => root.render(React.createElement(JobCard, { ...props, ...overrides, key: ++version, board, job })));
  };
  const choice = () => document.querySelector('[data-testid="select-protractor-technician-alignment"]');
  const select = () => document.querySelector('select[name="technicianId"]');
  const assignment = () => document.querySelector('[data-testid="protractor-assignment-alignment"]').textContent;
  try {
    await render();
    assert.match(assignment(), /Protractor assignment.*read-only/);
    assert.match(assignment(), /Leon Park.*Active dispatch roster match: Leon Park/);
    assert.equal(select().value, "local", "mount preserves the local owner");
    assert.equal(commands.length, 0);
    assert.match(document.body.textContent, /Actual active work/);
    assert.match(document.body.textContent, /Manual estimate/);
    assert.match(document.body.textContent, /Book time · upstream/);
    document.querySelector('[name="estimatedMinutes"]').value = "42";
    await act(async () => choice().click());
    assert.equal(select().value, "matched");
    assert.equal(commands.length, 0, "choosing the upstream technician only changes the draft");
    assert.equal(base.technicianId, "local");
    await act(async () => document.querySelector('[data-testid="plan-form-alignment"]').dispatchEvent(
      new dom.window.Event("submit", { bubbles: true, cancelable: true })));
    assert.equal(commands.length, 1);
    assert.equal(commands[0].revision, 12);
    assert.equal(commands[0].command.technicianId, "matched");
    assert.equal(commands[0].command.estimatedMinutes, 42, "other draft edits are preserved");

    for (const [sourceTechnicians, roster] of [
      [[{ sourceId: "different", name: "Leon Park" }], technicians],
      [[{ sourceId: null, name: "Leon Park" }], technicians],
      [base.sourceTechnicians, technicians.map(t => t.id === "matched" ? { ...t, active: false } : t)],
      [base.sourceTechnicians, [...technicians, { ...technicians[1], id: "duplicate" }]],
      [[{ sourceId: "private-provider-id", name: " " }], technicians],
    ]) {
      await render({ ...base, sourceTechnicians }, roster);
      assert.equal(choice(), null, "missing, inactive, and ambiguous identities cannot be selected");
      assert.match(assignment(), /Roster review needed/);
      assert.equal(select().value, "local");
      assert(!assignment().includes("private-provider-id"), "never display source IDs as names");
    }
    assert.match(assignment(), /Unnamed Protractor technician/);
    await render({ ...base, sourceTechnicians: [...base.sourceTechnicians, { sourceId: null, name: "Avery Chen" }] });
    assert.match(assignment(), /Leon Park/);
    assert.match(assignment(), /Avery Chen/);
    assert.match(assignment(), /Choose the dispatch owner manually/);
    assert.equal(choice(), null, "multiple upstream technicians never imply an owner");
    assert.equal(select().value, "local");
    await render({ ...base, sourceTechnicians: undefined });
    assert.match(assignment(), /No technician reported/);
    assert.equal(choice(), null);
    await render(base, technicians, { busy: true });
    assert(choice().closest("fieldset").disabled, "busy forms disable upstream selection");
    await render({ ...base, status: "active" });
    assert.equal(choice(), null, "active plan remains locked");
    await render({ ...base, status: "completed" });
    assert.equal(choice(), null, "completed plan remains locked");
    await render(base, technicians, { actor: { ...props.actor, manager: false } });
    assert.match(assignment(), /Leon Park/, "read-only upstream assignment is visible to technicians");
    assert.equal(choice(), null);
    assert.equal(commands.length, 1, "renders and upstream changes never mutate assignments");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(global, previous);
  }
});
