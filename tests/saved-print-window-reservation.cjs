const fs = require("node:fs"), vm = require("node:vm"), ts = require("typescript"), assert = require("node:assert/strict");
const source = fs.readFileSync("components/printing/useSavedPrinting.tsx", "utf8");
const body = source.slice(source.indexOf("  function choose("), source.indexOf("  function finish("));
for (const mode of ["browser-default", "explicit-browser", "ipp"]) {
  let opens = 0;
  const window = {};
  const destination = { id: "saved", kind: "sticker", online: true, supported: true };
  const context = {
    locked: { current: false }, cache: { current: { sticker: { destinations: [destination] } } },
    overrideNext: { current: {} }, browserNext: { current: { sticker: mode === "explicit-browser" } },
    preparingAction: { current: null }, crypto: { randomUUID: () => "synthetic" },
    refreshControls() {}, resolvedDefault: () => mode === "ipp" ? "saved" : null,
    isMobilePrintBrowser: () => false,
    openMobilePlaceholderWindow: () => { opens++; return window; },
  };
  vm.runInNewContext(ts.transpileModule(body + "\nthis.choose = choose;", { compilerOptions: { target: ts.ScriptTarget.ES2021 } }).outputText, context);
  const promise = context.choose("sticker", false, true);
  assert.equal(opens, mode === "ipp" ? 0 : 1, "Window must be reserved before the caller awaits");
  assert(promise && typeof promise.then === "function");
}
console.log("PASS actual choose path reserves browser windows synchronously, never for IPP");
