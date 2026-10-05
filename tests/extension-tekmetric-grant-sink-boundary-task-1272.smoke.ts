/**
 * Executes the real requestProviderActionGrant -> tekmetricFetch ->
 * tekSingleAttempt chain. The provider/SMS shop ID intentionally differs
 * from the internal MOS shop ID in the signed receipt.
 *
 * Run: `npx tsx tests/extension-tekmetric-grant-sink-boundary-task-1272.smoke.ts`
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as vm from "node:vm";

const background = readFileSync(
  join(__dirname, "..", "mos-tools-extension", "background.js"),
  "utf8",
);
const grantCore = createRequire(import.meta.url)(
  "../mos-tools-extension/provider-action-grant-core.js",
);

const grantStart = background.indexOf("async function consumeProviderActionGrant(");
const grantEnd = background.indexOf("// Passwordless sign-in step 1:", grantStart);
const sessionStart = background.indexOf("function tekmetricSessionForContext(");
const sinkStart = background.indexOf("async function tekSingleAttempt(");
const fetchStart = background.indexOf("async function tekmetricFetch(");
const fetchEnd = background.indexOf("async function handleTekmetricApiRequest(", fetchStart);
const backoffStart = background.indexOf("async function tekmetricFetchWithBackoff(");
const backoffEnd = background.indexOf("// ==================== TEKMETRIC ENDPOINT REPORTER", backoffStart);
assert.ok(grantStart >= 0 && grantEnd > grantStart);
assert.ok(sessionStart >= 0 && sinkStart > sessionStart);
assert.ok(fetchStart >= 0 && fetchEnd > fetchStart);
assert.ok(backoffStart >= 0 && backoffEnd > backoffStart);

function encodedGrant(shopId: number, action: string) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    version: 1,
    provider: "tekmetric",
    shopId,
    action,
    issuedAt: now,
    expiresAt: now + 60,
    nonce: "0123456789abcdef0123456789abcdef",
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `extg_${payload}.test-signature`;
}

const calls: Array<{ url: string; body: any }> = [];
const sandbox: any = {
  console,
  _stateReady: Promise.resolve(),
  ensureBootstrapBoundToActiveTab: async () => {},
  mosApiUrl: "https://mos.tools",
  mosApiToken: "mos-session",
  mosSessionTier: { shopId: 63, canMutate: true },
  tekmetricShopId: "14245",
  activeTabId: 7,
  currentSmsContext: {
    provider: "tekmetric",
    shopId: "14245",
    _tabId: 7,
  },
  tekmetricProofsByTab: new Map([
    [7, { token: "tek-token", origin: "https://shop.tekmetric.com" }],
  ]),
  tekmetricFetchWithBackoff: undefined,
  tekEnqueueReport: () => {},
  tekSanitizeEndpointShape: (endpoint: string) => endpoint,
  tekShowToastOnActiveTab: () => {},
  assertCurrentLaborRateContext: () => {},
  MosProviderActionGrantCore: grantCore,
  fetch: async (url: string, init: any = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    if (url === "https://mos.tools/api/extension/action-grant") {
      const action = body.action;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          grant: encodedGrant(63, action),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          shopId: 63,
          provider: "tekmetric",
          action,
        }),
      };
    }
    if (url === "https://mos.tools/api/extension/action-grant/consume") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ consumed: true }),
      };
    }
    if (url === "https://shop.tekmetric.com/api/shop/14245/job") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 991 }),
        text: async () => "",
        headers: { get: () => null },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  },
};
vm.createContext(sandbox);

// Keep tekmetricFetch real: only the external network boundary is fixture-backed.
vm.runInContext(
  `const TEK_MAX_429_RETRIES = 0;
   const TEK_MAX_BACKOFF_MS = 1;
   ${background.slice(grantStart, grantEnd)}
   ${background.slice(backoffStart, backoffEnd)}
   ${background.slice(sessionStart, sinkStart)}
   ${background.slice(sinkStart, fetchEnd)}
   this.__tekmetricFetch = tekmetricFetch;`,
  sandbox,
);

async function run() {
  const result = await sandbox.__tekmetricFetch(
    "/api/shop/14245/job",
    {
      method: "POST",
      body: JSON.stringify({ id: 991, labor: [{ rate: 12500 }] }),
    },
    {
      shopId: "14245",
      label: "grant-sink-boundary",
      providerAction: "tekmetric:post:/api/shop/14245/job",
    },
  );

  assert.equal(result.ok, true);
  assert.equal(
    calls[0].body.smsShopId,
    "14245",
    "action-grant resolution must retain the external SMS shop ID",
  );
  assert.equal(
    calls.at(-1)?.url,
    "https://shop.tekmetric.com/api/shop/14245/job",
    "the real tekmetricFetch must reach the provider sink",
  );
  assert.equal(
    calls.filter((call) => call.url.endsWith("/action-grant")).length,
    1,
    "grant issuance and consumption must both occur",
  );
  assert.equal(
    calls.filter((call) => call.url.endsWith("/action-grant/consume")).length,
    1,
    "grant issuance and consumption must both occur",
  );

  console.log("Task #1272: full grant-to-Tekmetric sink boundary");
  console.log("✓ external SMS 14245 resolves a signed internal MOS 63 grant");
  console.log("✓ real tekmetricFetch/tekSingleAttempt accepts internal grant scope");
  console.log("✓ provider mutation reaches the captured Tekmetric session");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
