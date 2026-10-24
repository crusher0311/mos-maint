// Isolated DOM lifecycle checks. No Next app, canvas, network, or shared stores.
// Run: node --test components/sticker-designer/StickerDesigner.lifecycle.test.cjs
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { JSDOM } = require("jsdom");

test("sticker controls, custom text limits, selection and history are Strict Mode safe", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost/" });
  const globals = ["window", "document", "navigator", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"];
  const saved = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of globals.slice(0, 4)) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const React = require("react");
  const { createRoot } = require("react-dom/client");
  const { act } = React;
  const h = React.createElement;
  let canvasProps;
  let toolbarProps;
  const calls = [];

  function load(filename, dependencies = {}) {
    const fullPath = path.join(__dirname, filename);
    const output = ts.transpileModule(fs.readFileSync(fullPath, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const module = { exports: {} };
    const localRequire = (name) => {
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      if (["react", "react/jsx-runtime", "lucide-react"].includes(name)) return require(name);
      throw new Error(`Unexpected dependency in isolated UI test: ${name}`);
    };
    vm.runInThisContext(`(function(require,module,exports){${output}\n})`, { filename: fullPath })(localRequire, module, module.exports);
    return module.exports;
  }
  const colors = load("../../lib/sticker-colors.ts", { "color-string": { default: require("color-string") } });
  const types = load("../../lib/sticker-designer-types.ts", { "./sticker-colors": colors });
  const colorInput = load("StickerTextColorInput.tsx", { "@/lib/sticker-colors": colors });
  const panel = load("StickerElementPanel.tsx", {
    "@/lib/sticker-designer-types": types, "./StickerTextColorInput": colorInput,
  });
  const { StickerDesigner } = load("StickerDesigner.tsx", {
    "@/lib/sticker-designer-types": types,
    "./StickerElementPanel": panel,
    "./StickerDesignerCanvas": { StickerDesignerCanvas: (props) => { canvasProps = props; return h("div", { "data-testid": "canvas-stub" }); } },
    "./StickerToolbarPanel": { StickerToolbarPanel: (props) => { toolbarProps = props; return h("div", null,
      h("button", { onClick: props.onUndo, disabled: !props.canUndo }, "Undo"),
      h("button", { onClick: props.onRedo, disabled: !props.canRedo }, "Redo"),
    ); } },
  });
  let root;
  const container = document.getElementById("root");
  const button = (text) => [...container.querySelectorAll("button")].find((item) => item.textContent.trim() === text || item.getAttribute("aria-label") === text);
  const click = async (text) => {
    const target = button(text);
    assert.ok(target, `button ${text} exists`);
    await act(async () => target.click());
  };
  const select = async (id) => act(async () => canvasProps.onSelectElement(id));
  const edit = async (value) => {
    const input = container.querySelector("#sticker-element-content");
    assert.ok(input);
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };
  const selected = () => canvasProps.layout.elements.find((el) => el.id === canvasProps.selectedId);
  const mount = async (initialLayout = types.createDefaultLayout()) => {
    if (root) await act(async () => root.unmount());
    root = createRoot(container);
    calls.length = 0;
    await act(async () => root.render(h(React.StrictMode, null, h(StickerDesigner, {
      initialLayout, onChange: (layout, size) => calls.push({ layout, size }),
    }))));
    assert.equal(calls.length, 0, "mount does not notify parent");
  };
  try {
    await mount();
    await select("serviceLabel");
    await click("Underline");
    assert.equal(selected().underline, true);
    assert.equal(calls.length, 1, "one notification per edit under Strict Mode");
    await click("Undo");
    assert.equal(selected().id, "serviceLabel");
    assert.equal(selected().underline, undefined);
    await click("Redo");
    assert.equal(selected().underline, true);

    await click("Add custom text");
    const id = selected().id;
    assert.equal(selected().type, "text");
    await edit("Ask about tire rotation");
    assert.equal(selected().content, "Ask about tire rotation");
    await edit("x".repeat(230) + "\nsecond line");
    assert.equal(selected().content.length, 200);
    assert.ok(!selected().content.includes("\n"));
    await edit("First line\nSecond line");
    assert.equal(selected().content, "First lineSecond line", "native single-line input strips line breaks");
    await act(async () => canvasProps.onUpdateElement(id, { content: "First line\nSecond line" }));
    assert.equal(selected().content, "First line Second line");
    const notificationsBeforeBatch = calls.length;
    await act(async () => {
      canvasProps.onUpdateElement(id, { color: "#334455" });
      canvasProps.onUpdateElement(id, { fontSize: 17 });
    });
    assert.equal(selected().color, "#334455", "batched edits keep the latest snapshot");
    assert.equal(selected().fontSize, 17);
    assert.equal(calls.length, notificationsBeforeBatch + 2, "exactly one notification per batched edit");
    const textInput = container.querySelector("#sticker-element-content");
    const nativeUndo = new dom.window.KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => textInput.dispatchEvent(nativeUndo));
    assert.equal(nativeUndo.defaultPrevented, false, "typing retains native input undo");
    assert.equal(calls.length, notificationsBeforeBatch + 2);
    await click("Underline");
    assert.equal(selected().underline, true);
    for (const name of ["Background", "Border"]) {
      const label = [...container.querySelectorAll("label")].find((item) => item.textContent.trim() === name);
      await act(async () => label.querySelector("input").click());
    }
    assert.equal(selected().backgroundColor, "#ffffff");
    assert.equal(selected().borderWidth, 1);
    const thickness = container.querySelector('[aria-label="Border thickness"]');
    assert.equal(thickness.step, "0.5");
    assert.equal(thickness.min, "0.5");
    assert.equal(thickness.max, "4");
    await act(async () => canvasProps.onUpdateElement(id, { borderWidth: 8 }));
    assert.equal(selected().borderWidth, 4);
    await act(async () => canvasProps.onUpdateElement(id, { borderWidth: 0.1 }));
    assert.equal(selected().borderWidth, 0.5);
    await act(async () => canvasProps.onUpdateElement(id, { borderWidth: 1.7 }));
    assert.equal(selected().borderWidth, 1.5);
    await click("Clear background");
    await click("Clear border");
    assert.equal(selected().backgroundColor, undefined);
    assert.equal(selected().borderColor, undefined);
    assert.equal(selected().borderWidth, undefined);

    dom.window.confirm = () => false;
    await click("Remove custom text");
    assert.equal(selected().id, id, "cancel preserves text");
    dom.window.confirm = () => true;
    await click("Remove custom text");
    assert.equal(canvasProps.selectedId, null);
    assert.ok(!canvasProps.layout.elements.some((el) => el.id === id));
    await click("Undo");
    assert.equal(selected().id, id, "undo removal restores selection");
    await click("Redo");
    assert.equal(canvasProps.selectedId, null);
    await click("Undo");
    await edit("Branch edit");
    assert.equal(toolbarProps.canRedo, false, "new edit truncates redo branch");

    await select("serviceLabel");
    await edit("Return for oil service");
    await click("Use shop default");
    assert.equal(selected().content, undefined, "clear preserves service label inheritance");
    assert.ok(!button("Remove custom text"), "built-in elements cannot be removed");
    await select("logo");
    assert.ok(button("contain"), "logo fit controls preserved");
    assert.ok(!button("Underline"), "text styling is not offered for images");
    await select("qrCode");
    assert.ok(!button("Remove custom text"), "QR cannot be removed");

    await mount();
    for (let i = 0; i < types.MAX_CUSTOM_TEXT_ELEMENTS; i++) await click("Add custom text");
    assert.equal(button("Add custom text").disabled, true);
    assert.equal(canvasProps.layout.elements.filter((el) => el.type === "text").length, 12);
    const ids = canvasProps.layout.elements.map((el) => el.id);
    assert.equal(new Set(ids).size, ids.length);
    await click("Undo");
    assert.equal(button("Add custom text").disabled, false);
    await click("Redo");
    assert.equal(button("Add custom text").disabled, true);

    const full = types.createDefaultLayout();
    full.elements = Array.from({ length: 32 }, (_, i) => ({ ...full.elements[0], id: `existing-${i}` }));
    await mount(full);
    assert.equal(button("Add custom text").disabled, true, "total element limit enforced independently");

    await mount();
    await select("serviceLabel");
    for (let i = 0; i < 56; i++) {
      await act(async () => canvasProps.onUpdateElement("serviceLabel", { content: `Service ${i}` }));
    }
    for (let i = 0; i < 49; i++) await click("Undo");
    assert.equal(toolbarProps.canUndo, false, "history remains capped at 50 snapshots");
    assert.equal(selected().content, "Service 6");
    await click("Redo");
    assert.equal(selected().content, "Service 7");
  } finally {
    if (root) await act(async () => root.unmount());
    dom.window.close();
    for (const key of globals) {
      const descriptor = saved.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
