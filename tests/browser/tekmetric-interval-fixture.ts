/**
 * Offline fixture for the real Tekmetric content-script print button/menu.
 * Extract the production implementation at runtime rather than copying it into tests.
 * No extension startup, background worker, network requests, or printer is used.
 */
import fs from "node:fs";
import path from "node:path";

export function fixtureHtml() {
  const source = fs.readFileSync(path.resolve("mos-tools-extension/adapters/tekmetric-content.js"), "utf8");
  const begin = source.indexOf("// ==================== MOS PRINT BUTTON ====================");
  const end = source.indexOf("function getVehicleDetails()", begin);
  if (begin < 0 || end < 0) throw new Error("Tekmetric print/menu extraction boundaries changed");
  // Avoid a literal </script> inside the embedded production JS terminating the HTML tag.
  const realCode = source.slice(begin, end).replace(/<\/script/gi, "<\\/script");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Tekmetric interval menu fixture</title>
<style>
  html, body { margin: 0; font: 14px sans-serif; }
  #sidebar { position: fixed; left: 0; top: 0; bottom: 0; width: 260px; background: #182a41; color: white; }
  #sidebar.closed { width: 48px; }
  #workspace { margin-left: 260px; height: 1800px; background: #f6f8fa; }
  #sidebar.closed + #workspace { margin-left: 48px; }
  #header { position: absolute; left: 320px; top: 80px; display: flex; align-items: center; background: white; padding: 8px; border: 1px solid #ccc; }
  #outside { position: fixed; left: 50%; top: 50%; }
</style></head><body>
<aside id="sidebar">Tekmetric</aside><main id="workspace"><div id="header" class="action-bar">
<button title="Print" data-testid="print" type="button">Print</button></div></main>
<button id="outside">Outside</button>
<script>
  window.calls = [];
  window.pendingConfig = [];
  window.configMode = "immediate";
  window.configResult = null;
  window.trackedListeners = { added: [], removed: [] };
  for (const target of [document, window]) {
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    target.addEventListener = function(type, callback, options) {
      if (["click", "scroll", "resize", "keydown"].includes(type)) window.trackedListeners.added.push({ target: target === window ? "window" : "document", type, callback });
      return add(type, callback, options);
    };
    target.removeEventListener = function(type, callback, options) {
      if (["click", "scroll", "resize", "keydown"].includes(type)) window.trackedListeners.removed.push({ target: target === window ? "window" : "document", type, callback });
      return remove(type, callback, options);
    };
  }
  window.chrome = { runtime: { getURL: () => "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=" } };
  function detectContext() { return { roId: "fixture-ro", shopId: "fixture-shop", provider: "tekmetric" }; }
  function getVehicleDetails() { return { year: 2020, make: "Test" }; }
  function showToast(text, level) { window.calls.push({ action: "TOAST", text, level }); }
  function reportActionDropped() { throw new Error("Unexpected print failure"); }
  function printStickerFromContentScript(sticker) { window.calls.push({ action: "PRINT_STUB", sticker }); }
  function openStickerPanel() { window.calls.push({ action: "CUSTOMIZE" }); }
  function safeSendMessage(message, callback) {
    window.calls.push(message);
    if (message.action === "GET_STICKER_CONFIG") {
      if (window.configMode === "delayed") window.pendingConfig.push(callback);
      else setTimeout(() => callback(window.configResult), 0);
    }
    if (message.action === "PRINT_STICKER_IMMEDIATE") {
      setTimeout(() => callback({ success: true, sticker: "offline-sticker" }), 0);
    }
  }
  window.resolveConfig = (value) => {
    window.pendingConfig.splice(0).forEach(callback => callback(value));
  };
</script>
<script>${realCode}</script>
<script>injectPrintButton();</script>
</body></html>`;
}