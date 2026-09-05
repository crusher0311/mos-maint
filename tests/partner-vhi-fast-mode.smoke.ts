/**
 * Partner VHI fast-mode contract.
 *
 * Run: npx tsx tests/partner-vhi-fast-mode.smoke.ts
 */
import fs from "node:fs";
import path from "node:path";
import { triggerPlanBuild } from "../lib/vhi-rebuild";
import { persistPlanBuildResult } from "../lib/plan-build-persistence";

const service = fs.readFileSync(
  path.join(process.cwd(), "lib/external-api/partner-vhi-service.ts"),
  "utf8",
);

let failed = 0;
function ok(name: string, condition: boolean) {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}`);
  }
}

console.log("partner VHI fast mode");

ok(
  "accepts only explicit fast/full modes",
  service.includes('requestedMode !== "fast" && requestedMode !== "full"'),
);
ok(
  "forwards fast mode into rebuildVhi",
  service.includes("fast: fastMode"),
);
ok(
  "keeps full mode as the default",
  service.includes('const fastMode = requestedMode === "fast"'),
);
ok(
  "labels successful on-demand responses with their build mode",
  service.includes('buildMode: fastMode ? "fast" : "full"'),
);
ok(
  "warns consumers that fast builds may omit optional data",
  service.includes("optionalDataMayBeIncomplete: fastMode"),
);
ok(
  "keeps fast builds out of the shared full-quality cache",
  service.includes("persistBuiltPlan: !fastMode"),
);

async function runBehavioralChecks() {
  const originalFetch = globalThis.fetch;
  const originalDevDomain = process.env.REPLIT_DEV_DOMAIN;
  const originalRenderUrl = process.env.RENDER_EXTERNAL_URL;
  let capturedUrl = "";
  process.env.REPLIT_DEV_DOMAIN = "example.replit.dev";
  delete process.env.RENDER_EXTERNAL_URL;
  globalThis.fetch = (async (input: string | URL | Request) => {
    capturedUrl = String(input);
    return new Response(
      JSON.stringify({
        ok: true,
        built: true,
        plan: {
          currentMiles: 12345,
          buckets: { overdue: [], dueSoon: [], upcoming: [], complimentary: [] },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const result = await triggerPlanBuild(
      36,
      "5GAEVCKW2KJ239591",
      12345,
      true,
      undefined,
      undefined,
      false,
    );
    const called = new URL(capturedUrl);
    ok("fast reaches the internal plan builder", called.searchParams.get("fast") === "1");
    ok("ephemeral mode reaches the internal plan builder", called.searchParams.get("persist") === "0");
    ok("ephemeral fast build still returns its inline plan", result.ok && Boolean(result.plan));

    let writes = 0;
    const writePlan = async () => {
      writes += 1;
    };
    const basePersistenceInput = {
      db: {} as any,
      vin: "5GAEVCKW2KJ239591",
      shopId: 36,
      mileage: 12345,
      plan: {
        currentMiles: 12345,
        buckets: { overdue: [], dueSoon: [], upcoming: [], complimentary: [] },
      } as any,
    };
    const ephemeral = await persistPlanBuildResult(
      { ...basePersistenceInput, persist: false },
      writePlan,
    );
    ok("persist=0 performs no shared-cache write", writes === 0 && !ephemeral.persisted);

    const full = await persistPlanBuildResult(
      { ...basePersistenceInput, persist: true },
      writePlan,
    );
    ok("default/full persistence still writes once", writes === 1 && full.persisted);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDevDomain === undefined) delete process.env.REPLIT_DEV_DOMAIN;
    else process.env.REPLIT_DEV_DOMAIN = originalDevDomain;
    if (originalRenderUrl === undefined) delete process.env.RENDER_EXTERNAL_URL;
    else process.env.RENDER_EXTERNAL_URL = originalRenderUrl;
  }
}

runBehavioralChecks()
  .then(() => {
    if (failed) {
      console.error(`partner VHI fast mode: ${failed} failure(s)`);
      process.exit(1);
    }
    console.log("partner VHI fast mode: PASS");
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });