import assert from "node:assert/strict";

const core = require("../mos-tools-extension/tekmetric-session-recovery-core.js");

const contextA = { provider: "tekmetric", shopId: "85", roId: "1001" };
const contextB = { provider: "tekmetric", shopId: "85", roId: "1002" };

async function run() {
  console.log("Tekmetric same-tab session recovery");
  let activeTabId = 7;
  let currentContext = contextA;
  let session: unknown = null;
  let triggers = 0;

  const recovered = await core.recover({
    tabId: 7,
    expectedContext: contextA,
    getActiveTabId: () => activeTabId,
    getCurrentContext: () => currentContext,
    getSession: () => session,
    trigger: async () => {
      triggers++;
      session = { token: "memory-only", origin: "https://shop.tekmetric.com", tabId: 7 };
    },
    wait: async () => {},
  });
  assert.equal(triggers, 1);
  assert.deepEqual(recovered, session);
  console.log("  ✓ recovers proof after worker-memory loss");

  session = null;
  activeTabId = 8;
  const wrongTab = await core.recover({
    tabId: 7,
    expectedContext: contextA,
    getActiveTabId: () => activeTabId,
    getCurrentContext: () => contextA,
    getSession: () => session,
    trigger: async () => { throw new Error("must not trigger"); },
    wait: async () => {},
  });
  assert.equal(wrongTab, null);
  console.log("  ✓ refuses another active tab");

  activeTabId = 7;
  currentContext = contextB;
  const wrongRo = await core.recover({
    tabId: 7,
    expectedContext: contextA,
    getActiveTabId: () => activeTabId,
    getCurrentContext: () => currentContext,
    getSession: () => session,
    trigger: async () => { throw new Error("must not trigger"); },
    wait: async () => {},
  });
  assert.equal(wrongRo, null);
  console.log("  ✓ refuses stale same-tab RO context");

  currentContext = contextA;
  let now = 0;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const timedOut = await core.recover({
      tabId: 7,
      expectedContext: contextA,
      getActiveTabId: () => activeTabId,
      getCurrentContext: () => currentContext,
      getSession: () => null,
      trigger: async () => {},
      wait: async (ms: number) => { now += ms; },
      timeoutMs: 100,
      pollMs: 25,
    });
    assert.equal(timedOut, null);
  } finally {
    Date.now = realNow;
  }
  console.log("  ✓ exits bounded recovery when proof is unavailable");

  assert.equal(core.isAllowedOrigin("https://shop.tekmetric.com"), true);
  assert.equal(core.isAllowedOrigin("https://sandbox.tekmetric.com"), true);
  assert.equal(core.isAllowedOrigin("https://eviltekmetric.com"), false);
  console.log("  ✓ accepts only exact Tekmetric origins");

  const staleCachedContext = contextA;
  void staleCachedContext;
  const navigatedBeforeWrite = await core.requestStillCurrent({
    tabId: 7,
    expectedContext: contextA,
    session: { origin: "https://shop.tekmetric.com" },
    getActiveTabId: () => 7,
    getLiveContext: async () => ({ ...contextB, _pageUrl: "https://shop.tekmetric.com/ro/1002" }),
    getTabState: async () => ({ origin: "https://shop.tekmetric.com", url: "https://shop.tekmetric.com/ro/1002" }),
  });
  assert.equal(navigatedBeforeWrite, false);
  console.log("  ✓ blocks a write when live RO changes during authorization");

  const changedHostBeforeWrite = await core.requestStillCurrent({
    tabId: 7,
    expectedContext: contextA,
    session: { origin: "https://shop.tekmetric.com" },
    getActiveTabId: () => 7,
    getLiveContext: async () => ({ ...contextA, _pageUrl: "https://sandbox.tekmetric.com/ro/1001" }),
    getTabState: async () => ({ origin: "https://sandbox.tekmetric.com", url: "https://sandbox.tekmetric.com/ro/1001" }),
  });
  assert.equal(changedHostBeforeWrite, false);
  console.log("  ✓ blocks a write when the same tab changes Tekmetric host");

  let switchedDuringValidation = false;
  const switchedTabDuringValidation = await core.requestStillCurrent({
    tabId: 7,
    expectedContext: contextA,
    session: { origin: "https://shop.tekmetric.com" },
    getActiveTabId: () => switchedDuringValidation ? 8 : 7,
    getLiveContext: async () => {
      switchedDuringValidation = true;
      return { ...contextA, _pageUrl: "https://shop.tekmetric.com/ro/1001" };
    },
    getTabState: async () => ({ origin: "https://shop.tekmetric.com", url: "https://shop.tekmetric.com/ro/1001" }),
  });
  assert.equal(switchedTabDuringValidation, false);
  console.log("  ✓ blocks a write when the active tab changes during validation");

  const navigatedDuringValidation = await core.requestStillCurrent({
    tabId: 7,
    expectedContext: contextA,
    session: { origin: "https://shop.tekmetric.com" },
    getActiveTabId: () => 7,
    getLiveContext: async () => ({ ...contextA, _pageUrl: "https://shop.tekmetric.com/ro/1001" }),
    getTabState: async () => ({ origin: "https://shop.tekmetric.com", url: "https://shop.tekmetric.com/ro/1002" }),
  });
  assert.equal(navigatedDuringValidation, false);
  console.log("  ✓ blocks a write when the RO URL changes during validation");
  console.log("Tekmetric same-tab session recovery: PASS");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});