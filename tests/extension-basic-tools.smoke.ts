import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  printRequestRequiresWrite,
  resolveGuardProvider,
  shouldRunStickerSideEffects,
} from "../lib/extension-basic-tools";
import { lookupPolicy } from "../lib/extension-route-policy";
import { NextRequest } from "next/server";
import * as auth from "../lib/extension-auth";
import * as shopLookup from "../lib/extension-shop-lookup";
import { POST as printPOST } from "../app/api/extension/print/route";

const basic = {
  sessionId: "basic-1",
  assurance: "basic" as const,
  capabilities: ["read", "shop_tool"] as const,
  expiresAt: new Date(Date.now() + 60_000),
};
const verified = {
  sessionId: "verified-1",
  assurance: "verified" as const,
  capabilities: ["read", "shop_tool", "write", "provider_action"] as const,
  expiresAt: new Date(Date.now() + 60_000),
};

assert.strictEqual(
  shouldRunStickerSideEffects(basic),
  false,
  "Basic sticker rendering must skip persisted telemetry and auto-booking",
);
assert.strictEqual(
  shouldRunStickerSideEffects(verified),
  true,
  "verified sticker rendering preserves existing side effects",
);

assert.deepStrictEqual(
  resolveGuardProvider(
    { provider: "tekmetric", isLegacy: false },
    "tekmetric",
  ),
  { ok: true, provider: "tekmetric", authoritative: true },
  "first-class session provider must be authoritative",
);
assert.deepStrictEqual(
  resolveGuardProvider(
    { provider: "tekmetric", isLegacy: false },
    "protractor",
  ),
  { ok: false },
  "conflicting request provider must fail before shop lookup",
);
assert.deepStrictEqual(
  resolveGuardProvider(
    { provider: "shopware", isLegacy: false },
    "shop-ware",
  ),
  { ok: true, provider: "shopware", authoritative: true },
  "provider aliases must normalize before comparison",
);
assert.deepStrictEqual(
  resolveGuardProvider(
    { provider: undefined, isLegacy: true },
    "protractor",
  ),
  { ok: true, provider: "protractor", authoritative: false },
  "legacy sessions retain request-hint compatibility",
);

assert.strictEqual(
  printRequestRequiresWrite({
    type: "sticker",
    imageBase64: "data:image/png;base64,AAAA",
  }),
  true,
  "a client image cannot become Basic-safe by claiming sticker type",
);
assert.strictEqual(
  printRequestRequiresWrite({
    type: "keytag",
    imageBase64: "data:image/png;base64,AAAA",
  }),
  true,
  "a client image cannot become Basic-safe by claiming keytag type",
);
assert.strictEqual(
  printRequestRequiresWrite({ type: "keytag" }),
  false,
  "constrained server-rendered keytag input is Basic-safe",
);

for (const path of [
  "/api/extension/sticker",
  "/api/extension/keytag",
  "/api/extension/print",
]) {
  assert.deepStrictEqual(
    lookupPolicy(path, "POST"),
    ["shop_tool"],
    `${path} must require only the narrow shop-tool capability`,
  );
}

for (const [path, method] of [
  ["/api/extension/action-grant", "POST"],
  ["/api/extension/auth-token", "POST"],
  ["/api/extension/jobs/add-to-ro", "POST"],
  ["/api/extension/jobs/apply-canned", "POST"],
  ["/api/extension/jobs/remove-from-ro", "POST"],
  ["/api/extension/tekmetric/add-declined-work", "POST"],
  ["/api/extension/labor-rates", "PUT"],
  ["/api/extension/prefill-dvi", "POST"],
  ["/api/extension/auto-dvi/push", "POST"],
  ["/api/extension/inspections", "POST"],
  ["/api/extension/print/config", "PUT"],
  ["/api/extension/sniffer-upload", "POST"],
] as const) {
  const tiers = lookupPolicy(path, method);
  assert.ok(tiers, `${method} ${path} must remain classified`);
  assert.ok(
    tiers.some((tier) =>
      tier === "write" || tier === "provider_action" || tier === "admin"
    ),
    `${method} ${path} must remain verified-only`,
  );
  assert.ok(
    !tiers.includes("shop_tool"),
    `${method} ${path} must never accept Basic shop-tool authority`,
  );
}

const stickerRoute = readFileSync(
  new URL("../app/api/extension/sticker/route.ts", import.meta.url),
  "utf8",
);
assert.match(
  stickerRoute,
  /if \(runStickerSideEffects\) \{[\s\S]*sticker_generations/,
  "sticker generation telemetry must remain behind the side-effect decision",
);
assert.match(
  stickerRoute,
  /if \(runStickerSideEffects && mosShopId && vin\)/,
  "auto-booking must remain behind the side-effect decision",
);

const keytagRoute = readFileSync(
  new URL("../app/api/extension/keytag/route.ts", import.meta.url),
  "utf8",
);
assert.strictEqual(
  (keytagRoute.match(/checkShopFeatureGate\(Number\(shopId\), \["keytags"\]/g) || []).length,
  2,
  "keytag config and rendering must both enforce the keytags entitlement",
);

const printRoute = readFileSync(
  new URL("../app/api/extension/print/route.ts", import.meta.url),
  "utf8",
);
assert.match(
  printRoute,
  /type === "keytag"[\s\S]*\["keytags"\][\s\S]*type === "sticker"[\s\S]*\["oil_sticker"\]/,
  "print enqueue must enforce the entitlement for the requested typed job",
);
assert.match(
  printRoute,
  /requiredCapabilities: printRequestRequiresWrite\(body\) \? \["write"\] : \[\]/,
  "all unconstrained or client-rendered print jobs must remain verified-only",
);

const guardRoute = readFileSync(
  new URL("../lib/extension-route-guard.ts", import.meta.url),
  "utf8",
);
assert.match(
  guardRoute,
  /providerHintIsAuthoritative: providerResolution\.authoritative/,
  "shared route guard must pass server-issued provider authority to shop lookup",
);

async function verifyForgedTypedImageIsDenied() {
  const originalAuthDeps = { ...auth.__deps };
  const originalShopLookupDeps = { ...shopLookup.__deps };
  let shopLookupCalls = 0;
  try {
    auth.__deps.lookupExtensionSession = (async () => ({
      status: "active",
      principal: {
        sessionId: "basic-print",
        shopId: 7,
        provider: "tekmetric",
        assurance: "basic",
        capabilities: ["read", "shop_tool"],
        expiresAt: new Date(Date.now() + 60_000),
      },
    })) as any;
    shopLookup.__deps.getDb = (async () => {
      shopLookupCalls += 1;
      throw new Error("shop lookup must not run for denied arbitrary images");
    }) as any;
    const forgedTypedImage = new NextRequest(
      "http://localhost/api/extension/print",
      {
        method: "POST",
        headers: {
          authorization: "Bearer exts_basic_print",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          smsShopId: "7",
          provider: "tekmetric",
          type: "sticker",
          imageBase64: "data:image/png;base64,AAAA",
        }),
      },
    );
    const denied = await printPOST(forgedTypedImage);
    const deniedBody = await denied.json();
    assert.strictEqual(
      denied.status,
      403,
      "Basic must not enqueue arbitrary image bytes under a forged typed label",
    );
    assert.strictEqual(deniedBody.code, "CAPABILITY_REQUIRED");
    assert.strictEqual(
      shopLookupCalls,
      0,
      "forged typed images must fail before shop lookup or queue side effects",
    );
  } finally {
    Object.assign(auth.__deps, originalAuthDeps);
    Object.assign(shopLookup.__deps, originalShopLookupDeps);
  }
}

verifyForgedTypedImageIsDenied()
  .then(() => console.log("extension Basic safe-tool boundary: PASS"))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
