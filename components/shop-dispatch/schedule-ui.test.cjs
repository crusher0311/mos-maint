/* Offline only: every request is intercepted; no server, credentials or database. */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const Module = require("node:module");
const { build } = require("esbuild");
const React = require("react");
const { act } = React;
const { createRoot } = require("react-dom/client");
const { JSDOM } = require("jsdom");

test("manager schedule: bounded manual reads, complete work visibility, conflict-safe drafts and exact retry", async () => {
  const bundle = await build({
    entryPoints: [path.join(__dirname, "ScheduleCalendar.tsx")], bundle: true,
    write: false, platform: "node", format: "cjs", jsx: "automatic",
    external: ["react", "react-dom"],
    plugins: [{ name: "offline-css", setup(builder) {
      builder.onLoad({ filter: /\.module\.css$/ }, () => ({
        contents: "export default new Proxy({}, {get: (_, key) => key})", loader: "js",
      }));
    } }],
  });
  const compiled = new Module(path.join(__dirname, "offline-schedule.cjs"), module);
  compiled.filename = path.join(__dirname, "offline-schedule.cjs"); compiled.paths = module.paths;
  compiled._compile(bundle.outputFiles[0].text, compiled.filename);
  const { ScheduleCalendar, scheduleDate, shiftScheduleDate } = compiled.exports;
  assert.equal(scheduleDate("2026-03-09T01:00:00Z", "America/Chicago"), "2026-03-08");
  assert.equal(shiftScheduleDate("2026-03-07", 7), "2026-03-14");
  const dom = new JSDOM("<div id='root'></div>", { url: "http://offline.invalid" });
  const globals = ["window", "document", "fetch", "IS_REACT_ACT_ENVIRONMENT"];
  const previous = Object.fromEntries(globals.map(key => [key, global[key]]));
  Object.assign(global, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  dom.window.confirm = () => true;
  const today = scheduleDate(Date.now(), "America/Chicago");
  const settings = { enabled: false, timeZone: "America/Chicago", weekly: [], technicians: [], resources: [], bufferMinutes: 0, leadMinutes: 0 };
  const board = { revision: 17, technicians: [{ id: "tech-a", name: "Mara Holt", active: true }], resources: [], visits: [{ id: "visit-a", ro: "3084", closed: true }],
    jobs: [
      { id: "job-planned", visitId: "visit-a", title: "Completed hidden-status work", plannedStart: `${today}T15:00:00Z`, estimatedMinutes: 45, bookMinutes: 72, technicianId: "tech-a", resource: null, status: "completed" },
      { id: "job-queue", visitId: "visit-a", title: "Unplanned paused work", plannedStart: null, estimatedMinutes: null, bookMinutes: 25, technicianId: null, resource: null, status: "paused" },
    ], schedule: { settings, holds: [{ id: "hold-a", start: `${today}T15:00:00Z`, end: `${today}T16:00:00Z`, expiresAt: new Date(Date.now() + 3600000).toISOString(), technicianId: "tech-a", resourceId: null, releasedAt: null }] } };
  let latest = board, postMode = "conflict", refreshes = 0;
  const requests = [], selected = [];
  global.fetch = async (url, options = {}) => {
    assert.equal(options.credentials, "include");
    assert.ok(String(url).startsWith("/api/shop-dispatch/schedule"));
    requests.push({ url, options });
    if (options.method === "POST") {
      const command = JSON.parse(options.body);
      assert.deepEqual(Object.keys(command).sort(), (command.type === "settings" ? ["type", "requestId", "revision", "settings"] : ["type", "requestId", "revision", "holdId"]).sort());
      if (postMode === "conflict") return { ok: false, status: 409 };
      if (postMode === "uncertain") throw new Error("Simulated offline failure");
      latest = { ...latest, revision: latest.revision + 1, schedule: { ...latest.schedule, ...(command.type === "settings" ? { settings: command.settings } : { holds: latest.schedule.holds.map(h => ({ ...h, releasedAt: new Date().toISOString() })) }) } };
      return { ok: true, json: async () => ({ board: latest }) };
    }
    const query = new URL(String(url), "http://offline.invalid").searchParams;
    const span = (Date.parse(query.get("endDate")) - Date.parse(query.get("startDate"))) / 86400000;
    assert.ok(span === 1 || span === 7);
    const fetchedBoard = { ...latest, schedule: { ...latest.schedule, appointments: { startDate: query.get("startDate"), endDate: query.get("endDate"), fetchedAt: new Date().toISOString(), complete: false, appointments: [{ id: "appt-a", ro: "3085", title: "Arrival only", start: null, end: null, technicianSourceIds: [] }] } } };
    return { ok: true, json: async () => ({ board: fetchedBoard, availability: { revision: latest.revision, generatedAt: new Date().toISOString(), timeZone: "America/Chicago", appointmentFetchedAt: null, available: false, reasons: ["disabled"], warnings: ["Incomplete upstream appointments"], slots: [], truncated: false } }) };
  };
  const root = createRoot(document.getElementById("root"));
  const find = id => document.querySelector(`[data-testid="${id}"]`);
  const click = id => act(async () => find(id).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
  const submit = id => act(async () => find(id).dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
  try {
    await act(async () => root.render(React.createElement(ScheduleCalendar, { board, busy: false, refresh: async () => { refreshes++; }, select: id => selected.push(id) })));
    assert.equal(requests.length, 1);
    assert.ok(find("schedule-job-job-planned"));
    assert.ok(find("schedule-unplanned").textContent.includes("Unplanned paused work"));
    assert.match(find("schedule-appointment-appt-a").textContent, /Unknown arrival time/);
    assert.match(find("schedule-appointment-warning").textContent, /incomplete/);
    await click("schedule-job-job-planned");
    assert.deepEqual(selected, ["visit-a"]);
    await click("schedule-next"); await click("schedule-day");
    assert.equal(requests.length, 1, "navigation must not poll upstream");
    assert.ok(find("schedule-query-stale"));
    await submit("schedule-search");
    assert.equal(requests.length, 2);
    await click("schedule-settings-toggle");
    assert.equal(find("schedule-enabled").checked, false);
    const countBeforeValidation = requests.length;
    await click("schedule-enabled");
    await submit("schedule-settings");
    assert.equal(requests.length, countBeforeValidation, "enabling without explicit openings and technician shifts must not save");
    assert.match(find("schedule-settings").textContent, /Before enabling/);
    await click("schedule-enabled");
    await act(async () => Array.from(find("schedule-settings").querySelectorAll("button")).find(button => button.textContent === "Add opening").click());
    await submit("schedule-settings");
    assert.deepEqual(JSON.parse(requests.at(-1).options.body).settings.weekly, [{ day: 1, start: "09:00", end: "17:00" }]);
    assert.match(find("schedule-error").textContent, /Revision conflict/);
    assert.match(find("schedule-settings-revision").textContent, /base revision 17/);
    latest = { ...latest, revision: 19 };
    await submit("schedule-search");
    assert.match(find("schedule-settings-revision").textContent, /base revision 17 · latest 19/);
    assert.equal(find("schedule-settings").querySelectorAll('input[type="time"]').length, 2, "refresh preserves edited opening times");
    await click("schedule-settings-reload");
    assert.equal(find("schedule-settings").querySelectorAll('input[type="time"]').length, 0, "explicit reload discards edits");
    assert.match(find("schedule-settings-revision").textContent, /base revision 19/);
    postMode = "uncertain";
    await submit("schedule-settings");
    assert.ok(find("schedule-retry"));
    assert.equal(find("schedule-settings-save").closest("fieldset").disabled, true);
    const original = requests.at(-1).options.body;
    postMode = "success";
    await click("schedule-retry");
    assert.equal(requests.at(-1).options.body, original, "retry must preserve request ID, revision and settings");
    assert.equal(refreshes, 1);
    await click("schedule-release-hold-a");
    assert.equal(JSON.parse(requests.at(-1).options.body).type, "release");
    assert.equal(refreshes, 2);
    assert.match(find("schedule-hold-hold-a").textContent, /Released/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const key of globals) { if (previous[key] === undefined) delete global[key]; else global[key] = previous[key]; }
  }
});
