// Isolated offline skill UI tests. No server, provider or database access.
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const { test } = require("node:test");
const { build } = require("esbuild");
const React = require("react");
const { act } = React;
const { createRoot } = require("react-dom/client");
const { JSDOM } = require("jsdom");

test("manager skill profiles separate history from revision-pinned assessments", async () => {
  const bundle = await build({
    stdin: { contents: 'export {TechnicianSkills} from "./TechnicianSkills";', resolveDir: __dirname, loader: "tsx" },
    bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic",
    external: ["react", "react-dom", "zod"],
    plugins: [{ name: "offline-css", setup(build) {
      build.onLoad({ filter: /\.module\.css$/ }, () => ({ contents: "export default {}", loader: "js" }));
    } }],
  });
  const compiled = new Module(path.join(__dirname, "offline-skills-fixture.cjs"), module);
  compiled.filename = path.join(__dirname, "offline-skills-fixture.cjs");
  compiled.paths = module.paths;
  compiled._compile(bundle.outputFiles[0].text, compiled.filename);
  const { TechnicianSkills } = compiled.exports;
  const dom = new JSDOM("<div id='root'></div>", { url: "http://offline.invalid" });
  const previous = {
    window: global.window, document: global.document, fetch: global.fetch,
    FormData: global.FormData, IS_REACT_ACT_ENVIRONMENT: global.IS_REACT_ACT_ENVIRONMENT,
  };
  global.window = dom.window; global.document = dom.window.document;
  global.FormData = dom.window.FormData; global.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.confirm = () => true;
  const root = createRoot(document.getElementById("root"));
  const requests = [], commands = [];
  let response = { ok: false, json: async () => ({ error: "History unavailable" }) };
  global.fetch = async (url, options) => { requests.push({ url, options }); return response; };
  const tech = {
    id: "local", name: "Marisol Vega", email: "", active: true,
    skills: [{ key: "brake inspection", title: "Brake inspection", status: "not-qualified",
      notes: "Needs supervised practice", reviewedAt: "2026-02-03T12:00:00Z", reviewedBy: "shop-manager" }],
  };
  let board = { revision: 17, technicians: [tech] };
  const props = {
    actor: { manager: true }, busy: false,
    mutate: async (command, revision) => { commands.push({ command, revision }); return true; },
  };
  const render = async (extra = {}) => act(async () => root.render(React.createElement(TechnicianSkills, { ...props, board, ...extra })));
  const byTest = id => document.querySelector(`[data-testid="${id}"]`);
  const submit = async form => act(async () => form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
  const click = async element => act(async () => element.click());
  try {
    await render();
    assert.equal(requests.length, 0, "no mount fetching");
    assert(document.body.textContent.includes("Needs supervised practice"));
    assert(document.body.textContent.includes("Not qualified"));
    const manual = byTest("skill-form-local-manual");
    manual.querySelector('[name="title"]').value = "  Engine   Diagnosis  ";
    manual.querySelector('[name="notes"]').value = "Observed in shop";
    board = { ...board, revision: 21 };
    await render();
    await submit(manual);
    assert.deepEqual(commands.at(-1), { command: {
      type: "skill", technicianId: "local", key: "engine diagnosis", title: "Engine Diagnosis",
      status: "confirmed", notes: "Observed in shop",
    }, revision: 17 }, "board refresh must not silently rebase a draft");
    await click(byTest("skills-load"));
    assert.equal(requests[0].url, "/api/shop-dispatch/skills");
    assert.equal(requests[0].options.credentials, "include");
    assert(document.querySelector('[role="alert"]').textContent.includes("History unavailable"));
    assert(byTest("skill-form-local-manual"), "manual entry survives unavailable history");
    const edit = byTest("skill-form-local-brake inspection");
    edit.querySelector('[name="title"]').value = "Brake inspection (supervised)";
    edit.querySelector('[name="status"]').value = "confirmed";
    await submit(edit);
    assert.equal(commands.at(-1).command.key, "brake inspection");
    assert.equal(commands.at(-1).command.status, "confirmed");
    assert.equal(commands.at(-1).revision, 17);
    const historical = {
      truncated: true, profiles: [
        { technicianId: "local", sourceId: "upstream", skills: [
          { key: "brake inspection", title: "Brake inspection", count: 7, lastCompletedAt: "2026-02-04",
            sharedJobCount: 3, evidence: [{ ro: "18427", title: "Brake inspection", completedAt: "2026-02-04", shared: true }] },
          { key: "alignment", title: "Alignment", count: 4, lastCompletedAt: null, sharedJobCount: 0, evidence: [] },
        ] },
        { technicianId: "not-local", sourceId: null, skills: [
          { key: "secret", title: "Not a local technician", count: 1, lastCompletedAt: null, sharedJobCount: 0, evidence: [] },
        ] },
      ],
    };
    response = { ok: true, json: async () => historical };
    await click(byTest("skills-load"));
    assert.equal(document.querySelector('[role="alert"]'), null);
    assert(document.body.textContent.includes("truncated"));
    assert(document.body.textContent.includes("7 invoiced jobs"));
    assert(document.body.textContent.includes("excluding credits"));
    assert(document.body.textContent.includes("not a verified task completion time"));
    assert(document.body.textContent.includes("3 multi-technician jobs"));
    assert(document.body.textContent.includes("RO 18427"));
    assert(document.body.textContent.includes("not proof of independent capability"));
    assert(!document.body.textContent.includes("Not a local technician"));
    const suggestion = byTest("skill-form-local-alignment");
    suggestion.querySelector('[name="status"]').value = "not-qualified";
    await submit(suggestion);
    assert.equal(commands.at(-1).command.status, "not-qualified");
    assert.equal(commands.at(-1).revision, 21);
    edit.querySelector('[name="status"]').value = "remove";
    dom.window.confirm = () => false;
    const before = commands.length;
    await submit(edit);
    assert.equal(commands.length, before, "removal needs confirmation");
    dom.window.confirm = () => true;
    await submit(edit);
    assert.equal(commands.at(-1).command.status, "remove");
    assert.equal(commands.at(-1).revision, 18, "successful edit advances only its own pinned base");
    board = { ...board, technicians: [{ ...tech, skills: [] }] };
    await render();
    assert(document.body.textContent.includes("RO 18427"), "removing assessment leaves historical evidence");
    response = { ok: true, json: async () => ({ truncated: false, profiles: [{ technicianId: "local", skills: "invalid" }] }) };
    await click(byTest("skills-load"));
    assert(document.querySelector('[role="alert"]').textContent.includes("response was invalid"));
    assert(!document.body.textContent.includes("RO 18427"), "failed reload clears stale evidence");
    response = { ok: true, json: async () => ({ truncated: false, profiles: [] }) };
    await click(byTest("skills-load"));
    assert(document.body.textContent.includes("No historical service titles returned"));
    // Verify the visible loading state with a deliberately held request.
    let release;
    global.fetch = () => new Promise(resolve => { release = resolve; });
    await click(byTest("skills-load"));
    assert(document.querySelector('[aria-label="Loading skill history"]'));
    assert(byTest("skills-load").disabled);
    await act(async () => release(response));
    assert.equal(document.querySelector('[aria-label="Loading skill history"]'), null);
    const manySkills = Array.from({ length: 63 }, (_, index) => ({
      key: `service ${index}`, title: `Service ${index}`, count: index + 1,
      lastCompletedAt: null, sharedJobCount: 0,
      evidence: [{ ro: `RO-${index}`, title: `Service ${index}`, completedAt: null, shared: false }],
    }));
    response = { ok: true, json: async () => ({
      truncated: false, profiles: [{ technicianId: "local", sourceId: null, skills: manySkills }],
    }) };
    global.fetch = async () => response;
    await click(byTest("skills-load"));
    assert(byTest("skills-count-local").textContent.includes("Showing 25 of 63"));
    assert(byTest("skill-form-local-service 24"));
    assert.equal(byTest("skill-form-local-service 25"), null, "off-page forms are not mounted");
    await click(byTest("skills-more-local"));
    assert(byTest("skills-count-local").textContent.includes("Showing 50 of 63"));
    assert(byTest("skill-form-local-service 49"));
    assert.equal(byTest("skill-form-local-service 50"), null);
    const search = byTest("skills-search");
    const searchFor = async value => act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(search, value);
      search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await searchFor("SERVICE 62");
    assert(byTest("skills-count-local").textContent.includes("Showing 1 of 1"));
    assert(byTest("skill-form-local-service 62"));
    assert.equal(byTest("skill-form-local-service 0"), null);
    assert(document.body.textContent.includes("63 invoiced jobs"), "filtered entry retains counts");
    assert(document.body.textContent.includes("RO RO-62"), "filtered entry retains evidence");
    assert.equal(byTest("skills-more-local"), null);
    await searchFor("no matching service");
    assert(document.body.textContent.includes("No historical titles match this search"));
    await searchFor("");
    assert(byTest("skills-count-local").textContent.includes("Showing 25 of 63"), "changing search resets pagination");
    await click(byTest("skills-more-local"));
    await click(byTest("skills-more-local"));
    assert(byTest("skills-count-local").textContent.includes("Showing 63 of 63"));
    assert.equal(byTest("skills-more-local"), null, "show-more disappears at end");
    await render({ actor: { manager: false } });
    assert.equal(byTest("skills-load"), null, "non-managers cannot access skill UI");
    board = { revision: 22, technicians: [] };
    await render();
    assert(document.body.textContent.includes("No local technicians yet"));
    assert(byTest("skills-load").disabled);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(global, previous);
  }
});
