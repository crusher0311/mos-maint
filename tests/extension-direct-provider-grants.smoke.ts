import fs from "node:fs";
import { createRequire } from "node:module";

let failed = 0;
function ok(name: string, condition: boolean) {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}`);
  }
}

function count(source: string, pattern: RegExp): number {
  return [...source.matchAll(pattern)].length;
}

console.log("extension direct-provider grant coverage");

const background = fs.readFileSync("mos-tools-extension/background.js", "utf8");
const shopware = fs.readFileSync(
  "mos-tools-extension/adapters/shopware-content.js",
  "utf8",
);
const autoflow = fs.readFileSync(
  "mos-tools-extension/adapters/autoflow-content.js",
  "utf8",
);
const autoflowBridge = fs.readFileSync(
  "mos-tools-extension/adapters/autoflow-dvi-bridge.js",
  "utf8",
);
const shopmonkey = fs.readFileSync(
  "mos-tools-extension/adapters/shopmonkey-content.js",
  "utf8",
);
const grantCore = createRequire(import.meta.url)(
  "../mos-tools-extension/provider-action-grant-core.js",
);
const sidepanel = fs.readFileSync("mos-tools-extension/sidepanel.js", "utf8");
const protractorMutationRoutes = [
  "app/api/extension/jobs/add-to-ro/route.ts",
  "app/api/extension/jobs/apply-canned/route.ts",
  "app/api/extension/jobs/remove-from-ro/route.ts",
].map((path) => fs.readFileSync(path, "utf8"));
const tekmetricBackendMutation = fs.readFileSync(
  "app/api/tekmetric/apply-canned-job/route.ts",
  "utf8",
);
const protractorBackendMutation = fs.readFileSync(
  "app/api/protractor/apply-canned-job/route.ts",
  "utf8",
);
const extensionBackendReads = [
  "app/api/estimate-assist/audit/route.ts",
  "app/api/estimate-assist/job-builder/route.ts",
].map((path) => fs.readFileSync(path, "utf8"));

const tekmetricFetch = background.slice(
  background.indexOf("async function tekmetricFetch("),
  background.indexOf("function extractTekmetricError(", background.indexOf("async function tekmetricFetch(")),
);
const tekmetricSink = background.slice(
  background.indexOf("async function tekSingleAttempt("),
  background.indexOf("// Public helper.", background.indexOf("async function tekSingleAttempt(")),
);
ok(
  "central Tekmetric fetch requires a grant for every mutating HTTP method",
  /MUTATING_METHODS\.has\(method\)/.test(tekmetricFetch) &&
    /await requestProviderActionGrant\(/.test(tekmetricFetch),
);
ok(
  "Tekmetric mutation sink validates the signed receipt scope",
  /MUTATING_METHODS\.has\(method\)[\s\S]*?requireValidReceipt\(/.test(
    tekmetricSink,
  ),
);
ok(
  "legacy direct technician-concern POST obtains a grant first",
  /tekmetric:post:technician-concern[\s\S]*?method:\s*["']POST["'][\s\S]*?technician-concerns/.test(
    background,
  ),
);
ok(
  "legacy direct technician-concern DELETE obtains a grant first",
  /tekmetric:delete:technician-concern[\s\S]*?technician-concerns[\s\S]*?method:\s*["']DELETE["']/.test(
    background,
  ),
);

ok(
  "all five Shop-Ware mutation paths request authorization",
  count(shopware, /authorizeShopwareAction\(['"`]/g) >= 5,
);
ok(
  "all Shop-Ware provider fetch sinks require the action receipt",
  count(shopware, /providerAuthorizedFetch\(/g) >= 6 &&
    /requireValidReceipt\(authorization/.test(shopware),
);
ok(
  "AutoFlow sheet and RVH bridge writes request authorization",
  count(autoflow, /await authorizeAutoflowAction\(/g) >= 2,
);
ok(
  "AutoFlow bridge mutation sink requires the action receipt",
  /function afBridgeSendAuthorized\([\s\S]*?requireValidReceipt\(authorization/.test(
    autoflow,
  ) &&
    count(autoflow, /afBridgeSendAuthorized\(/g) >= 3,
);
ok(
  "AutoFlow MAIN-world bridge cryptographically consumes each grant before writing",
  /async function consumeWriteGrant\(/.test(autoflowBridge) &&
    /action-grant\/consume/.test(autoflowBridge) &&
    /MOS_AF_WRITE_SHEET[\s\S]*?await consumeWriteGrant/.test(autoflowBridge) &&
    /MOS_AF_WRITE_RVH[\s\S]*?await consumeWriteGrant/.test(autoflowBridge),
);
ok(
  "Shopmonkey adapter contains no direct HTTP mutations",
  !/method\s*:\s*["'](?:POST|PUT|PATCH|DELETE)["']/i.test(shopmonkey),
);
ok(
  "server-side Protractor mutations bind the first-class provider scope",
  protractorMutationRoutes.every(
    (source) =>
      /\["protractor",\s*"autoflow"\]\.includes\(scopedProvider\)/.test(source) &&
      /requireExtensionPrincipalScope\(auth,\s*\{[\s\S]*?provider:\s*scopedProvider/.test(source),
  ),
);
ok(
  "side-panel Protractor mutations send the current page-provider context",
  count(
    sidepanel,
    /provider:\s*currentContext\??\.provider\s*\|\|\s*sessionTier\?\.provider/g,
  ) >= 3,
);
ok(
  "non-namespaced provider mutations accept exts_ and enforce exact scope",
  [tekmetricBackendMutation, protractorBackendMutation].every(
    (source) =>
      /isExtensionBearerRequest\(req\)/.test(source) &&
      /requireExtensionPrincipalScope\(extensionAuth/.test(source),
  ),
);
ok(
  "non-namespaced read endpoints recognize first-class extension bearers",
  extensionBackendReads.every((source) =>
    /isExtensionBearerRequest\(req\)/.test(source),
  ),
);

const now = Date.now();
const nowSeconds = Math.floor(now / 1000);
const claims = {
  version: 1,
  sessionId: "session-1",
  shopId: 7,
  provider: "tekmetric",
  action: "tekmetric:post:job",
  issuedAt: nowSeconds,
  expiresAt: nowSeconds + 90,
  nonce: "0123456789abcdef01234567",
};
const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
const receipt = {
  grant: `extg_${payload}.test-signature`,
  expiresAt: new Date(claims.expiresAt * 1000).toISOString(),
  shopId: 7,
  provider: "tekmetric",
  providerAction: "tekmetric:post:job",
};
ok(
  "receipt core accepts an exact short-lived provider/action/shop binding",
  grantCore.validateReceipt(
    receipt,
    { provider: "tekmetric", action: "tekmetric:post:job", shopId: 7 },
    now,
  ).ok,
);
ok(
  "receipt core rejects action replay",
  !grantCore.validateReceipt(
    receipt,
    { provider: "tekmetric", action: "tekmetric:delete:job", shopId: 7 },
    now,
  ).ok,
);
ok(
  "receipt core rejects expiry",
  !grantCore.validateReceipt(
    receipt,
    { provider: "tekmetric", action: "tekmetric:post:job", shopId: 7 },
    now + 91_000,
  ).ok,
);

if (failed) {
  console.error(`\nFAILED ${failed} direct-provider assertion(s)`);
  process.exit(1);
}
console.log("\nAll direct-provider grant checks passed.");