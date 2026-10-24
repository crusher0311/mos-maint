const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const source = fs.readFileSync("mos-tools-extension/sidepanel.js", "utf8");
const start = source.indexOf("function applyShopFeatures(result)");
const end = source.indexOf("let featureExpiryTimer;", start);
let now = 1000;
let timer;
let refreshes = 0;
const context = vm.createContext({
  Date: { now: () => now, parse: Date.parse },
  clearTimeout: () => {},
  setTimeout: (fn) => { timer = fn; return 1; },
  featureExpiryTimer: null,
  shopFeatures: {},
  renderSessionTierBanner() {},
  updateTabAccessibility() {},
  renderFloatingButtonSetting() {},
  fetchShopFeatures() { refreshes++; },
  currentContext: null,
});
vm.runInContext(source.slice(start, end), context);
context.applyShopFeatures({
  features: { maintenance: true, keytags: true },
  eligibility: { eligibleUntil: new Date(2000).toISOString() },
  postExpiryFeatures: { maintenance: false, keytags: true },
});
assert.equal(context.shopFeatures.maintenance, true);
now = 2000;
timer();
assert.equal(context.shopFeatures.maintenance, false);
assert.equal(context.shopFeatures.keytags, true);
assert.equal(refreshes, 1);
// Successful authoritative refresh removes previously granted controls.
context.applyShopFeatures({ features: { maintenance: false, keytags: false } });
assert.equal(context.shopFeatures.keytags, false);
console.log("Open-panel expiry and successful permission refresh passed.");
