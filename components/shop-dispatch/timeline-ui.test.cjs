/* Offline UI integration: intercepted fetch only; never boots an application or contacts a store. */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const Module = require("node:module");
const { build } = require("esbuild");
const React = require("react");
const { act } = React;
const { JSDOM } = require("jsdom");

test("timeline: genuine drop, move, pointer resize, manual fallback and exact uncertain-write retry", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://offline.invalid" });
  const names = ["window", "document", "navigator", "fetch", "IS_REACT_ACT_ENVIRONMENT"];
  const previous = Object.fromEntries(names.map(k => [k, Object.getOwnPropertyDescriptor(global, k)]));
  const originalNow = Date.now;
  for (const [k, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(global, k, { value, configurable: true, writable: true });
  Date.now = () => Date.parse("2030-06-03T08:00:00Z");
  const { createRoot } = require("react-dom/client");
  const bundled = await build({
    entryPoints: [path.join(__dirname, "ScheduleCalendar.tsx")], bundle: true, write: false,
    platform: "node", format: "cjs", jsx: "automatic", external: ["react", "react-dom"],
    plugins: [{ name: "offline-css", setup(b) { b.onLoad({ filter: /\.module\.css$/ }, () => ({ contents: "export default new Proxy({}, {get: (_, key) => key})", loader: "js" })); } }],
  });
  const compiled = new Module(path.join(__dirname, "offline-timeline.cjs"), module);
  compiled.filename = path.join(__dirname, "offline-timeline.cjs"); compiled.paths = module.paths;
  compiled._compile(bundled.outputFiles[0].text, compiled.filename);
  const { ScheduleCalendar } = compiled.exports;
  const weekly = Array.from({ length: 7 }, (_, day) => ({ day, start: "08:00", end: "18:00" }));
  const job = (id, extra = {}) => ({ id, visitId: "visit-local", title: `Job ${id}`, technicianId: null, plannedStart: null, estimatedMinutes: 60, bookMinutes: 87, prerequisites: [], resource: "bay-local", authorized: false, status: "idle", activeMs: 0, waitingMs: 0, since: null, pauseReason: null, sourceId: null, sourceRemoved: false, ...extra });
  let latest = {
    revision: 21, updatedAt: null, audit: [], receipts: [], locationBrand: null,
    technicians: ["a", "b", "c"].map(id => ({ id, name: `Technician ${id.toUpperCase()}`, email: "", active: true })),
    resources: [{ id: "bay-local", name: "Test bay", active: true }],
    visits: [{ id: "visit-local", ro: "TEST-731", vehicle: "Offline fixture vehicle", closed: false }],
    jobs: [job("queued", { estimatedMinutes: null, prerequisites: ["finished"] }), job("book-scheduled", { estimatedMinutes: null, bookMinutes: 45, technicianId: "a", plannedStart: "2030-06-03T15:00:00Z", resource: null }), job("unknown", { estimatedMinutes: null, bookMinutes: null, resource: null }), job("zero", { estimatedMinutes: null, bookMinutes: 0, resource: null }), job("removed", { sourceRemoved: true, resource: null }), job("blocked", { resource: null }), job("active", { technicianId: "c", resource: null, plannedStart: "2030-06-03T10:00:00Z", status: "active" }), job("finished", { technicianId: "c", plannedStart: "2030-06-03T09:00:00Z", status: "completed" })],
    schedule: { settings: { enabled: true, timeZone: "UTC", weekly, technicians: ["a", "b", "c"].map(id => ({ id, weekly, timeOff: [] })), resources: [], bufferMinutes: 0, leadMinutes: 0 }, holds: [{ id: "fixture-hold", start: "2030-06-03T16:00:00Z", end: "2030-06-03T17:00:00Z", expiresAt: "2030-06-03T20:00:00Z", technicianId: "b", resourceId: null, releasedAt: null }],
      appointments: { complete: true, fetchedAt: "2030-06-03T08:00:00Z", startDate: "2030-06-03", endDate: "2030-06-04", appointments: [] } },
  };
  let outcome = "success", refreshed = 0, selected = [];
  let navigationLocked = false;
  const onLockChange = value => { navigationLocked = value; };
  let delayedRead = null;
  const requests = [];
  global.fetch = async (url, options = {}) => {
    assert.equal(options.credentials, "include");
    assert.ok(url === "/api/shop-dispatch" || String(url).startsWith("/api/shop-dispatch/schedule"), "all requests intercepted");
    requests.push({ url, ...options });
    if (options.method === "POST") {
      const body = JSON.parse(options.body);
      if (outcome === "network") throw new Error("Offline fixture connection lost");
      if (outcome === "server") return { ok: false, status: 503, json: async () => ({ error: "Offline fixture unavailable" }) };
      if (outcome === "bad") return { ok: false, status: 422, json: async () => ({ error: "Fixture says this draft is invalid" }) };
      if (outcome === "conflict") return { ok: false, status: 409, json: async () => ({ error: "Board revision changed" }) };
      assert.equal(body.revision, latest.revision);
      if (url === "/api/shop-dispatch") {
        assert.equal(body.command.type, "plan");
        latest = { ...latest, revision: latest.revision + 1, jobs: latest.jobs.map(j => j.id === body.command.jobId ? { ...j, ...body.command } : j) };
      } else {
        latest = { ...latest, revision: latest.revision + 1 };
      }
      return { ok: true, json: async () => ({ board: latest }) };
    }
    const value = { board: latest, availability: { revision: latest.revision, generatedAt: "2030-06-03T08:00:00Z", timeZone: "UTC", appointmentFetchedAt: "2030-06-03T08:00:00Z", available: true, reasons: [], warnings: [], slots: [], truncated: false } };
    if (delayedRead) return new Promise(resolve => { delayedRead.resolve = () => resolve({ ok: true, json: async () => value }); });
    return { ok: true, json: async () => value };
  };
  const root = createRoot(document.getElementById("root"));
  const find = id => document.querySelector(`[data-testid="${id}"]`);
  const click = id => act(async () => { assert.ok(find(id), id); find(id).click(); });
  const submit = id => act(async () => find(id).dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
  const posts = () => requests.filter(r => r.method === "POST");
  const change = (id, value) => act(async () => {
    const element = find(id), prototype = element.tagName === "SELECT" ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
    element.dispatchEvent(new dom.window.Event(element.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
  async function drop(id, tech, hour, source = "queue") {
    const transfer = { values: {}, setData(k, v) { this.values[k] = v; }, getData(k) { return this.values[k] || ""; }, effectAllowed: "", dropEffect: "" };
    const sourceElement = find(source === "queue" ? `timeline-queue-${id}` : `timeline-block-${id}`);
    const lane = find(`timeline-lane-${tech}`);
    lane.getBoundingClientRect = () => ({ left: 0, width: 1120 });
    await act(async () => {
      const e = new dom.window.Event("dragstart", { bubbles: true, cancelable: true });
      Object.defineProperty(e, "dataTransfer", { value: transfer }); sourceElement.dispatchEvent(e);
    });
    await act(async () => {
      const e = new dom.window.Event("dragover", { bubbles: true, cancelable: true });
      Object.defineProperties(e, { dataTransfer: { value: transfer }, clientX: { value: (hour - 8) * 112 } }); lane.dispatchEvent(e);
    });
    assert.ok(find("timeline-preview"), "real dragover renders a placement preview");
    await act(async () => {
      const e = new dom.window.Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperties(e, { dataTransfer: { value: transfer }, clientX: { value: (hour - 8) * 112 } }); lane.dispatchEvent(e);
    });
  }
  try {
    await act(async () => root.render(React.createElement(ScheduleCalendar, { board: latest, busy: false, refresh: async () => { refreshed++; }, select: id => selected.push(id), onLockChange })));
    assert.ok(find("schedule-timeline"), "day timeline is the default");
    assert.ok(find("timeline-hold-fixture-hold"), "in-range capacity holds appear on the timeline");
    assert.equal(find("timeline-queue-queued").draggable, true, "known book-only work can drag");
    assert.match(find("timeline-queue-queued").textContent, /87 min book baseline — review/);
    assert.equal(find("timeline-queue-unknown").draggable, false, "both-null duration needs manual entry");
    assert.equal(find("timeline-queue-zero").draggable, false, "zero book labor is not a positive duration");
    assert.equal(find("timeline-queue-removed").draggable, false, "removed upstream jobs cannot drag");
    await click("schedule-job-removed");
    assert.match(find("timeline-details").textContent, /Removed upstream: review this job before scheduling/);
    await click("schedule-job-zero");
    assert.equal(find("timeline-plan-minutes").value, "");
    assert.equal(find("timeline-block-book-scheduled").style.width, "84px", "existing book-only reservation has effective duration width");
    assert.match(find("timeline-block-book-scheduled").textContent, /book baseline — review/);
    await drop("blocked", "b", 16);
    assert.equal(posts().length, 0);
    assert.match(find("timeline-error").textContent, /hold/i, "local preview uses production hold validation");
    await submit("timeline-plan-form");
    assert.equal(posts().length, 0, "invalid preview cannot be persisted");
    await drop("queued", "b", 10);
    assert.equal(posts().length, 0, "drop preview never persists");
    assert.equal(find("timeline-plan-technician").value, "b");
    assert.equal(find("timeline-plan-time").value, "10:00");
    assert.equal(find("timeline-plan-minutes").value, "90");
    await change("timeline-plan-minutes", "61.8");
    await click("timeline-round-minutes");
    assert.equal(find("timeline-plan-minutes").value, "75");
    await change("timeline-plan-minutes", "87");
    await click("timeline-round-minutes");
    assert.equal(find("timeline-plan-minutes").value, "90");
    assert.match(find("timeline-details").textContent, /book baseline — review/);
    assert.equal(latest.jobs.find(j => j.id === "queued").estimatedMinutes, null, "book-baseline drag stays local until manager saves");
    assert.equal(find("timeline-block-queued"), null, "preview does not masquerade as saved work");
    await submit("timeline-plan-form");
    assert.equal(posts().length, 1);
    const first = JSON.parse(posts()[0].body);
    assert.equal(first.command.authorized, false, "drag never authorizes work");
    assert.deepEqual(first.command.prerequisites, ["finished"]);
    assert.equal(first.command.resource, "bay-local");
    assert.equal(first.command.plannedStart, "2030-06-03T10:00:00.000Z");
    assert.ok(find("timeline-block-queued"), "only server response puts work on timeline");
    assert.equal(latest.jobs.find(j => j.id === "queued").estimatedMinutes, 90, "reviewed rounded book baseline becomes an explicit planned estimate");
    assert.equal(latest.jobs.find(j => j.id === "queued").bookMinutes, 87);
    await drop("queued", "a", 12, "block");
    await submit("timeline-plan-form");
    assert.equal(latest.jobs.find(j => j.id === "queued").technicianId, "a");
    assert.equal(latest.jobs.find(j => j.id === "queued").plannedStart, "2030-06-03T12:00:00.000Z");
    const lane = find("timeline-lane-a"); document.elementFromPoint = () => lane;
    await act(async () => {
      const e = new dom.window.MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 560, button: 0 });
      find("timeline-resize-queued").dispatchEvent(e);
    });
    await act(async () => window.dispatchEvent(new dom.window.MouseEvent("pointermove", { bubbles: true, cancelable: true, clientX: 616, clientY: 20 })));
    assert.ok(find("timeline-preview"));
    await act(async () => window.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true, clientX: 616, clientY: 20 })));
    assert.equal(find("timeline-plan-minutes").value, "120", "pointer resizing snaps planned duration");
    assert.equal(posts().length, 2);
    await submit("timeline-plan-form");
    assert.equal(latest.jobs.find(j => j.id === "queued").estimatedMinutes, 120);
    assert.equal(latest.jobs.find(j => j.id === "queued").bookMinutes, 87);
    // Resize an existing reservation that still has only book labor, not an estimate.
    await act(async () => find("timeline-resize-book-scheduled").dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 868, button: 0 })));
    await act(async () => window.dispatchEvent(new dom.window.MouseEvent("pointermove", { bubbles: true, cancelable: true, clientX: 924, clientY: 20 })));
    assert.match(find("timeline-preview").textContent, /75 min · book baseline — review/);
    await act(async () => window.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true, clientX: 924, clientY: 20 })));
    assert.equal(find("timeline-plan-minutes").value, "75", "resize begins with effective book duration, not zero");
    assert.equal(latest.jobs.find(j => j.id === "book-scheduled").estimatedMinutes, null, "resize preview is not saved");
    await submit("timeline-plan-form");
    assert.equal(latest.jobs.find(j => j.id === "book-scheduled").estimatedMinutes, 75);
    assert.equal(latest.jobs.find(j => j.id === "book-scheduled").bookMinutes, 45, "book-only resize preserves billed labor");
    await click("schedule-job-finished");
    assert.match(find("timeline-details").textContent, /Completed work: scheduling is locked/);
    assert.equal(find("timeline-resize-finished"), null);
    assert.deepEqual(selected, [], "quick details preserve schedule context");
    await click("schedule-job-active");
    assert.match(find("timeline-details").textContent, /pause the job before moving or resizing/);
    assert.equal(find("timeline-resize-active"), null);
    await click("schedule-job-unknown");
    assert.equal(find("timeline-plan-minutes").value, "", "both-null duration must not invent labor");
    await change("timeline-plan-technician", "b");
    await change("timeline-plan-time", "15:00");
    await change("timeline-plan-minutes", "40");
    outcome = "bad";
    await submit("timeline-plan-form");
    assert.match(find("schedule-error").textContent, /Fixture says this draft is invalid/);
    assert.equal(find("timeline-plan-minutes").value, "40");
    assert.equal(find("timeline-block-unknown"), null);
    outcome = "conflict";
    await submit("timeline-plan-form");
    assert.ok(find("timeline-plan-save").closest("fieldset").disabled, "conflict blocks other writes until explicit refresh");
    latest = { ...latest, revision: latest.revision + 1 };
    await submit("schedule-search");
    assert.ok(find("timeline-plan-save").disabled, "refresh keeps draft base revision");
    await click("timeline-plan-review");
    outcome = "network";
    await submit("timeline-plan-form");
    assert.ok(find("schedule-retry"));
    assert.equal(navigationLocked, true, "parent navigation stays locked during an uncertain save");
    const unload = new dom.window.Event("beforeunload", {cancelable:true});
    window.dispatchEvent(unload);
    assert.equal(unload.defaultPrevented, true, "leaving the page warns while the result is unknown");
    assert.ok([...find("timeline-details").querySelectorAll("button")].find(b => b.textContent === "Open full RO details").disabled);
    const exact = posts().at(-1).body;
    await click("schedule-settings-toggle");
    assert.ok(find("schedule-settings-save").closest("fieldset").disabled, "timeline uncertainty locks settings too");
    assert.ok(find("schedule-release-fixture-hold").disabled, "timeline uncertainty locks existing hold releases too");
    assert.ok(find("timeline-plan-save").closest("fieldset").disabled);
    outcome = "server";
    await click("schedule-retry");
    assert.equal(posts().at(-1).body, exact);
    assert.ok(find("schedule-retry"), "5xx retains exact request");
    outcome = "success";
    await click("schedule-retry");
    assert.equal(posts().at(-1).body, exact);
    assert.equal(find("schedule-retry"), null);
    assert.equal(navigationLocked, false, "confirmation releases parent navigation");
    assert.ok(find("timeline-block-unknown"));
    assert.equal(latest.jobs.find(j => j.id === "unknown").authorized, false);
    assert.equal(refreshed, 5);
    // An older GET that settles after a save cannot roll the timeline back.
    delayedRead = {};
    const pendingRead = submit("schedule-search");
    await pendingRead;
    await click("schedule-job-queued");
    await change("timeline-plan-minutes", "105");
    await submit("timeline-plan-form");
    const confirmedRevision = latest.revision;
    await act(async () => { delayedRead.resolve(); });
    assert.match(find("schedule-calendar").textContent, new RegExp(`revision ${confirmedRevision}`));
    assert.equal(latest.jobs.find(j => j.id === "queued").estimatedMinutes, 105);
    await change("timeline-search", "TEST-731");
    assert.ok(find("timeline-block-queued"), "RO search matches vehicle jobs");
    await change("timeline-search", "no such vehicle");
    assert.equal(find("timeline-block-queued"), null);
    assert.match(find("schedule-unplanned").textContent, /No queued jobs match/);
    await change("timeline-search", "");
    latest = { ...latest, revision: latest.revision + 1, jobs: [...latest.jobs,
      job("overnight-book", { estimatedMinutes: null, bookMinutes: 600, technicianId: "c", plannedStart: "2030-06-02T23:30:00Z", status: "completed" }),
      job("late-book", { estimatedMinutes: null, bookMinutes: 120, technicianId: "c", plannedStart: "2030-06-03T17:30:00Z", status: "completed" }),
    ] };
    await act(async () => root.render(React.createElement(ScheduleCalendar, { board: latest, busy: false, refresh: async () => { refreshed++; }, select: id => selected.push(id) })));
    assert.equal(find("timeline-block-overnight-book").style.left, "0px");
    assert.equal(find("timeline-block-overnight-book").style.width, "1064px", "book-only multiday reservation clips to selected day, ending at 09:30");
    assert.equal(find("timeline-block-late-book").style.width, "224px", "book-only reservation expands bounds beyond configured hours without being hidden");
  } finally {
    await act(async () => root.unmount()); dom.window.close(); Date.now = originalNow;
    for (const key of names) { if (previous[key]) Object.defineProperty(global, key, previous[key]); else delete global[key]; }
  }
});
