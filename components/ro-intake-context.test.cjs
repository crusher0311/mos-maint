const {test} = require("node:test");
const assert = require("node:assert/strict");
const {build} = require("esbuild");
const Module = require("node:module");
const path = require("node:path");
const React = require("react");
const {JSDOM} = require("jsdom");

test("confirmed intake starts once; changed context rejects late results and unconfirmed values remain hidden", async () => {
  const bundle = await build({entryPoints: [path.join(__dirname, "ROIntakeContext.tsx")], bundle: true,
    write: false, platform: "node", format: "cjs", jsx: "automatic", external: ["react"]});
  const compiled = new Module(path.join(__dirname, "intake-test.cjs"), module);
  compiled.filename = path.join(__dirname, "intake-test.cjs");
  compiled.paths = module.paths; compiled._compile(bundle.outputFiles[0].text, compiled.filename);
  const {ROIntakeContext} = compiled.exports;
  const dom = new JSDOM("<div id='root'></div>", {url: "http://offline.invalid"});
  const keys = ["window", "document", "navigator", "fetch", "IS_REACT_ACT_ENVIRONMENT"];
  const previous = Object.fromEntries(keys.map(k => [k, global[k]]));
  global.window = dom.window; global.document = dom.window.document;
  Object.defineProperty(global, "navigator", {value: dom.window.navigator, configurable: true});
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const requests = [];
  global.fetch = (_url, options) => new Promise(resolve => requests.push({options, resolve}));
  const {createRoot} = require("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  const props = {enabled: false, scope: "shop-one:draft-one", vin: "1HGCM82633A004352", mileage: "42000", unit: "miles", confirmed: false};
  const render = async patch => {Object.assign(props, patch); await React.act(async () => root.render(React.createElement(ROIntakeContext, props)));};
  const reply = async (index, title) => React.act(async () => requests[index].resolve({
    ok: true, json: async () => ({status: "available", coverage: "unknown", checks: [{title, timing: "dueSoon"}]}),
  }));
  try {
    await render({});
    assert.equal(requests.length, 0);
    await render({confirmed: true});
    assert.equal(requests.length, 0, "DVI off must not request optional context");
    assert.equal(document.body.textContent, "");
    await render({enabled: true});
    assert.equal(requests.length, 1);
    await render({});
    assert.equal(requests.length, 1);
    await render({mileage: "43000"});
    assert.equal(requests.length, 2);
    assert.equal(requests[0].options.signal.aborted, true);
    await reply(0, "STALE CHECK");
    assert.equal(document.body.textContent.includes("STALE CHECK"), false);
    await reply(1, "CURRENT CHECK");
    assert.equal(document.body.textContent.includes("CURRENT CHECK"), true);
    assert.equal(JSON.parse(requests[1].options.body).mileage, 43000);
    await render({confirmed: false});
    assert.equal(document.body.textContent.includes("CURRENT CHECK"), false);
    await render({confirmed: true, scope: "shop-two:draft-two"});
    assert.equal(requests.length, 3);
    await render({enabled: false});
    assert.equal(requests[2].options.signal.aborted, true);
    await reply(2, "REVOKED CHECK");
    assert.equal(document.body.textContent, "", "disabling DVI cancels and hides late context");
    assert.equal(requests.length, 3);
  } finally {
    await React.act(async () => root.unmount());
    for (const key of keys) Object.defineProperty(global, key, {value: previous[key], configurable: true, writable: true});
    dom.window.close();
  }
});
