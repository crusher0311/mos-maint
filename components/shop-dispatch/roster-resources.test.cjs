// Offline UI regression: in-memory bundle and synthetic data only; no server.
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const { test } = require("node:test");
const { build } = require("esbuild");
const React = require("react");
const { act } = React;
const { createRoot } = require("react-dom/client");
const { renderToStaticMarkup } = require("react-dom/server");
const { JSDOM } = require("jsdom");

test("optional logins, manager-reviewed imports and dynamic resource lanes", async () => {
  const bundle = await build({
    stdin: { contents: 'export {Management} from "./Management"; export {Timeline} from "./Timeline"; export {JobCard} from "./JobCard";',
      resolveDir: __dirname, loader: "tsx" },
    bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic",
    external: ["react", "react-dom", "zod"],
    plugins: [{ name: "offline-css", setup(build) {
      build.onLoad({ filter: /\.module\.css$/ }, () => ({ contents: "export default {}", loader: "js" }));
    } }],
  });
  const compiled = new Module(path.join(__dirname, "offline-fixture.cjs"), module);
  compiled.filename = path.join(__dirname, "offline-fixture.cjs");
  compiled.paths = module.paths;
  compiled._compile(bundle.outputFiles[0].text, compiled.filename);
  const { Management, Timeline, JobCard } = compiled.exports;
  const dom = new JSDOM("<div id='root'></div>", { url: "http://offline.invalid" });
  const previous = { window: global.window, document: global.document, fetch: global.fetch };
  global.window = dom.window; global.document = dom.window.document;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById("root"));
  const commands = [], requests = [];
  const board = {
    revision: 12, updatedAt: null, visits: [], jobs: [], receipts: [], audit: [], locationBrand: null,
    technicians: [{ id: "lift", name: "Marisol Vega", email: "", active: true }],
    resources: [{ id: "lift", name: "Two-post lift", active: true }, { id: "retired", name: "Old bay", active: false }],
  };
  const props = { board, actor: { manager: true, email: "manager@example.test", technicianId: null },
    now: Date.now(), busy: false, mutate: async (command, revision) => { commands.push({ command, revision }); return true; } };
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ truncated: true, employees: [
      { id: "provider-1", name: "Marisol Vega", active: true },
      { id: "provider-2", name: "Leon Park", active: false },
    ] }) };
  };
  const byTest = id => document.querySelector(`[data-testid="${id}"]`);
  const submit = async form => {
    // CommandForm uses browser FormData, not Node's fetch FormData.
    const previousFormData = global.FormData;
    global.FormData = dom.window.FormData;
    try { await act(async () => form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }))); }
    finally { global.FormData = previousFormData; }
  };
  try {
    await act(async () => root.render(React.createElement(Management, props)));
    assert.equal(requests.length, 0, "mount must not fetch provider roster");
    const create = byTest("technician-create-form");
    assert.equal(create.querySelector('[name="email"]').required, false);
    create.querySelector('[name="name"]').value = "Avery Chen";
    await submit(create);
    assert.equal(commands.at(-1).command.email, "");
    assert.equal(commands.at(-1).command.type, "technician");
    const edit = byTest("technician-form-lift");
    edit.querySelector('[name="email"]').value = "marisol@example.test";
    await submit(edit);
    assert.equal(commands.at(-1).command.id, "lift", "login linking keeps lane identity");
    assert.equal(commands.at(-1).revision, 12);
    await act(async () => byTest("roster-load").click());
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/api/shop-dispatch/roster");
    assert.equal(requests[0].options.credentials, "include");
    assert(document.body.textContent.includes("truncated"));
    assert(document.body.textContent.includes("Inactive upstream"));
    assert.equal(document.querySelectorAll('[name="reviewed"]:checked').length, 0);
    const review = byTest("roster-review-provider-1");
    const before = commands.length;
    await submit(review);
    assert.equal(commands.length, before, "unchecked review cannot save");
    review.querySelector('[name="reviewed"]').checked = true;
    review.querySelector('[name="technicianId"]').value = "lift";
    await submit(review);
    assert.deepEqual(commands.at(-1), { command: { type: "importTechnician", sourceId: "provider-1", id: "lift" }, revision: 12 });
    const resource = byTest("resource-form-lift");
    resource.querySelector('[name="name"]').value = "Lift bay 1";
    resource.querySelector('[name="active"]').checked = false;
    await submit(resource);
    assert.deepEqual(commands.at(-1), { command: { type: "resource", id: "lift", name: "Lift bay 1", active: false }, revision: 12 });
    const visit = { id: "visit", vehicle: "Test vehicle", ro: "18427", closed: false };
    const job = { id: "job", visitId: "visit", title: "Alignment", technicianId: "lift", resource: "retired",
      status: "idle", prerequisites: [], authorized: true, sourceRemoved: false, activeMs: 0,
      waitingMs: 0, since: null, plannedStart: null, estimatedMinutes: null, bookMinutes: null };
    const workBoard = { ...board, visits: [visit], jobs: [job] };
    const timeline = renderToStaticMarkup(React.createElement(Timeline, { board: workBoard, visits: [visit], now: props.now, select() {} }));
    assert(timeline.includes('data-testid="pilot-lane-lift"'));
    assert(timeline.includes('data-testid="pilot-lane-resource:lift"'));
    assert(timeline.includes('data-testid="pilot-lane-resource:retired"'), "inactive lane keeps history");
    const jobHtml = renderToStaticMarkup(React.createElement(JobCard, { ...props, board: workBoard, job }));
    assert(jobHtml.includes('value="retired" disabled="" selected=""'), "current inactive resource is visible but disabled");
    assert(jobHtml.includes("Old bay"));
    assert(!jobHtml.includes("Alignment rack"));
    await act(async () => root.render(React.createElement(Management, { ...props, actor: { ...props.actor, manager: false } })));
    assert.equal(byTest("roster-load"), null);
    assert(document.body.textContent.includes("Manager access required"));
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(global, previous);
    delete global.IS_REACT_ACT_ENVIRONMENT;
  }
});
