// Offline DOM regressions. Every request is intercepted; no provider or database.
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const { test } = require("node:test");
const { build } = require("esbuild");
const React = require("react");
const { act } = React;
const { createRoot } = require("react-dom/client");
const { JSDOM } = require("jsdom");

const sheet = { id: "safety", version: 1, name: "Shop safety check", items: [
  { id: "tires", name: "Tire condition", procedure: "Inspect", fields: [], required: true, requiredFields: [], notesRequired: false, photoRequired: false, recommendationRequired: false },
] };
const inspection = () => ({ version: 1, revision: 1, evidenceRevision: 0, sheets: [{ key: "safety@1", sheet, active: true, selection: "default", results: {} }], startedAt: null, ready: null, reviewed: null });
const access = values => ({ enabled: true, canEdit: true, canReview: false, record: null, inspection: null, catalog: [sheet], boardRevision: 17, ...values });
const visit = { id: "visit-66", ro: "6473", provider: "protractor", sourceId: "wo-test", sourceStatus: "WorkAuthorized", closed: false, vehicle: "2018 Mazda CX-5", customer: "Mara Chen", arrivalAt: "2026-03-16T14:00:00Z", promiseAt: null, transport: { customerPlan: "drop-off", ride: "none", loaner: "none", loanerId: "", notes: "", pickupAt: null } };
const details = { customer: visit.customer, vehicle: visit.vehicle, contactId: "contact-test", vehicleId: "vehicle-test", newCustomer: null, newVehicle: null, identityConfirmed: true, concerns: ["Check tire wear"], mileage: 68214, customerPlan: "drop-off", neededBy: null, promiseAt: null, nextUpdateAt: null, commitmentsConfirmed: false };
const board = () => ({ revision: 17, updatedAt: null, visits: [visit], jobs: [], technicians: [], audit: [], receipts: [], locationBrand: null, ticketIntents: [] });
let components;
async function harness() {
  if (!components) {
    const bundle = await build({
      stdin: { contents: 'export {default as DispatchPilot} from "./DispatchPilot"; export {DviEntry} from "./DviEntry"; export {StaffInspectionPanel} from "./StaffInspectionPanel"; export {VisitIntake} from "./VisitIntake";', resolveDir: __dirname, loader: "tsx" },
      bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic",
      external: ["react", "react-dom", "zod"],
      plugins: [{ name: "offline", setup(builder) {
        builder.onResolve({ filter: /^@\/lib\/shop-dispatch\/client$/ }, () => ({ path: "board", namespace: "fixture" }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export function useDispatchBoard(){return globalThis.__dispatchFixture;}", loader: "js" }));
        builder.onLoad({ filter: /\.module\.css$/ }, () => ({ contents: "export default new Proxy({}, {get: (_, key) => key})", loader: "js" }));
      } }],
    });
    const compiled = new Module(path.join(__dirname, "offline-dvi.cjs"), module);
    compiled.filename = path.join(__dirname, "offline-dvi.cjs");
    compiled.paths = module.paths;
    compiled._compile(bundle.outputFiles[0].text, compiled.filename);
    components = compiled.exports;
  }
  const dom = new JSDOM("<div id='root'></div>", { url: "http://offline.invalid" });
  const keys = ["window", "document", "sessionStorage", "FormData", "IS_REACT_ACT_ENVIRONMENT", "fetch", "__dispatchFixture"];
  const previous = Object.fromEntries(keys.map(key => [key, global[key]]));
  const calls = [];
  let responder = () => access();
  Object.assign(global, { window: dom.window, document: dom.window.document, sessionStorage: dom.window.sessionStorage, FormData: dom.window.FormData, IS_REACT_ACT_ENVIRONMENT: true });
  global.fetch = async (url, options = {}) => {
    calls.push({ url, ...options });
    const result = await responder(url, options);
    return { ok: true, status: 200, json: async () => result };
  };
  dom.window.confirm = () => true;
  const root = createRoot(document.getElementById("root"));
  const render = async (name, props) => act(async () => root.render(React.createElement(components[name], props)));
  const click = async label => act(async () => {
    const button = [...document.querySelectorAll("button")].find(node => node.textContent === label);
    assert.ok(button, `Missing button: ${label}`);
    button.click();
  });
  const posts = () => calls.filter(call => call.method === "POST");
  return { calls, posts, render, click, dom, respond(fn) { responder = fn; }, async close() {
    await act(async () => root.unmount()); dom.window.close(); Object.assign(global, previous);
  } };
}

test("DVI entry fails closed using real inspection permission, not manager role or shop 66", async () => {
  const h = await harness();
  try {
    let opened = 0;
    for (const [index, response] of [access({ enabled: false }), access({ canEdit: false }), access({ record: { closed: true } }), access()].entries()) {
      h.respond(() => response);
      await h.render("DviEntry", { key: index, visitId: visit.id, shopId: 66, closed: false, busy: false, onOpen: () => opened++ });
      assert.equal(!!document.querySelector(`[data-testid="dvi-entry-${visit.id}"]`), index === 3);
    }
    await h.click("Start DVI");
    assert.equal(opened, 1);
    assert.equal(h.posts().length, 0, "Navigation never creates a provider ticket or sends findings");
    h.respond(() => access({ inspection: inspection() }));
    await h.render("DviEntry", { key: "existing", visitId: visit.id, closed: false, busy: false, onOpen: () => opened++ });
    await h.click("Continue DVI");
    assert.equal(opened, 2);
    const reads = h.calls.length;
    await h.render("DviEntry", { closed: true });
    assert.equal(h.calls.length, reads, "Closed historical tickets do not offer a writable entry");
    assert.equal(document.querySelector("button"), null);
  } finally { await h.close(); }
});

test("availability failures offer a read-only retry, never optimistic DVI access", async () => {
  const h = await harness();
  try {
    h.respond(() => { throw Error("offline"); });
    await h.render("DviEntry", { visitId: visit.id, closed: false, busy: false, onOpen: () => assert.fail("unauthorized") });
    assert.match(document.body.textContent, /availability could not be checked/);
    h.respond(() => access({ canEdit: false }));
    await h.click("Check DVI access again");
    assert.equal(document.querySelector("button"), null);
    assert.equal(h.posts().length, 0);
  } finally { await h.close(); }
});

test("explicit Start persists an inspection once; uncertain receipt retains exact retry identity and locks navigation", async () => {
  const h = await harness();
  try {
    let fail = true;
    const locks = [];
    h.respond((url, options) => {
      assert.match(url, /^\/api\/shop-dispatch\/inspection/);
      if (url.includes("/release")) return { enabled: false, canPublish: false };
      if (url.includes("/pilot")) return { enabled: false };
      if (options.method === "POST") {
        if (fail) throw Error("lost acknowledgment");
        return access({ inspection: inspection() });
      }
      return access({ boardRevision: 21 });
    });
    await h.render("StaffInspectionPanel", { visitId: visit.id, shopId: 66, startRequested: true, onLockChange: value => locks.push(value) });
    assert.equal(h.posts().length, 1);
    const original = JSON.parse(h.posts()[0].body);
    assert.equal(original.command.type, "initialize");
    assert.equal(original.command.boardRevision, 21, "Start reads current revision after ticket creation");
    assert.equal(original.visitId, visit.id);
    assert.equal(h.posts()[0].credentials, "include");
    assert.match(document.body.textContent, /Request awaiting acknowledgment/);
    assert.equal(locks.at(-1), true);
    await h.render("StaffInspectionPanel", { visitId: visit.id, shopId: 66, startRequested: true, onLockChange: value => locks.push(value) });
    assert.equal(h.posts().length, 1, "Rerender cannot replay a start");
    fail = false;
    await h.click("Retry exact request");
    assert.equal(h.posts()[1].body, h.posts()[0].body);
    assert.match(document.body.textContent, /Revision 1/);
    assert.equal(locks.at(-1), false);
    await act(async () => document.querySelector('input[type="radio"]').click());
    assert.match(document.body.textContent, /unsaved item draft/);
    assert.equal(locks.at(-1), true, "SPA navigation also protects in-memory drafts");
    await h.click("Discard drafts and reload latest");
    assert.equal(locks.at(-1), false);
  } finally { await h.close(); }
});

test("ordinary visit inspection rendering and denied explicit start never create anything", async () => {
  const h = await harness();
  try {
    await h.render("StaffInspectionPanel", { visitId: visit.id, shopId: 66 });
    assert.equal(h.posts().length, 0);
    assert.match(document.body.textContent, /Start a digital vehicle inspection/);
    h.respond(() => access({ canEdit: false }));
    await h.render("StaffInspectionPanel", { key: "denied", visitId: visit.id, shopId: 66, startRequested: true });
    assert.equal(h.posts().length, 0);
    assert.equal([...document.querySelectorAll("button")].find(node => node.textContent === "Start DVI").disabled, true);
  } finally { await h.close(); }
});

test("DVI start after RO creation refreshes stale pre-ticket availability before persisting", async () => {
  const h = await harness();
  try {
    h.respond(() => access({ enabled: false, canEdit: false }));
    await h.render("StaffInspectionPanel", { visitId: visit.id, shopId: 66 });
    assert.equal(h.posts().length, 0);
    h.respond((url, options) => {
      if (url.includes("/release")) return { enabled: false, canPublish: false };
      if (url.includes("/pilot")) return { enabled: false };
      return options.method === "POST" ? access({ inspection: inspection() }) : access({ boardRevision: 23 });
    });
    await h.render("StaffInspectionPanel", { visitId: visit.id, shopId: 66, startRequested: true });
    assert.equal(h.posts().length, 1);
    assert.equal(JSON.parse(h.posts()[0].body).command.boardRevision, 23);
    assert.match(document.body.textContent, /Revision 1/);
  } finally { await h.close(); }
});

test("revision conflict keeps the original start revision and requires explicit discard/reload", async () => {
  const h = await harness();
  try {
    // Override only this offline fetch with a definitive parsed 409 response.
    let currentRevision = 21;
    global.fetch = async (url, options = {}) => {
      h.calls.push({ url, ...options });
      if (options.method === "POST") return { ok: false, status: 409, json: async () => ({ error: "Revision changed" }) };
      return { ok: true, status: 200, json: async () => access({ boardRevision: currentRevision }) };
    };
    await h.render("StaffInspectionPanel", { visitId: visit.id, shopId: 66, startRequested: true });
    assert.equal(h.posts().length, 1);
    assert.match(document.body.textContent, /Revision conflict — draft retained/);
    currentRevision = 28;
    await h.click("Compare with latest server values");
    assert.equal(h.posts().length, 1, "Comparison never resubmits or rebases the rejected request");
    await h.render("StaffInspectionPanel", { visitId: visit.id, shopId: 66, startRequested: true });
    assert.equal(h.posts().length, 1);
    await h.click("Discard drafts and reload latest");
    await h.click("Start DVI");
    assert.equal(h.posts().length, 2);
    const old = JSON.parse(h.posts()[0].body), next = JSON.parse(h.posts()[1].body);
    assert.notEqual(old.requestId, next.requestId);
    assert.equal(old.command.boardRevision, 21);
    assert.equal(next.command.boardRevision, 28);
  } finally { await h.close(); }
});

test("uncertain ticket intent offers verification only, not another RO creation", async () => {
  const h = await harness();
  try {
    const localVisit = { ...visit, provider: "manual", sourceId: null };
    const uncertainBoard = { ...board(), visits: [localVisit], ticketIntents: [{ id: "uncertain-test", visitId: visit.id, status: "uncertain", message: "Check the recorded attempt", attempted: ["workOrder"], createdAt: "2026-03-16T14:00:00Z" }] };
    h.respond((url, options) => options.method === "POST" ? { board: uncertainBoard } : access());
    await h.render("VisitIntake", { visit: localVisit, board: uncertainBoard, shopId: 66, manager: true, busy: false });
    assert.equal(h.posts().length, 0);
    assert.match(document.body.textContent, /never replays attempted customer, vehicle or work-order writes/);
    assert.equal([...document.querySelectorAll("button")].some(node => node.textContent === "Create upstream ticket"), false);
    await h.click("Retry verification only");
    assert.equal(h.posts().length, 1);
    assert.equal(JSON.parse(h.posts()[0].body).action, "reconcile");
  } finally { await h.close(); }
});

test("new RO requires explicit creation confirmation; confirmed result exposes DVI without sending or replaying provider writes", async () => {
  const h = await harness();
  try {
    const localVisit = { ...visit, provider: "manual", sourceId: null, intake: { details, checkedInAt: "2026-03-16T14:00:00Z", checkedInBy: "advisor@test.invalid", appointmentId: null } };
    const localBoard = { ...board(), visits: [localVisit] };
    let opened = 0;
    h.respond((url, options) => {
      if (options.method === "POST") return { board: { ...localBoard, revision: 18, visits: [{ ...localVisit, provider: "protractor", sourceId: "new-work-order" }], ticketIntents: [{ id: "intent-test", visitId: visit.id, status: "confirmed", message: "Verified upstream", attempted: ["workOrder"], createdAt: "2026-03-16T14:00:00Z" }] } };
      return access();
    });
    await h.render("VisitIntake", { visit: localVisit, board: localBoard, shopId: 66, manager: true, busy: false, onOpenInspection: () => opened++ });
    assert.equal(h.posts().length, 0);
    const create = [...document.querySelectorAll("button")].find(node => node.textContent === "Create upstream ticket");
    assert.equal(create.disabled, true);
    await act(async () => [...document.querySelectorAll('input[type="checkbox"]')].find(node => node.parentElement.textContent.includes("explicitly confirm creation")).click());
    await h.click("Create upstream ticket");
    assert.equal(h.posts().length, 1);
    const request = JSON.parse(h.posts()[0].body);
    assert.equal(request.action, "create");
    assert.equal(request.confirmed, true);
    assert.equal(request.revision, 17);
    await h.click("Start DVI");
    assert.equal(opened, 1);
    assert.equal(h.posts().length, 1, "No automatic second ticket creation or send");
    assert.equal([...document.querySelectorAll("button")].some(node => node.textContent === "Create upstream ticket"), false);
  } finally { await h.close(); }
});

test("Dispatch exposes check-in/create RO directly and DVI separately from the open-ticket navigation", async () => {
  const h = await harness();
  try {
    global.__dispatchFixture = { snapshot: { board: board(), actor: { email: "advisor@test.invalid", manager: true, technicianId: null }, shopId: 66, serverNow: new Date().toISOString(), enterprise: null }, busy: false, lastReceived: Date.now(), refresh: async () => {}, mutate: async () => true };
    h.respond(() => access());
    await h.render("DispatchPilot");
    assert.ok(document.querySelector('[data-testid="dispatch-check-in"]'));
    assert.ok(document.querySelector(`[data-testid="dvi-entry-${visit.id}"]`));
    assert.equal(document.querySelector("button button"), null);
    await h.click("Check in / create RO");
    assert.ok(document.querySelector('[data-testid="intake-walk-in"]'));
    assert.match(document.body.textContent, /Upstream ticket creation is a separate, explicitly confirmed action/);
    assert.equal(h.posts().length, 0);
  } finally { await h.close(); }
});
