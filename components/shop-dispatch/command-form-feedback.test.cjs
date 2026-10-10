// Offline component regression: synthetic submissions, no API or server calls.
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const { test } = require("node:test");
const { build } = require("esbuild");
const React = require("react");
const { act } = React;
const { createRoot } = require("react-dom/client");
const { JSDOM } = require("jsdom");

test("CommandForm announces failures in the error class, preserves drafts, and announces success as status", async () => {
  const bundle = await build({
    stdin: { contents: 'export {CommandForm} from "./CommandForm";', resolveDir: __dirname, loader: "tsx" },
    bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic",
    external: ["react", "react-dom"],
    plugins: [{ name: "offline-css", setup(build) {
      build.onLoad({ filter: /\.module\.css$/ }, () => ({
        contents: 'export default new Proxy({}, {get: (_, key) => key})', loader: "js",
      }));
    } }],
  });
  const compiled = new Module(path.join(__dirname, "offline-command-feedback.cjs"), module);
  compiled.filename = path.join(__dirname, "offline-command-feedback.cjs");
  compiled.paths = module.paths;
  compiled._compile(bundle.outputFiles[0].text, compiled.filename);
  const { CommandForm } = compiled.exports;
  const dom = new JSDOM("<div id='root'></div>", { url: "http://offline.invalid" });
  const previous = {
    window: global.window, document: global.document,
    FormData: global.FormData, IS_REACT_ACT_ENVIRONMENT: global.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(global, {
    window: dom.window, document: dom.window.document,
    FormData: dom.window.FormData, IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.getElementById("root"));
  const calls = [];
  let result = "false";
  try {
    await act(async () => root.render(React.createElement(CommandForm, {
      testId: "feedback-form", busy: false, reset: true, revision: 23,
      submit: async (data, revision) => {
        calls.push({ name: data.get("name"), reviewed: data.get("reviewed"), lane: data.get("lane"), revision });
        if (result === "throw") throw new Error("This provider candidate is no longer available. Reload the roster.");
        return result === "success";
      },
    }, React.createElement("input", { name: "name", defaultValue: "Initial name" }),
    React.createElement("input", { type: "checkbox", name: "reviewed" }),
    React.createElement("select", { name: "lane", defaultValue: "" },
      React.createElement("option", { value: "" }, "Create lane"),
      React.createElement("option", { value: "existing" }, "Existing lane")))));
    const form = document.querySelector("form");
    const name = form.querySelector('[name="name"]');
    const reviewed = form.querySelector('[name="reviewed"]');
    const lane = form.querySelector('[name="lane"]');
    name.value = "Manager-entered name";
    reviewed.checked = true;
    lane.value = "existing";
    const submit = () => act(async () => form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
    const assertDraft = () => {
      assert.equal(name.value, "Manager-entered name");
      assert.equal(reviewed.checked, true);
      assert.equal(lane.value, "existing");
      assert.equal(form.querySelector("fieldset").disabled, false);
      assert.equal(form.querySelector('button[type="submit"]').textContent, "Save");
      assert(form.querySelector('[data-testid="feedback-form-base-revision"]').textContent.includes("Form base revision 23"));
    };

    await submit();
    let alert = form.querySelector('[role="alert"]');
    assert(alert.textContent.startsWith("Not saved."));
    assert(alert.textContent.includes("Entries and their base revision are preserved"));
    assert.equal(alert.className, "error", "failure must use the module's red styles.error class");
    assert.equal(form.querySelector('[role="status"]'), null);
    assertDraft();

    result = "throw";
    await submit();
    alert = form.querySelector('[role="alert"]');
    assert.equal(alert.textContent, "Not saved. This provider candidate is no longer available. Reload the roster.");
    assert.equal(alert.className, "error");
    assert.equal(form.querySelector('[role="status"]'), null);
    assertDraft();

    result = "success";
    await submit();
    assert.equal(form.querySelector('[role="alert"]'), null);
    const status = form.querySelector('[role="status"]');
    assert.equal(status.textContent, "Saved to the pilot.");
    assert(!status.classList.contains("error"), "success must not retain error styling");
    assert.equal(name.value, "Initial name", "reset is allowed only after successful save");
    assert.equal(reviewed.checked, false);
    assert.equal(lane.value, "");
    assert.deepEqual(calls, Array.from({ length: 3 }, () => ({
      name: "Manager-entered name", reviewed: "on", lane: "existing", revision: 23,
    })));
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(global, previous);
  }
});
