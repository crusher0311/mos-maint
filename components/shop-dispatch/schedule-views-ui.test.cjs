/* Offline browser UI integration. No application boot, live stores or external requests. */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const Module = require("node:module");
const { build } = require("esbuild");
const React = require("react");
const { act } = React;
const { JSDOM } = require("jsdom");

test("saved day views: union lanes, unrestricted work, editor preservation and exact uncertain retry", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://offline.invalid" });
  const names = ["window", "document", "navigator", "fetch", "IS_REACT_ACT_ENVIRONMENT"];
  const previous = Object.fromEntries(names.map(k => [k, Object.getOwnPropertyDescriptor(global, k)]));
  const originalNow = Date.now;
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(global, key, { value, configurable: true, writable: true });
  }
  Date.now = () => Date.parse("2030-06-03T08:00:00Z");
  dom.window.confirm = () => true;
  const { createRoot } = require("react-dom/client");
  const compiled = new Module(path.join(__dirname, "offline-views.cjs"), module);
  compiled.filename = path.join(__dirname, "offline-views.cjs"); compiled.paths = module.paths;
  const bundle = await build({
    entryPoints: [path.join(__dirname, "ScheduleCalendar.tsx")], bundle: true, write: false,
    platform: "node", format: "cjs", jsx: "automatic", external: ["react", "react-dom"],
    plugins: [{ name: "offline-css", setup(b) { b.onLoad({ filter: /\.module\.css$/ }, () => ({ contents: "export default new Proxy({}, {get: (_, key) => key})", loader: "js" })); } }],
  });
  compiled._compile(bundle.outputFiles[0].text, compiled.filename);
  const { ScheduleCalendar } = compiled.exports;
  const skill = (key, status) => ({ key, title: key, status, notes: "", reviewedAt: "2030-06-02T08:00:00Z", reviewedBy: "fixture-manager" });
  const job = (id, technicianId, plannedStart) => ({
    id, visitId: `visit-${id}`, title: `Work ${id}`, technicianId, plannedStart,
    estimatedMinutes: 45, bookMinutes: 62, prerequisites: [], resource: null, authorized: true,
    status: "idle", activeMs: 0, waitingMs: 0, since: null, pauseReason: null, sourceId: null, sourceRemoved: false,
  });
  let latest = {
    revision: 7, updatedAt: null, audit: [], receipts: [], locationBrand: null,
    technicians: [
      { id: "explicit", name: "Mara Ellis", active: true, email: "", skills: [] },
      { id: "confirmed", name: "Dev Patel", active: true, email: "", skills: [skill("diagnostics", "confirmed")] },
      { id: "hidden", name: "Rosa Chen", active: true, email: "", skills: [skill("diagnostics", "not-qualified")] },
      { id: "inactive", name: "Eli Martin", active: false, email: "", skills: [skill("diagnostics", "confirmed")] },
    ],
    visits: ["visible", "hidden", "queue"].map(id => ({ id: `visit-${id}`, ro: id === "hidden" ? "84217" : id, vehicle: "Fixture vehicle", closed: false })),
    jobs: [job("visible", "explicit", "2030-06-03T09:00:00Z"), job("hidden", "hidden", "2030-06-03T10:00:00Z"), job("queue", "hidden", null)],
    scheduleViews: { views: [{ id: "diagnostic-view", name: "Diagnostic handoffs", technicianIds: ["explicit", "inactive", "missing-tech"], skillKeys: ["diagnostics", "retired-skill"] }], selectedId: "diagnostic-view" },
  };
  let postMode = "success";
  const writes = [], reads = [], selectedVisits = [];
  Object.defineProperty(global, "fetch", { configurable: true, writable: true, value: async (url, options = {}) => {
    if (options.method === "POST") {
      assert.equal(url, "/api/shop-dispatch", "view commands use the dispatch mutation path");
      const request = JSON.parse(options.body); writes.push(options.body);
      assert.ok(request.requestId); assert.equal(request.revision, latest.revision);
      if (postMode === "uncertain") throw new Error("Offline fixture: reply lost");
      if (postMode === "conflict") return { ok: false, status: 409, json: async () => ({ error: "fixture conflict" }) };
      const command = request.command;
      const state = structuredClone(latest.scheduleViews);
      if (command.type === "selectScheduleView") state.selectedId = command.id;
      else if (command.type === "saveScheduleView") state.views = [...state.views.filter(v => v.id !== command.view.id), command.view];
      else if (command.type === "deleteScheduleView") {
        state.views = state.views.filter(v => v.id !== command.id);
        if (state.selectedId === command.id) state.selectedId = null;
      } else assert.fail(`Unexpected mutation ${command.type}`);
      latest = { ...latest, revision: latest.revision + 1, scheduleViews: state };
      return { ok: true, json: async () => ({ board: latest }) };
    }
    assert.ok(String(url).startsWith("/api/shop-dispatch/schedule?")); reads.push(String(url));
    return { ok: true, json: async () => ({ board: latest, availability: {
      revision: latest.revision, generatedAt: new Date(Date.now()).toISOString(), timeZone: "UTC",
      appointmentFetchedAt: null, available: false, reasons: [], warnings: [], slots: [], truncated: false,
    } }) };
  } });
  const root = createRoot(document.getElementById("root"));
  const find = id => document.querySelector(`[data-testid="${id}"]`);
  const click = async id => { assert.ok(find(id), id); await act(async () => find(id).click()); };
  const change = async (id, value) => {
    const node = find(id); assert.ok(node, id);
    await act(async () => {
      const prototype = node.tagName === "SELECT" ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value").set.call(node, value);
      node.dispatchEvent(new dom.window.Event(node.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    });
  };
  const submit = async id => { await act(async () => find(id).dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }))); };
  try {
    await act(async () => root.render(React.createElement(ScheduleCalendar, { board: latest, busy: false, refresh: async () => {}, select: id => selectedVisits.push(id) })));
    assert.ok(find("timeline-lane-explicit")); assert.ok(find("timeline-lane-confirmed"));
    assert.equal(find("timeline-lane-hidden"), null); assert.equal(find("timeline-lane-inactive"), null);
    assert.match(find("timeline-view-counts").textContent, /2 hidden lanes · 1 job on hidden lanes/);
    await click("timeline-mode-resource");
    assert.ok(find("timeline-lane-"), "saved technician views do not filter unassigned resource work");
    assert.ok(find("timeline-lane-rack"), "saved technician views do not filter configured resource lanes");
    assert.equal(find("timeline-hidden-jobs"), null);
    await click("timeline-mode-technician");
    assert.ok(find("timeline-queue-queue"), "queue is not lane-filtered");
    await change("timeline-search", "84217");
    assert.ok(find("timeline-hidden-jobs").open);
    await act(async () => find("timeline-hidden-job-hidden").querySelector("button").click());
    assert.match(find("timeline-details").textContent, /Work hidden/);
    assert.equal(find("timeline-plan-technician").querySelectorAll("option").length, 5, "planning keeps the full roster");
    await click("schedule-view-edit");
    assert.match(find("schedule-view-form").textContent, /Missing technician/);
    assert.match(find("schedule-view-form").textContent, /retired-skill.*stale selection/);
    assert.equal(find("schedule-view-technician-inactive").checked, true);
    await change("schedule-view-name", "Reviewed handoffs");
    postMode = "conflict";
    await submit("schedule-view-form");
    assert.equal(find("schedule-view-name").value, "Reviewed handoffs");
    assert.equal(find("schedule-view-save").disabled, true);
    latest = { ...latest, revision: latest.revision + 1 };
    await submit("schedule-search");
    assert.equal(find("schedule-view-save").disabled, true, "refresh alone never adopts the latest draft revision");
    await click("schedule-view-review"); postMode = "success";
    await submit("schedule-view-form");
    assert.equal(latest.scheduleViews.views[0].name, "Reviewed handoffs");
    assert.equal(find("schedule-view-form"), null);
    postMode = "uncertain";
    await change("schedule-view-select", "");
    assert.ok(find("schedule-retry")); assert.equal(find("schedule-view-select").disabled, true);
    const uncertainBody = writes.at(-1);
    postMode = "success"; await click("schedule-retry");
    assert.equal(writes.at(-1), uncertainBody, "unconfirmed view writes keep the identical request ID and revision");
    assert.equal(latest.scheduleViews.selectedId, null);
    assert.ok(find("timeline-lane-hidden")); assert.ok(find("timeline-lane-inactive"));
    await change("schedule-view-select", "diagnostic-view");
    await click("schedule-week");
    assert.ok(find("schedule-views").closest("[hidden]"), "day views stay mounted to preserve drafts, but are hidden in week mode"); assert.ok(find("schedule-job-hidden"), "week work is unrestricted");
    await submit("schedule-search");
    assert.equal(new URL(reads.at(-1), "http://offline.invalid").searchParams.has("scheduleViewId"), false);
    await click("schedule-day"); await click("schedule-view-delete");
    assert.equal(latest.scheduleViews.views.length, 0); assert.equal(latest.scheduleViews.selectedId, null);
    await click("schedule-view-create"); await change("schedule-view-name", "Mara lane");
    await submit("schedule-view-form");
    assert.match(find("schedule-view-error").textContent, /Choose at least one/);
    await click("schedule-view-technician-explicit"); await submit("schedule-view-form");
    assert.equal(latest.scheduleViews.views[0].name, "Mara lane");
    assert.deepEqual(latest.scheduleViews.views[0].technicianIds, ["explicit"]);
  } finally {
    await act(async () => root.unmount()); dom.window.close(); Date.now = originalNow;
    for (const key of names) { if (previous[key]) Object.defineProperty(global, key, previous[key]); else delete global[key]; }
  }
});
