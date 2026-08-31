/**
 * Smoke test for the extension route guard helper and route policy matrix.
 *
 * Run: `npx tsx tests/extension-route-guard.smoke.ts`
 *
 * Exercises the deny paths that don't require a database:
 *   1. checkShopFeatureGate returns null when caller is platform admin (bypass).
 *   2. checkShopFeatureGate returns null when no features are required.
 *   3. guardExtensionShopRequest returns 401 when no auth header is provided.
 *   4. guardExtensionShopRequest returns 400 when smsShopId is missing.
 *   5. Lint script (check-extension-gates.cjs) exits 0 on the real codebase.
 *   6. lookupPolicy returns the expected tiers for a selection of known routes.
 *   7. lookupPolicy returns null for an unknown route.
 *   8. Dynamic tekmetric-migration run IDs (numeric path segments) resolve
 *      to the same policy as the [id] template entries.
 *   9. Every non-preflight, non-public policy entry has at least one tier.
 *  10. isPublicRoute / isAdminRoute helpers return correct booleans.
 *
 * No mocks are needed — these paths short-circuit before any DB lookup.
 */

import { NextRequest } from "next/server";
import {
  __deps,
  checkShopFeatureGate,
  guardExtensionShopRequest,
} from "../lib/extension-route-guard";
import {
  lookupPolicy,
  isPublicRoute,
  isAdminRoute,
  allPolicyEntries,
} from "../lib/extension-route-policy";

let failed = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function run() {
  console.log("extension-route-guard smoke");

  // ── Guard helper tests ──────────────────────────────────────────────────

  // (1) platform-admin bypass
  {
    const res = await checkShopFeatureGate(123, ["maintenance"], {
      isPlatformAdmin: true,
    });
    ok("platform admin bypasses gate", res === null);
  }

  // (2) empty feature list short-circuit
  {
    const res = await checkShopFeatureGate(123, [], {});
    ok("empty requiredFeatures short-circuits", res === null);
  }

  // Billing status is part of entitlement: enabled flags alone cannot pass.
  {
    const original = __deps.getFeatureEntitlements;
    __deps.getFeatureEntitlements = async () => ({
      effectiveFeatures: { maintenance: true },
      canUseFeature: () => false,
    } as any);
    try {
      const res = await checkShopFeatureGate(123, ["maintenance"]);
      ok("inactive billing denies an enabled feature", res?.status === 403);
      const body = await res?.json();
      ok("  → reports the blocked feature", body?.missing?.includes("maintenance") === true);
    } finally {
      __deps.getFeatureEntitlements = original;
    }
  }

  {
    const original = __deps.getFeatureEntitlements;
    __deps.getFeatureEntitlements = async () => ({
      effectiveFeatures: { maintenance: true, auto_dvi: true },
      canUseFeature: () => true,
    } as any);
    try {
      const res = await checkShopFeatureGate(123, ["maintenance", "auto_dvi"]);
      ok("active billing allows all required features", res === null);
    } finally {
      __deps.getFeatureEntitlements = original;
    }
  }

  // (3) missing auth header → 401 from guardExtensionShopRequest
  {
    const req = new NextRequest("http://localhost/api/extension/plan?shopId=99");
    const res = await guardExtensionShopRequest(req, {
      smsShopId: "99",
      requiredFeatures: ["maintenance"],
    });
    ok("guard denies when no auth header", res.ok === false);
    if (res.ok === false) {
      ok("  → 401 status", res.response.status === 401);
    }
  }

  // (4) Verify response body shape on the auth-failure path so a regression
  // that drops the `error` field gets caught.
  {
    const req = new NextRequest("http://localhost/api/extension/plan");
    const res = await guardExtensionShopRequest(req, {
      smsShopId: null,
      requiredFeatures: ["maintenance"],
    });
    ok("guard returns ok=false on no-auth", res.ok === false);
    if (res.ok === false) {
      const body = await res.response.json();
      ok("  → response body has error field", typeof body.error === "string");
    }
  }

  // (5) Lint script smoke — fail loudly if the lint script binary is missing
  // or no longer wired up. Run it as a subprocess and assert exit code 0.
  {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const script = path.resolve(__dirname, "..", "scripts", "check-extension-gates.cjs");
    const r = spawnSync(process.execPath, [script], { encoding: "utf8" });
    ok("check-extension-gates.cjs exits 0", r.status === 0,
      `exit=${r.status}, stderr=${r.stderr.slice(0, 400)}`);
  }

  // ── Policy matrix tests ─────────────────────────────────────────────────

  console.log("\nextension-route-policy smoke");

  // (6) Known routes return correct tiers
  {
    const authPost = lookupPolicy("/api/extension/auth", "POST");
    ok("auth POST → public", authPost !== null && authPost.includes("public"),
      JSON.stringify(authPost));

    const versionGet = lookupPolicy("/api/extension/version", "GET");
    ok("version GET → public", versionGet !== null && versionGet.includes("public"),
      JSON.stringify(versionGet));

    const downloadGet = lookupPolicy("/api/extension/download", "GET");
    ok("download GET → public", downloadGet !== null && downloadGet.includes("public"),
      JSON.stringify(downloadGet));

    const authOptions = lookupPolicy("/api/extension/auth", "OPTIONS");
    ok("auth OPTIONS → preflight", authOptions !== null && authOptions.includes("preflight"),
      JSON.stringify(authOptions));

    const planGet = lookupPolicy("/api/extension/plan", "GET");
    ok("plan GET → read", planGet !== null && planGet.includes("read"),
      JSON.stringify(planGet));

    const addToRoPost = lookupPolicy("/api/extension/jobs/add-to-ro", "POST");
    ok("jobs/add-to-ro POST → write+provider_action",
      addToRoPost !== null &&
      addToRoPost.includes("write") &&
      addToRoPost.includes("provider_action"),
      JSON.stringify(addToRoPost));

    const applyCannedPost = lookupPolicy("/api/extension/jobs/apply-canned", "POST");
    ok("jobs/apply-canned POST → write+provider_action",
      applyCannedPost !== null &&
      applyCannedPost.includes("write") &&
      applyCannedPost.includes("provider_action"),
      JSON.stringify(applyCannedPost));

    const removeFromRoPost = lookupPolicy("/api/extension/jobs/remove-from-ro", "POST");
    ok("jobs/remove-from-ro POST → write+provider_action",
      removeFromRoPost !== null &&
      removeFromRoPost.includes("write") &&
      removeFromRoPost.includes("provider_action"),
      JSON.stringify(removeFromRoPost));

    const authTokenPost = lookupPolicy("/api/extension/auth-token", "POST");
    ok("auth-token POST → write+provider_action",
      authTokenPost !== null &&
      authTokenPost.includes("write") &&
      authTokenPost.includes("provider_action"),
      JSON.stringify(authTokenPost));

    const snifferPost = lookupPolicy("/api/extension/sniffer-upload", "POST");
    ok("sniffer-upload POST → admin", snifferPost !== null && snifferPost.includes("admin"),
      JSON.stringify(snifferPost));

    const migRunsGet = lookupPolicy("/api/extension/tekmetric-migration/runs", "GET");
    ok("tekmetric-migration/runs GET → admin",
      migRunsGet !== null && migRunsGet.includes("admin"),
      JSON.stringify(migRunsGet));

    const migRunsPost = lookupPolicy("/api/extension/tekmetric-migration/runs", "POST");
    ok("tekmetric-migration/runs POST → admin",
      migRunsPost !== null && migRunsPost.includes("admin"),
      JSON.stringify(migRunsPost));

    const addDeclinedPost = lookupPolicy("/api/extension/tekmetric/add-declined-work", "POST");
    ok("tekmetric/add-declined-work POST → write+provider_action",
      addDeclinedPost !== null &&
      addDeclinedPost.includes("write") &&
      addDeclinedPost.includes("provider_action"),
      JSON.stringify(addDeclinedPost));

    const createContactPost = lookupPolicy("/api/extension/protractor/create-contact", "POST");
    ok("protractor/create-contact POST → write+provider_action",
      createContactPost !== null &&
      createContactPost.includes("write") &&
      createContactPost.includes("provider_action"),
      JSON.stringify(createContactPost));

    const createVehiclePost = lookupPolicy("/api/extension/protractor/create-vehicle", "POST");
    ok("protractor/create-vehicle POST → write+provider_action",
      createVehiclePost !== null &&
      createVehiclePost.includes("write") &&
      createVehiclePost.includes("provider_action"),
      JSON.stringify(createVehiclePost));

    const createWOPost = lookupPolicy("/api/extension/protractor/create-work-order", "POST");
    ok("protractor/create-work-order POST → write+provider_action",
      createWOPost !== null &&
      createWOPost.includes("write") &&
      createWOPost.includes("provider_action"),
      JSON.stringify(createWOPost));

    const injectPost = lookupPolicy("/api/extension/concern-assistant/inject-protractor", "POST");
    ok("concern-assistant/inject-protractor POST → write+provider_action",
      injectPost !== null &&
      injectPost.includes("write") &&
      injectPost.includes("provider_action"),
      JSON.stringify(injectPost));

    const laborPut = lookupPolicy("/api/extension/labor-rates", "PUT");
    ok("labor-rates PUT → write", laborPut !== null && laborPut.includes("write"),
      JSON.stringify(laborPut));

    const preferencesPut = lookupPolicy("/api/extension/preferences", "PUT");
    ok("preferences PUT → write", preferencesPut !== null && preferencesPut.includes("write"),
      JSON.stringify(preferencesPut));

    const printConfigPut = lookupPolicy("/api/extension/print/config", "PUT");
    ok("print/config PUT → write", printConfigPut !== null && printConfigPut.includes("write"),
      JSON.stringify(printConfigPut));

    const supportPost = lookupPolicy("/api/extension/support", "POST");
    ok("support POST → write", supportPost !== null && supportPost.includes("write"),
      JSON.stringify(supportPost));

    const enhanceCorrectionsPost = lookupPolicy("/api/extension/enhance-corrections", "POST");
    ok("enhance-corrections POST → write",
      enhanceCorrectionsPost !== null && enhanceCorrectionsPost.includes("write"),
      JSON.stringify(enhanceCorrectionsPost));

    const realtimeTokenPost = lookupPolicy("/api/extension/realtime-token", "POST");
    ok("realtime-token POST → write",
      realtimeTokenPost !== null && realtimeTokenPost.includes("write"),
      JSON.stringify(realtimeTokenPost));

    const actionGrantPost = lookupPolicy("/api/extension/action-grant", "POST");
    ok("action-grant POST → write+provider_action",
      actionGrantPost !== null &&
      actionGrantPost.includes("write") &&
      actionGrantPost.includes("provider_action"),
      JSON.stringify(actionGrantPost));
  }

  // (7) Unknown route returns null
  {
    const unknown = lookupPolicy("/api/extension/does-not-exist", "GET");
    ok("unknown route returns null", unknown === null);

    const unknownMethod = lookupPolicy("/api/extension/plan", "DELETE");
    ok("known route + unknown method returns null", unknownMethod === null);
  }

  // (8) Dynamic tekmetric-migration run IDs resolve to same policy as [id]
  {
    const templateGet = lookupPolicy("/api/extension/tekmetric-migration/runs/[id]", "GET");
    const numericGet = lookupPolicy("/api/extension/tekmetric-migration/runs/42", "GET");
    ok("numeric run id GET resolves same as [id] template",
      JSON.stringify(templateGet) === JSON.stringify(numericGet),
      `template=${JSON.stringify(templateGet)}, numeric=${JSON.stringify(numericGet)}`);

    const templateDumpPost = lookupPolicy(
      "/api/extension/tekmetric-migration/runs/[id]/dump", "POST");
    const numericDumpPost = lookupPolicy(
      "/api/extension/tekmetric-migration/runs/999/dump", "POST");
    ok("numeric run id dump POST resolves same as [id] template",
      JSON.stringify(templateDumpPost) === JSON.stringify(numericDumpPost),
      `template=${JSON.stringify(templateDumpPost)}, numeric=${JSON.stringify(numericDumpPost)}`);

    const templateOverridePost = lookupPolicy(
      "/api/extension/tekmetric-migration/runs/[id]/override-clone", "POST");
    const numericOverridePost = lookupPolicy(
      "/api/extension/tekmetric-migration/runs/1234/override-clone", "POST");
    ok("numeric run id override-clone POST resolves same as [id] template",
      JSON.stringify(templateOverridePost) === JSON.stringify(numericOverridePost),
      `template=${JSON.stringify(templateOverridePost)}, numeric=${JSON.stringify(numericOverridePost)}`);
  }

  // (9) Every non-preflight, non-public entry has at least one meaningful tier
  {
    const entries = allPolicyEntries();
    const bad = entries.filter(
      (e) =>
        !e.tiers.includes("preflight") &&
        !e.tiers.includes("public") &&
        e.tiers.length === 0,
    );
    ok(`all non-public non-preflight entries have at least one tier (${entries.length} total)`,
      bad.length === 0,
      bad.map((e) => `${e.pathname}|${e.method}`).join(", "));
  }

  // (10) isPublicRoute / isAdminRoute helpers
  {
    ok("isPublicRoute auth POST → true", isPublicRoute("/api/extension/auth", "POST"));
    ok("isPublicRoute plan GET → false", !isPublicRoute("/api/extension/plan", "GET"));
    ok("isPublicRoute auth OPTIONS → true", isPublicRoute("/api/extension/auth", "OPTIONS"));
    ok("isAdminRoute sniffer-upload POST → true",
      isAdminRoute("/api/extension/sniffer-upload", "POST"));
    ok("isAdminRoute migration runs GET → true",
      isAdminRoute("/api/extension/tekmetric-migration/runs", "GET"));
    ok("isAdminRoute plan GET → false",
      !isAdminRoute("/api/extension/plan", "GET"));
    ok("isAdminRoute auth POST → false",
      !isAdminRoute("/api/extension/auth", "POST"));
  }

  if (failed > 0) {
    console.error(`\nFAILED ${failed} assertion(s)`);
    process.exit(1);
  }
  console.log("\nAll smoke checks passed.");
}

run().catch((err) => {
  console.error("smoke test crashed:", err);
  process.exit(2);
});
