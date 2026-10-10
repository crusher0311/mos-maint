// Synthetic roster responses only: no server, provider, or database calls.
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const { test } = require("node:test");
const { build } = require("esbuild");
const React = require("react");
const { act } = React;
const { createRoot } = require("react-dom/client");
const { JSDOM } = require("jsdom");

test("historical recency groups remain reviewable, provider order is unchanged, and optional fields are validated", async () => {
  const bundle = await build({
    stdin: { contents: 'export {RosterImport} from "./RosterImport";', resolveDir: __dirname, loader: "tsx" },
    bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic",
    external: ["react", "react-dom", "zod"],
    plugins: [{ name: "offline-css", setup(build) {
      build.onLoad({ filter: /\.module\.css$/ }, () => ({
        contents: 'export default new Proxy({}, {get: (_, key) => key})', loader: "js",
      }));
    } }],
  });
  const compiled = new Module(path.join(__dirname, "offline-recency-fixture.cjs"), module);
  compiled.filename = path.join(__dirname, "offline-recency-fixture.cjs");
  compiled.paths = module.paths;
  compiled._compile(bundle.outputFiles[0].text, compiled.filename);
  const { RosterImport } = compiled.exports;
  const dom = new JSDOM("<div id='root'></div>", { url: "http://offline.invalid" });
  const previous = {
    window: global.window, document: global.document, fetch: global.fetch,
    FormData: global.FormData, IS_REACT_ACT_ENVIRONMENT: global.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(global, { window: dom.window, document: dom.window.document,
    FormData: dom.window.FormData, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.getElementById("root"));
  const commands = [];
  let requests = 0;
  const old = { id: "old", name: "Leon Park", active: true, lastSeenAt: "2024-02-12T12:00:00Z", recentActivity: false };
  const recent = { id: "recent", name: "Marisol Vega", active: true, lastSeenAt: "2026-07-10T00:00:00Z", recentActivity: true };
  const unknown = { id: "unknown", name: "Avery Chen", active: true, lastSeenAt: null };
  let response = { source: "history", truncated: false, employees: [old, recent, unknown] };
  global.fetch = async () => { requests++; return { ok: true, json: async () => response }; };
  const board = { revision: 17, technicians: [
    { id: "existing", sourceId: "old", name: "Leon Park", email: "", active: true },
  ] };
  const byTest = id => document.querySelector(`[data-testid="${id}"]`);
  const load = async () => act(async () => byTest("roster-load").click());
  const order = () => [...document.querySelectorAll("form")].map(form => form.dataset.testid);
  try {
    await act(async () => root.render(React.createElement(RosterImport, {
      board, busy: false, mutate: async (command, revision) => { commands.push({ command, revision }); return true; },
    })));
    assert.equal(requests, 0);
    await load();
    assert.deepEqual(order(), ["roster-review-recent", "roster-review-old", "roster-review-unknown"]);
    const past = document.querySelector('section[aria-label="Possible past employees"]');
    assert(past.contains(byTest("roster-review-old")));
    assert(past.contains(byTest("roster-review-unknown")));
    assert(!past.contains(byTest("roster-review-recent")));
    assert(document.body.textContent.includes("Last seen: Feb 12, 2024"));
    assert(document.body.textContent.includes("Last seen: unknown"));
    assert(document.body.textContent.includes("archive coverage, not proof of employment"));
    assert(document.body.textContent.includes("leave or loan cases"));
    assert.equal(document.querySelectorAll('[name="reviewed"]:checked').length, 0);
    const review = byTest("roster-review-old");
    assert.equal(review.querySelector('[name="technicianId"]').value, "existing");
    const submit = () => act(async () => review.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
    await submit();
    assert.equal(commands.length, 0);
    await act(async () => review.querySelector('[name="reviewed"]').click());
    await submit();
    assert.deepEqual(commands, [{ command: { type: "importTechnician", sourceId: "old", id: "existing" }, revision: undefined }]);
    const nextReview = byTest("roster-review-recent");
    await act(async () => nextReview.querySelector('[name="reviewed"]').click());
    await act(async () => nextReview.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
    assert.equal(commands.length, 2, "another roster candidate can save without a pinned board revision");
    assert.equal(commands[1].revision, undefined, "mutate must choose the latest loaded snapshot revision");

    response = { source: "provider", truncated: false, employees: [old, recent, unknown] };
    await load();
    assert.deepEqual(order(), ["roster-review-old", "roster-review-recent", "roster-review-unknown"]);
    assert.equal(document.querySelector('section[aria-label="Possible past employees"]'), null);
    assert(!document.body.textContent.includes("Last seen:"));
    for (const fields of [
      { recentActivity: "true" }, { recentActivity: null }, { lastSeenAt: 7 }, { lastSeenAt: "not-a-date" },
    ]) {
      response = { source: "history", truncated: false, employees: [{ ...recent, ...fields }] };
      await load();
      const error = document.querySelector('[role="alert"]');
      assert(error.textContent.includes("response was invalid"));
      assert.equal(error.className, "error");
      assert.equal(document.querySelector("form"), null, "invalid reload must not expose stale review forms");
    }
    response = { source: "history", truncated: false, employees: [{ id: "legacy", name: "Samira Cole", active: true }] };
    await load();
    assert.equal(document.querySelector('[role="alert"]'), null);
    assert(document.querySelector('section[aria-label="Possible past employees"]').contains(byTest("roster-review-legacy")));
    assert.equal(document.querySelector('[name="reviewed"]').checked, false);
    assert.equal(commands.length, 2);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(global, previous);
  }
});
