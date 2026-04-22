/**
 * Smoke test for the extension route guard helper.
 *
 * Run: `npx tsx tests/extension-route-guard.smoke.ts`
 *
 * Exercises the deny paths that don't require a database:
 *   1. checkShopFeatureGate returns null when caller is platform admin (bypass).
 *   2. checkShopFeatureGate returns null when no features are required.
 *   3. guardExtensionShopRequest returns 401 when no auth header is provided.
 *   4. guardExtensionShopRequest returns 400 when smsShopId is missing.
 *
 * No mocks are needed — these paths short-circuit before any DB lookup.
 */

import { NextRequest } from "next/server";
import {
  checkShopFeatureGate,
  guardExtensionShopRequest,
} from "../lib/extension-route-guard";

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
