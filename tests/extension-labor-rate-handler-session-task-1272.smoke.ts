/**
 * Executes the actual Rates message-handler branches against a small service
 * worker fixture. A queued A-session request is presented after the worker has
 * admitted B, and an APPLY request is rotated during bootstrap. Neither path
 * may reach MOS/provider writes.
 *
 * Run: `npx tsx tests/extension-labor-rate-handler-session-task-1272.smoke.ts`
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as vm from "node:vm";

const background = readFileSync(
  join(__dirname, "..", "mos-tools-extension", "background.js"),
  "utf8",
);
const section = (startMarker: string, endMarker: string) => {
  const start = background.indexOf(startMarker);
  const end = background.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `missing source section ${startMarker}`);
  return background.slice(start, end);
};
const helpers = section(
  "function normalizeLaborRateProvider(provider)",
  "async function fetchLaborRateRules(",
);
const autoApply = section(
  "async function autoApplyLaborRate(context, options = {})",
  "async function applyLaborRatePerJob(",
);
const handlerBranches = section(
  'if (message.action === "GET_LABOR_RATE_RULES")',
  "// -------------------- Concern Assistant --------------------",
);

const markerA = "lr-session-a";
const markerB = "lr-session-b";
const contextA = {
  provider: "tekmetric",
  shopId: 14245,
  roId: 9001,
  _tabId: 7,
  laborRateSessionDiscriminator: markerA,
};
const contextB = { ...contextA, laborRateSessionDiscriminator: markerB };

let expectedMarker = markerB;
let mosWrites = 0;
let providerWrites = 0;
let bootstrapCalls = 0;
const responses: any[] = [];

const sandbox: any = {
  console,
  activeTabId: 7,
  authEpoch: 4,
  mosApiToken: "mos-session-b",
  mosApiUrl: "https://mos.tools",
  mosSessionTier: { canMutate: true },
  currentSmsContext: contextB,
  smsContextsByTab: new Map([[7, contextB]]),
  tekmetricProofsByTab: new Map(),
  laborRateProviderSessionGenerationByTab: new Map(),
  laborRateSessionDiscriminatorForTab: () => expectedMarker,
  capturedLaborRateSessionIdentityForTab: () => `private-${expectedMarker}`,
  _stateReady: Promise.resolve(),
  ensureBootstrapBoundToActiveTab: async () => {
    bootstrapCalls += 1;
    expectedMarker = markerB;
    sandbox.currentSmsContext = contextB;
    sandbox.smsContextsByTab.set(7, contextB);
  },
  handleMosApiRequest: async () => {
    mosWrites += 1;
    throw new Error("unexpected MOS write");
  },
  fetchLaborRateRules: async () => {
    mosWrites += 1;
    throw new Error("unexpected MOS labor-rate read");
  },
  tekmetricFetch: async () => {
    providerWrites += 1;
    throw new Error("unexpected provider write");
  },
  laborRateRulesRevision: 0,
  laborRateRulesRequestSequence: 0,
  laborRateRulesCache: new Map(),
  laborRateRules: [],
  laborRateRulesLastFetch: 0,
  laborRateRulesShopId: null,
  laborRateRulesSmsShopId: null,
  activeSmsShopId: null,
  lastAppliedRoId: null,
  lastAppliedLaborRateContextKey: null,
  sendResponse: null,
  chrome: {
    storage: {
      local: { set: async () => {} },
      session: { set: async () => {} },
    },
    runtime: { sendMessage: () => Promise.resolve() },
  },
};
vm.createContext(sandbox);
vm.runInContext(
  `${helpers}
   ${autoApply}
   function __ratesHandler(message, sender, sendResponse) {
     ${handlerBranches}
   }
   this.__ratesHandler = __ratesHandler;`,
  sandbox,
);

async function invoke(message: any) {
  const branchResponse: any[] = [];
  const returned = sandbox.__ratesHandler(
    message,
    { tab: { id: 7 } },
    (response: any) => branchResponse.push(response),
  );
  await new Promise((resolve) => setImmediate(resolve));
  return { returned, response: branchResponse[0] };
}

async function run() {
  console.log("Task #1272: Rates handler session admission");

  // A was queued while active, then B was admitted before the message handler
  // ran. The stale discriminator must fail before GET/PUT work starts.
  expectedMarker = markerB;
  sandbox.currentSmsContext = contextB;
  sandbox.smsContextsByTab.set(7, contextB);
  const staleGet = await invoke({
    action: "GET_LABOR_RATE_RULES",
    context: contextA,
  });
  assert.equal(staleGet.response.success, false);
  assert.equal(staleGet.response.code, "STALE_LABOR_RATE_SESSION");
  assert.equal(mosWrites, 0);
  assert.equal(providerWrites, 0);

  const staleSave = await invoke({
    action: "SAVE_LABOR_RATE_RULES",
    context: contextA,
    rules: [{ name: "stale" }],
  });
  assert.equal(staleSave.response.success, false);
  assert.equal(staleSave.response.code, "STALE_LABOR_RATE_SESSION");
  assert.equal(mosWrites, 0);
  assert.equal(providerWrites, 0);

  // A is admitted, but bootstrap rotates the active session before the
  // actual apply flow can read rules or issue a provider mutation.
  expectedMarker = markerA;
  sandbox.currentSmsContext = contextA;
  sandbox.smsContextsByTab.set(7, contextA);
  const apply = await invoke({
    action: "APPLY_LABOR_RATE_NOW",
    context: contextA,
  });
  assert.equal(bootstrapCalls, 1);
  assert.equal(apply.response.success, false);
  assert.equal(apply.response.code, "STALE_LABOR_RATE_CONTEXT");
  assert.equal(mosWrites, 0);
  assert.equal(providerWrites, 0);

  console.log("✓ queued A GET/SAVE requests reject after B admission");
  console.log("✓ A APPLY rejects during bootstrap before MOS/provider writes");
  console.log("All handler session-admission assertions passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
