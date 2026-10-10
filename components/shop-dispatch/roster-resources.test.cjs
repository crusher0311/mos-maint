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
    return { ok: true, json: async () => ({ source: "provider", truncated: true, employees: [
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
    assert.deepEqual(commands.at(-1), { command: { type: "importTechnician", sourceId: "provider-1", id: "lift" }, revision: undefined });
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

test("historical roster candidates require explicit review and never imply current employment", async () => {
  const bundle = await build({
    stdin: { contents: 'export {RosterImport} from "./RosterImport";', resolveDir: __dirname, loader: "tsx" },
    bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic",
    external: ["react", "react-dom", "zod"],
    plugins: [{ name: "offline-css", setup(build) {
      build.onLoad({ filter: /\.module\.css$/ }, () => ({ contents: "export default {}", loader: "js" }));
    } }],
  });
  const compiled = new Module(path.join(__dirname, "offline-roster-fixture.cjs"), module);
  compiled.filename = path.join(__dirname, "offline-roster-fixture.cjs");
  compiled.paths = module.paths;
  compiled._compile(bundle.outputFiles[0].text, compiled.filename);
  const { RosterImport } = compiled.exports;
  const dom = new JSDOM("<div id='root'></div>", { url: "http://offline.invalid" });
  const previous = {
    window: global.window, document: global.document, fetch: global.fetch,
    FormData: global.FormData, IS_REACT_ACT_ENVIRONMENT: global.IS_REACT_ACT_ENVIRONMENT,
  };
  global.window = dom.window; global.document = dom.window.document;
  global.FormData = dom.window.FormData;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById("root"));
  const commands = [];
  let requests = 0;
  let response = {
    source: "history", truncated: false, warning: "The current provider employee list is unavailable.",
    employees: [
      { id: "historical-1", name: "Leon Park", active: true, historical: true },
      { id: "historical-2", name: "Avery Chen", active: true },
    ],
  };
  global.fetch = async () => {
    requests++;
    return { ok: true, json: async () => response };
  };
  const board = {
    revision: 17, updatedAt: null, visits: [], jobs: [], receipts: [], audit: [], locationBrand: null,
    technicians: [{ id: "existing-lane", sourceId: "historical-1", name: "Leon Park", email: "leon@example.test", active: true }],
    resources: [],
  };
  const byTest = id => document.querySelector(`[data-testid="${id}"]`);
  const submit = async form => {
    await act(async () => form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
  };
  try {
    await act(async () => root.render(React.createElement(RosterImport, {
      board, busy: false, mutate: async (command, revision) => { commands.push({ command, revision }); return true; },
    })));
    assert.equal(requests, 0, "historical candidates are never fetched automatically");
    await act(async () => byTest("roster-load").click());
    assert.equal(requests, 1);
    assert(document.body.textContent.includes("Fallback repair-order history may include former employees"));
    assert(document.body.textContent.includes(response.warning));
    assert.equal(document.body.textContent.split("Historical · current status unknown").length - 1, 2,
      "history source labels all candidates even without the optional employee flag");
    assert(!document.body.textContent.includes("Active upstream"), "active means local selectability for history");
    assert.equal(document.querySelectorAll('[name="reviewed"]:checked').length, 0);
    assert(document.body.textContent.includes("No MOS accounts are created"));
    const review = byTest("roster-review-historical-1");
    assert.equal(review.querySelector('[name="technicianId"]').value, "existing-lane");
    assert(review.parentElement.textContent.includes("Existing login and assignments are preserved"));
    assert.equal(review.querySelector('[name="email"]'), null);
    await submit(review);
    assert.equal(commands.length, 0, "unchecked historical review cannot save");
    await act(async () => review.querySelector('[name="reviewed"]').click());
    assert.equal(commands.length, 0, "checking review alone never imports a candidate");
    await submit(review);
    assert.deepEqual(commands, [{
      command: { type: "importTechnician", sourceId: "historical-1", id: "existing-lane" }, revision: undefined,
    }]);

    response = {
      source: "provider", truncated: false, employees: [
        { id: "flagged-history", name: "Marisol Vega", active: true, historical: true },
        { id: "current", name: "Nico Reyes", active: true, historical: false },
        { id: "inactive", name: "Samira Cole", active: false },
      ],
    };
    await act(async () => byTest("roster-load").click());
    assert(byTest("roster-review-flagged-history").parentElement.textContent.includes("Historical · current status unknown"));
    assert(byTest("roster-review-current").parentElement.textContent.includes("Active upstream"));
    assert(byTest("roster-review-inactive").parentElement.textContent.includes("Inactive upstream"));
    assert(document.body.textContent.includes("Fallback repair-order history may include former employees"));
    assert(!document.body.textContent.includes("The current provider employee list is unavailable."),
      "a new response clears the previous warning");
    assert.equal(document.querySelectorAll('[name="reviewed"]:checked').length, 0);

    for (const invalid of [
      { ...response, source: "unknown" },
      { ...response, warning: 7 },
      { ...response, employees: [{ id: "bad", name: "Invalid", active: true, historical: "yes" }] },
    ]) {
      response = invalid;
      await act(async () => byTest("roster-load").click());
      assert(document.querySelector('[role="alert"]').textContent.includes("response was invalid"));
      assert.equal(commands.length, 1, "invalid responses never save a technician");
    }
    response = { source: "history", truncated: false, employees: [] };
    await act(async () => byTest("roster-load").click());
    assert.equal(document.querySelector('[role="alert"]'), null, "retry recovers from invalid response");
    assert(document.body.textContent.includes("No provider staff returned"));
    assert(document.body.textContent.includes("Fallback repair-order history may include former employees"));
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(global, previous);
  }
});
