// Offline React regression: synthetic boards only; all network access is forbidden.
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const { test } = require("node:test");
const { build } = require("esbuild");
const React = require("react");
const { act } = React;
const { createRoot } = require("react-dom/client");
const { JSDOM } = require("jsdom");

let components;
async function harness() {
  if (!components) {
    const bundle = await build({
      stdin: { contents: 'export {JobReadiness} from "./JobReadiness"; export {OperationsPanel} from "./OperationsPanel";', resolveDir: __dirname, loader: "tsx" },
      bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic",
      external: ["react", "react-dom", "zod"],
      plugins: [{ name: "offline-css", setup(builder) {
        builder.onLoad({ filter: /\.module\.css$/ }, () => ({ contents: "export default new Proxy({}, {get: (_, key) => key})", loader: "js" }));
      } }],
    });
    const compiled = new Module(path.join(__dirname, "offline-operations.cjs"), module);
    compiled.filename = path.join(__dirname, "offline-operations.cjs");
    compiled.paths = module.paths;
    compiled._compile(bundle.outputFiles[0].text, compiled.filename);
    components = compiled.exports;
  }
  const dom = new JSDOM("<div id='root'></div>", { url: "http://offline.invalid" });
  const keys = ["window", "document", "FormData", "IS_REACT_ACT_ENVIRONMENT", "fetch"];
  const previous = Object.fromEntries(keys.map(key => [key, global[key]]));
  Object.assign(global, { window: dom.window, document: dom.window.document, FormData: dom.window.FormData, IS_REACT_ACT_ENVIRONMENT: true, fetch: () => { throw new Error("Network forbidden"); } });
  dom.window.confirm = () => true;
  const root = createRoot(document.getElementById("root"));
  const calls = [];
  const now = Date.parse("2026-03-16T14:00:00.000Z");
  const operations = {
    reviewedAt: "2026-03-16T12:00:00.000Z", reviewedBy: "mara@shop.test",
    parts: "received", diagnostics: "ready", requiredSkills: ["alignment"],
    blockers: [{ id: "hold", reason: "Verify torque spec", owner: "Mara", resolved: false, openedAt: "2026-03-16T12:30:00.000Z", resolvedAt: null }],
    checks: [{ id: "road", label: "Road test", completedAt: null, completedBy: null }],
    handoff: { note: "Check steering center after alignment.", by: "mara@shop.test", at: "2026-03-16T13:00:00.000Z", acknowledgedAt: null, acknowledgedBy: null },
  };
  const job = { id: "align", visitId: "visit", title: "Wheel alignment", technicianId: "tech", status: "idle", prerequisites: [], estimatedMinutes: 37, bookMinutes: 42, resource: null, authorized: true, plannedStart: null, sourceRemoved: false, sourceId: null, activeMs: 0, waitingMs: 0, since: null, pauseReason: null, operations };
  const board = { revision: 12, updatedAt: null, jobs: [job, { ...job, id: "repair", title: "Replace tie rod", operations: undefined }], visits: [{ id: "visit", ro: "4827", vehicle: "2018 Mazda CX-5", closed: false, promiseAt: "2026-03-16T16:00:00.000Z", transport: { customerPlan: "waiting" } }], technicians: [{ id: "tech", active: true, name: "Leon Park", skills: [{ key: "alignment", status: "confirmed" }] }], audit: [], receipts: [], locationBrand: null };
  const props = { board, job, actor: { email: "mara@shop.test", manager: true, technicianId: null }, now, busy: false, mutate: async (command, revision) => { calls.push({ command, revision }); return true; } };
  const render = async (component, values = {}) => act(async () => root.render(React.createElement(components[component], { ...props, ...values })));
  const form = id => document.querySelector(`[data-testid="${id}"]`);
  const submit = id => act(async () => form(id).dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
  const button = label => [...document.querySelectorAll("button")].find(node => node.textContent === label);
  const click = label => act(async () => button(label).click());
  const close = async () => {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(global, previous);
  };
  return { ...props, calls, render, form, submit, button, click, close };
}

test("readiness uses normal owned forms, explicit CRUD, pinned revisions, red errors and explicit reload", async () => {
  const h = await harness();
  try {
    await h.render("JobReadiness", { mutate: async (command, revision) => { h.calls.push({ command, revision }); return false; } });
    assert.match(document.body.textContent, /Gate off/);
    assert.match(document.body.textContent, /Owner: Mara · 1h 30m open/);
    assert.match(document.body.textContent, /2026-03-16T12:30:00.000Z/);
    assert.equal(document.querySelector('[name="owner-hold"]').required, true);
    await h.click("Add owned blocker");
    await h.click("Add required skill");
    await h.click("Add final check");
    const owners = document.querySelectorAll('[name^="owner-"]');
    const reasons = document.querySelectorAll('[name^="reason-"]');
    owners[1].value = "Leon";
    reasons[1].value = "Confirm replacement part";
    document.querySelectorAll('[name^="skill-"]')[1].value = "steering";
    document.querySelectorAll('[name^="check-"]')[1].value = "Steering centered";
    document.querySelector('[name="resolved-hold"]').checked = true;
    document.querySelector('[name="parts"]').value = "partial";
    await h.submit("readiness-form-align");
    const first = h.calls[0];
    assert.equal(first.revision, 12);
    assert.equal(first.command.readiness.parts, "partial");
    assert.equal(first.command.readiness.blockers[0].resolved, true);
    assert.equal(first.command.readiness.blockers[1].owner, "Leon");
    assert.deepEqual(first.command.readiness.requiredSkills, ["alignment", "steering"]);
    assert.equal(first.command.readiness.checks.length, 2);
    assert.equal(h.form("readiness-form-align").querySelector('[role="alert"]').className, "error");
    await h.render("JobReadiness", { board: { ...h.board, revision: 19 }, mutate: async (command, revision) => { h.calls.push({ command, revision }); return false; } });
    await h.submit("readiness-form-align");
    assert.equal(h.calls[1].revision, 12, "refresh cannot rebase a draft");
    assert.equal(document.querySelector('[name="parts"]').value, "partial");
    await h.click("Remove blocker 2");
    await h.click("Remove skill 2");
    await h.click("Remove final check 2");
    assert.equal(document.querySelectorAll('[name^="owner-"]').length, 1);
    await act(async () => document.querySelector('[data-testid="readiness-form-align-reload"]').click());
    assert.equal(document.querySelector('[name="parts"]').value, "received");
    await h.submit("readiness-form-align");
    assert.equal(h.calls.at(-1).revision, 19);
  } finally { await h.close(); }
});

test("handoff and quality respect actor/status/closure; confirmed dependencies preserve the saved plan", async () => {
  const h = await harness();
  try {
    await h.render("JobReadiness");
    assert.equal(h.calls.length, 0, "suggestions never auto-apply");
    await h.submit("dependency-form-align-repair");
    assert.deepEqual(h.calls[0], { revision: 12, command: { type: "plan", jobId: "align", technicianId: "tech", plannedStart: null, estimatedMinutes: 37, resource: null, authorized: true, prerequisites: ["repair"] } });
    await h.submit("handoff-form-align");
    assert.equal(h.calls.at(-1).command.type, "handoff");
    assert.equal(h.calls.at(-1).revision, 12);
    await h.submit("acknowledge-form-align");
    assert.equal(h.calls.at(-1).command.type, "acknowledgeHandoff");
    assert.equal(h.form("quality-form-align-road").querySelector("fieldset").disabled, true, "idle checks cannot be marked done");
    await h.render("JobReadiness", { actor: { email: "leon@shop.test", manager: false, technicianId: "tech" }, job: { ...h.job, status: "active" } });
    assert.equal(h.form("readiness-form-align"), null);
    await h.submit("quality-form-align-road");
    assert.deepEqual(h.calls.at(-1), { revision: 12, command: { type: "quality", jobId: "align", checkId: "road", done: true } });
    await h.render("JobReadiness", { job: { ...h.job, status: "completed" } });
    assert.equal(h.form("handoff-form-align"), null);
    assert.equal(h.form("readiness-form-align"), null);
    assert(h.form("quality-form-align-road"));
    const checked = { ...h.job, status: "completed", operations: { ...h.job.operations, checks: [{ ...h.job.operations.checks[0], completedAt: "2026-03-16T13:50:00.000Z", completedBy: "Leon" }] } };
    await h.render("JobReadiness", { job: checked });
    await h.submit("quality-form-align-road");
    assert.equal(h.calls.at(-1).command.done, false);
    await h.render("JobReadiness", { board: { ...h.board, visits: [{ ...h.board.visits[0], closed: true }] } });
    assert.equal(document.querySelectorAll("form").length, 0);
    await h.render("JobReadiness", { actor: { email: "other@shop.test", manager: false, technicianId: "other" } });
    assert.equal(document.querySelectorAll("form").length, 0);
  } finally { await h.close(); }
});

test("manager operations is opt-in, navigable and explicit about lower bounds and recommendation setup", async () => {
  const h = await harness();
  const selections = [];
  try {
    await h.render("OperationsPanel", { select: (...args) => selections.push(args) });
    assert.equal(document.querySelector('[name="enabled"]').checked, false);
    assert.match(document.body.textContent, /Dependency-only LOWER BOUND — not a full completion forecast/);
    assert.match(document.body.textContent, /fresh appointment snapshot/);
    assert.match(document.body.textContent, /configured technician shifts/);
    await h.click("RO 4827 · Wheel alignment · Open job");
    assert.deepEqual(selections[0], ["visit", "align"]);
    document.querySelector('[name="enabled"]').checked = true;
    await h.submit("operations-mode-form");
    assert.deepEqual(h.calls[0], { revision: 12, command: { type: "operationsMode", enabled: true } });
    await h.render("OperationsPanel", { actor: { manager: false, technicianId: "tech" }, select: () => {} });
    assert.equal(document.querySelector('[data-testid="operations-panel"]'), null);
  } finally { await h.close(); }
});

test("next work uses scheduler evidence, explains recommendations, and opens jobs without assigning", async () => {
  const h = await harness();
  const selections = [];
  try {
    const weekly = [{ day: 1, start: "07:00", end: "18:00" }, { day: 2, start: "07:00", end: "18:00" }];
    const job = { ...h.job, operations: { ...h.job.operations, blockers: [], handoff: undefined } };
    const board = { ...h.board, jobs: [job], operationsEnabled: true, schedule: {
      holds: [],
      settings: { enabled: true, timeZone: "UTC", weekly, technicians: [{ id: "tech", weekly, timeOff: [] }], resources: [], bufferMinutes: 0, leadMinutes: 0 },
      appointments: { startDate: "2026-03-16", endDate: "2026-03-17", fetchedAt: new Date(h.now).toISOString(), complete: true, appointments: [] },
    } };
    await h.render("OperationsPanel", { board, select: (...args) => selections.push(args) });
    const select = document.querySelector("select");
    await act(async () => {
      select.value = "tech";
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    assert.match(document.body.textContent, /Required skills confirmed/);
    assert.match(document.body.textContent, /Configured shift, time off and known lane reservations checked/);
    await h.click("Review job · no automatic assignment");
    assert.deepEqual(selections[0], ["visit", "align"]);
    assert.equal(h.calls.length, 0);
    await h.render("OperationsPanel", { board: { ...board, schedule: { ...board.schedule, appointments: { ...board.schedule.appointments, complete: false } } }, select: () => {} });
    assert.match(document.body.textContent, /No eligible recommendations/);
    assert.equal(h.button("Review job · no automatic assignment"), undefined);
    await h.render("OperationsPanel", { board: { ...board, schedule: undefined }, select: () => {} });
    assert.match(document.body.textContent, /No eligible recommendations/);
  } finally { await h.close(); }
});
