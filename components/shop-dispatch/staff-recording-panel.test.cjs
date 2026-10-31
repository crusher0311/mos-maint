const {test} = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const {webcrypto, createHash} = require("node:crypto");
const {buildSync} = require("esbuild");
const {JSDOM} = require("jsdom");
const React = require("react");
const {act} = React;

// Bundle only the frontend. No route, provider, database, camera or network runs.
const output = buildSync({
  stdin: {contents: `
    export {StaffRecordingPanel} from "./components/shop-dispatch/StaffRecordingPanel";
    export {StaffInspectionPanel} from "./components/shop-dispatch/StaffInspectionPanel";
    export {RecordingOutbox} from "./lib/auto-dvi/staff/recording-outbox";
    export {ForegroundRecording} from "./lib/auto-dvi/staff/foreground-recording";
  `, resolveDir: process.cwd(), loader: "tsx"},
  bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic",
  external: ["react", "react/*"], loader: {".css": "empty", ".module.css": "empty"},
  logLevel: "silent",
}).outputFiles[0].text;
const fixtureModule = new Module(path.join(process.cwd(), "components/shop-dispatch/recording-offline-fixture.cjs"), module);
fixtureModule.filename = fixtureModule.id;
fixtureModule.paths = module.paths;
fixtureModule._compile(output, fixtureModule.filename);
const {StaffRecordingPanel, StaffInspectionPanel, RecordingOutbox} = fixtureModule.exports;
const scope = JSON.stringify([7, "tech-mira", "visit-17"]);
const id = "438195c1-ce58-4239-a649-b8623690eb35";
const storageKey = "mos:staff-recording:visit-17";
const hash = value => createHash("sha256").update(value).digest("hex");
const item = {id: "brake", name: "Front brake", procedure: "Inspect", required: false,
  fields: [], requiredFields: [], photoRequired: false, notesRequired: false, recommendationRequired: false};
const target = {sheet: "sheet@1", item: item.id, name: item.name, definitionHash: hash(JSON.stringify(item))};
const inspection = {version: 1, revision: 8, evidenceRevision: 3, startedAt: null, ready: null, reviewed: null,
  sheets: [{key: "sheet@1", active: true, selection: "default", sheet: {name: "Vehicle checks", items: [item]},
    results: {brake: {rating: "green", notes: "Saved measurement", recommendation: "Keep recommendation",
      naReason: "Keep reason", values: {pad: 6.2}, photos: [], actor: "original", at: "2025-01-01T00:00:00.000Z"}}}]};
function record(overrides = {}) {
  return {id, shopId: 7, visitId: "visit-17", actor: "tech-mira", identityDigest: "a".repeat(64),
    inspectionRevision: 8, policyVersion: 1, revision: 0, createdAt: "2025-01-01T00:00:00.000Z",
    state: "open", targets: [target], segments: [], ...overrides};
}
function segment(sequence, notes = "Narrated observation") {
  return {sequence, digest: hash("original"), bytes: 8, mime: "video/webm", durationSeconds: 2,
    mediaId: "b".repeat(24), state: "processed", attempts: 1, lease: null, error: null,
    drafts: [{id: `draft-${sequence}`, target, source: "narration", rating: "yellow",
      notes, caption: "Visible reference", startSeconds: 0, endSeconds: 2, confirmed: false}]};
}
async function flush() {
  await act(async () => {for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));});
}
async function waitFor(predicate, description) {
  // WebCrypto runs on a worker: draining microtasks/setImmediate alone is not
  // a completion signal, especially when other test files are running.
  const deadline = Date.now() + 2500;
  while (!predicate() && Date.now() < deadline) {
    await act(async () => new Promise(resolve => setTimeout(resolve, 8)));
    await flush();
  }
  assert(predicate(), description);
}
async function setup({pinned = true, server = record(), fetcher, parent = false} = {}) {
  const dom = new JSDOM("<div id='root'></div>", {url: "https://offline.invalid/visit"});
  const originals = new Map();
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    sessionStorage: dom.window.sessionStorage, crypto: webcrypto, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {value, configurable: true, writable: true});
  }
  Object.defineProperty(document, "visibilityState", {value: "visible", configurable: true});
  if (pinned) sessionStorage.setItem(storageKey, JSON.stringify({id, visitId: "visit-17", inspectionRevision: 8,
    shopId: 7, actor: "tech-mira", identityDigest: "a".repeat(64), scope}));
  const rows = new Map(), calls = [], drafts = [], locks = [];
  const originalMethods = {};
  for (const key of ["list", "put", "acknowledge"]) originalMethods[key] = RecordingOutbox.prototype[key];
  RecordingOutbox.prototype.list = async value => [...rows.values()].filter(row => row.scope === value);
  RecordingOutbox.prototype.put = async row => {assert(!rows.has(row.key)); rows.set(row.key, row);};
  RecordingOutbox.prototype.acknowledge = async (value, key) => {
    assert.equal(rows.get(key)?.scope, value); rows.delete(key);
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({url, init});
    if (fetcher) return fetcher(url, init, env);
    if (typeof init.body === "string") {
      const body = JSON.parse(init.body);
      server.id = body.id;
      if (body.action === "stop") server = {...server, state: "stopped", revision: server.revision + 1};
    }
    return Response.json({recording: server, scope});
  };
  const {createRoot} = require("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  const env = {
    dom, root, rows, calls, drafts, locks,
    get server() {return server;}, set server(value) {server = value;},
    async render(disabled = false) {
      await act(async () => root.render(React.createElement(parent ? StaffInspectionPanel : StaffRecordingPanel, {
        visitId: "visit-17", inspection, disabled, onDraft: (...args) => drafts.push(args),
        onLockChange: value => locks.push(value),
      })));
      await flush();
    },
    button(text) {return [...document.querySelectorAll("button")].find(button => button.textContent.includes(text));},
    async click(text) {const button = env.button(text); assert(button, text); assert(!button.disabled, `${text} enabled`); await act(async () => button.click()); await flush();},
    async cleanup() {
      await act(async () => root.unmount());
      await flush();
      globalThis.fetch = originalFetch;
      for (const key of Object.keys(originalMethods)) RecordingOutbox.prototype[key] = originalMethods[key];
      dom.window.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
      }
    },
  };
  return env;
}

test("inline edits survive new segments; Apply is explicit and preserves saved evidence base", async () => {
  const env = await setup({server: record({state: "stopped", segments: [segment(0)]})});
  try {
    await env.render();
    assert.equal(env.drafts.length, 0);
    assert.match(document.body.textContent, /not precise AI timing/);
    const textarea = document.querySelector("textarea");
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(textarea, "Technician corrected notes");
      textarea.dispatchEvent(new window.Event("input", {bubbles: true}));
      textarea.dispatchEvent(new window.Event("change", {bubbles: true}));
    });
    env.server = record({state: "stopped", revision: 2, segments: [segment(0), segment(1, "Later segment")]});
    await env.click("Recover pending");
    assert.equal(document.querySelector("textarea").value, "Technician corrected notes");
    assert.match(document.body.textContent, /2 draft findings to review/);
    await env.click("Apply / replace");
    assert.equal(env.drafts.length, 1);
    const [sheet, itemId, value] = env.drafts[0];
    assert.equal(sheet, target.sheet); assert.equal(itemId, target.item);
    assert.deepEqual(value.values, {pad: 6.2});
    assert.equal(value.recommendation, "Keep recommendation");
    assert.equal(value.naReason, "Keep reason");
    assert.match(value.notes, /Saved measurement/);
    assert.match(value.notes, /Technician corrected notes/);
    assert.match(value.notes, /Narration caption: Visible reference/);
    assert(!env.calls.some(call => call.init.body instanceof FormData));
  } finally {await env.cleanup();}
});

test("identity mismatch locks controls and never exposes another scope's local media", async () => {
  const env = await setup({server: record({actor: "another-tech"})});
  try {
    await env.render();
    assert.match(document.body.textContent, /identity mismatch/);
    assert(env.button("Start short").disabled);
    assert(env.button("Recover pending").disabled);
    assert.equal(JSON.parse(sessionStorage.getItem(storageKey)).actor, "tech-mira");
  } finally {await env.cleanup();}
});

test("unmatched target is explicit and cannot be applied", async () => {
  const wrong = segment(0); wrong.drafts[0].target = null;
  const env = await setup({server: record({state: "stopped", segments: [wrong]})});
  try {
    await env.render();
    assert.match(document.body.textContent, /Unmatched target/);
    assert(env.button("Apply / replace").disabled);
    assert.equal(env.drafts.length, 0);
  } finally {await env.cleanup();}
});

test("recover retains original blob after wrong digest, then exact retry precedes Stop", async () => {
  let correct = false;
  const env = await setup({fetcher: async (_url, init, state) => {
    if (init.body instanceof FormData) {
      const blob = init.body.get("file");
      assert.equal(await blob.text(), "original");
      const receipt = segment(0);
      receipt.state = "uploaded"; receipt.attempts = 0; receipt.drafts = [];
      receipt.digest = correct ? hash("original") : "c".repeat(64);
      state.server = record({segments: [receipt], revision: state.server.revision + 1});
    } else if (typeof init.body === "string" && JSON.parse(init.body).action === "stop") {
      assert.equal(state.rows.size, 0, "all local entries acknowledged before Stop");
      state.server = {...state.server, state: "stopped", revision: state.server.revision + 1};
    }
    return Response.json({recording: state.server, scope});
  }});
  const key = JSON.stringify([scope, id, 0]);
  env.rows.set(key, {key, scope, recordingId: id, sequence: 0, visitId: "visit-17",
    durationSeconds: 2, mime: "video/webm", blob: new Blob(["original"], {type: "video/webm"})});
  try {
    await env.render();
    await waitFor(() => document.body.textContent.includes("SHA-256 receipt missing"), "wrong receipt is reported after hashing");
    assert.equal(env.rows.size, 1);
    assert.match(document.body.textContent, /SHA-256 receipt missing/);
    assert(!env.calls.some(call => typeof call.init.body === "string" && JSON.parse(call.init.body).action === "stop"));
    correct = true;
    await env.click("Recover pending");
    await waitFor(() => env.rows.size === 0 && env.server.state === "stopped", "exact retry receipt precedes Stop");
    assert.equal(env.rows.size, 0, document.body.textContent);
    assert.equal(env.server.state, "stopped");
    assert.equal(env.calls.filter(call => call.init.body instanceof FormData).length, 2);
  } finally {await env.cleanup();}
});

test("short mode admits before camera, commits outbox before upload, and stops after one segment", async () => {
  const env = await setup({pinned: false, fetcher: async (_url, init, state) => {
    if (typeof init.body === "string") {
      const body = JSON.parse(init.body);
      state.server = {...state.server, id: body.id};
      if (body.action === "stop") {
        assert.equal(state.rows.size, 0);
        state.server = {...state.server, state: "stopped", revision: state.server.revision + 1};
      }
    } else if (init.body instanceof FormData) {
      assert.equal(state.rows.size, 1, "IndexedDB persistence completed before upload");
      const blob = init.body.get("file");
      state.server = {...state.server, revision: state.server.revision + 1, segments: [{
        ...segment(0), digest: hash(Buffer.from(await blob.arrayBuffer())), bytes: blob.size,
        durationSeconds: Number(init.body.get("durationSeconds")), state: "uploaded", attempts: 0, drafts: [],
      }]};
    }
    return Response.json({recording: state.server, scope});
  }});
  const originalRecorder = Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder");
  let camera = 0, released = 0;
  class Recorder {
    static instances = [];
    static isTypeSupported() {return true;}
    constructor() {this.state = "inactive"; this.mimeType = "video/webm"; Recorder.instances.push(this);}
    start() {this.state = "recording";}
    stop() {
      this.state = "inactive";
      this.ondataavailable({data: new Blob(["original"], {type: this.mimeType})});
      this.onstop();
    }
  }
  Object.defineProperty(globalThis, "MediaRecorder", {value: Recorder, configurable: true});
  Object.defineProperty(navigator, "mediaDevices", {value: {getUserMedia: async () => {
    camera++;
    assert.equal(env.calls.length, 1);
    assert.equal(JSON.parse(env.calls[0].init.body).action, "start");
    assert(sessionStorage.getItem(storageKey));
    return {getTracks: () => [{stop: () => {released++;}, onended: null}]};
  }}, configurable: true});
  try {
    await env.render();
    await env.click("Start short");
    assert.equal(camera, 1);
    await act(async () => Recorder.instances[0].stop());
    await flush();
    await waitFor(() => env.rows.size === 0 && env.server.state === "stopped",
      "short mode waits for the real SHA-256 worker, exact upload receipt and delayed Stop");
    assert.equal(Recorder.instances.length, 1);
    assert(released > 0);
    assert.equal(env.rows.size, 0, document.body.textContent);
    assert.equal(env.server.state, "stopped");
    assert.equal(env.drafts.length, 0);
  } finally {
    await env.cleanup();
    if (originalRecorder) Object.defineProperty(globalThis, "MediaRecorder", originalRecorder);
    else delete globalThis.MediaRecorder;
  }
});

test("external disabled blocks requests, recording and draft actions", async () => {
  const env = await setup();
  try {
    await env.render(true);
    assert.equal(env.calls.length, 0);
    assert(env.button("Start short").disabled);
    assert(env.button("Recover pending").disabled);
    assert.match(document.body.textContent, /inspection is locked/);
  } finally {await env.cleanup();}
});

test("network failure retains exact original bytes; online recovery uploads then closes", async () => {
  let online = false;
  const env = await setup({fetcher: async (_url, init, state) => {
    if (init.body instanceof FormData) {
      assert.equal(await init.body.get("file").text(), "original");
      if (!online) throw Error("fixture connection lost");
      const receipt = {...segment(0), state: "uploaded", attempts: 0, drafts: []};
      state.server = record({segments: [receipt], revision: 1});
    } else if (typeof init.body === "string") {
      assert.equal(JSON.parse(init.body).action, "stop");
      assert.equal(state.rows.size, 0);
      state.server = {...state.server, state: "stopped", revision: 2};
    }
    return Response.json({recording: state.server, scope});
  }});
  const key = JSON.stringify([scope, id, 0]), blob = new Blob(["original"], {type: "video/webm"});
  env.rows.set(key, {key, scope, recordingId: id, sequence: 0, visitId: "visit-17", durationSeconds: 2, mime: "video/webm", blob});
  try {
    await env.render();
    assert.equal(env.rows.get(key).blob, blob);
    assert.match(document.body.textContent, /fixture connection lost/);
    online = true;
    await act(async () => window.dispatchEvent(new window.Event("online")));
    await flush();
    assert.equal(env.rows.size, 0);
    assert.equal(env.server.state, "stopped");
  } finally {await env.cleanup();}
});

test("authorization failure retains footage and identity across unmount", async () => {
  const env = await setup({fetcher: async () => Response.json({error: "Access changed"}, {status: 403})});
  const key = JSON.stringify([scope, id, 0]);
  const original = {key, scope, recordingId: id, sequence: 0, visitId: "visit-17",
    durationSeconds: 2, mime: "video/webm", blob: new Blob(["original"])};
  env.rows.set(key, original);
  try {
    await env.render();
    assert.match(document.body.textContent, /403/);
    assert.equal(env.rows.get(key), original);
    assert.equal(JSON.parse(sessionStorage.getItem(storageKey)).id, id);
    await act(async () => env.root.unmount());
    assert.equal(env.rows.get(key), original);
    assert.equal(JSON.parse(sessionStorage.getItem(storageKey)).id, id);
  } finally {await env.cleanup();}
});

test("mounted parent honors recording review lock without self-disabling; item saves wait for explicit Apply", async () => {
  const env = await setup({parent: true, server: record({state: "stopped", segments: [segment(0)]}),
    fetcher: async (url, _init, state) => {
      if (url.includes("/recordings")) return Response.json({recording: state.server, scope});
      if (url.includes("/release")) return Response.json({enabled: false, canPublish: false});
      if (url.includes("/pilot")) return Response.json({enabled: false});
      if (url.startsWith("/api/shop-dispatch/inspection?")) return Response.json({
        enabled: true, recordingEnabled: true, canEdit: true, canReview: true, record: null, inspection, catalog: [], boardRevision: 1,
      });
      return Response.json({enabled: false, photos: [], rows: []});
    }});
  try {
    await env.render();
    assert(env.button("Advisor overview").disabled, "navigation blocked by review");
    assert(env.button("Mark internal inspection ready").disabled);
    assert(document.querySelector('[data-testid="inspection-item-brake"] fieldset').disabled);
    assert(!env.button("Apply / replace").disabled, "recording does not disable itself from onLockChange");
    assert(env.button("Record voice findings").disabled, "legacy capture blocked while reviewing");
    assert.equal(env.locks.at(-1), true);
    await env.click("Apply / replace");
    assert(!document.querySelector('[data-testid="inspection-item-brake"] fieldset').disabled, "editor unlocks once recording review is resolved");
    assert(!env.button("Save item evidence").disabled, "explicit parent evidence save now available");
    assert.match(document.body.textContent, /1 unsaved item draft/);
    assert.equal(env.locks.at(-1), true, "parent draft still protects navigation");
  } finally {await env.cleanup();}
});

test("20-second upload timeout aborts the single request and retains pending media", async () => {
  const originalTimeout = globalThis.setTimeout;
  let uploadAborted = false, maximumConcurrent = 0, concurrent = 0;
  globalThis.setTimeout = (callback, delay, ...args) => originalTimeout(callback, delay === 20_000 ? 12 : delay, ...args);
  const env = await setup({fetcher: async (_url, init, state) => {
    if (!(init.body instanceof FormData)) return Response.json({recording: state.server, scope});
    concurrent++; maximumConcurrent = Math.max(maximumConcurrent, concurrent);
    return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => {
      concurrent--; uploadAborted = true; reject(Error("fixture request timeout"));
    }, {once: true}));
  }});
  const key = JSON.stringify([scope, id, 0]);
  env.rows.set(key, {key, scope, recordingId: id, sequence: 0, visitId: "visit-17",
    durationSeconds: 2, mime: "video/webm", blob: new Blob(["original"])});
  try {
    await env.render();
    await act(async () => new Promise(resolve => originalTimeout(resolve, 25)));
    await flush();
    assert(uploadAborted);
    assert.equal(maximumConcurrent, 1);
    assert.equal(env.rows.size, 1);
    assert.match(document.body.textContent, /fixture request timeout/);
    assert(!env.calls.some(call => typeof call.init.body === "string"));
  } finally {await env.cleanup(); globalThis.setTimeout = originalTimeout;}
});
