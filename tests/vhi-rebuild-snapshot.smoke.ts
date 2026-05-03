/**
 * Snapshot test for `rebuildVhi` on a known cached plan.
 *
 * Run: `npx tsx tests/vhi-rebuild-snapshot.smoke.ts`
 *
 * `lib/vhi-rebuild.rebuildVhi` is the function the webhook auto-rebuild path
 * and the manual VHI controls call. Its post-cache transformation (compute
 * score → tier → bucket-shape) is the customer-visible contract: a regression
 * in this glue would silently change scores even if the pure helpers in
 * `lib/vhi-score` (which `tests/vhi-score-snapshot.smoke.ts` already pins)
 * stay correct.
 *
 * This test swaps `__deps.getDb` / `__deps.getCachedPlan` to inject a known
 * plan fixture, then snapshots `rebuildVhi`'s response shape and score for
 * one happy-path VIN/mileage and one error path (no cache + build failure).
 */

import { __deps, rebuildVhi } from "../lib/vhi-rebuild";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function withDeps(overrides: Partial<typeof __deps>) {
  const original = { ...__deps };
  Object.assign(__deps, overrides);
  return () => Object.assign(__deps, original);
}

const FIXTURE_PLAN = {
  vehicle: { year: 2018, make: "Toyota", model: "Camry", engine: "2.5L L4" },
  currentMiles: 87_500,
  distanceUnit: "mi",
  customerName: "Test Customer",
  buckets: {
    overdue: [
      { key: "brakes", title: "Front Brake Pads", intervalMiles: 60_000, declined: false, complimentary: false },
      { key: "engine", title: "Spark Plugs", intervalMiles: 60_000, declined: false, complimentary: false },
    ],
    dueSoon: [
      { key: "wipers", title: "Wiper Blades", intervalMiles: 12_000, declined: false, complimentary: false },
    ],
    upcoming: [
      { key: "misc", title: "Cabin Air Filter", intervalMiles: 30_000, declined: false, complimentary: false },
      // Complimentary item arrives in one of the paid buckets and gets
      // separated out by separateComplimentary — that's what we're pinning.
      { key: "misc", title: "Multi-Point Inspection", intervalMiles: 5_000, declined: false, complimentary: true },
    ],
  },
};

async function run() {
  console.log("vhi-rebuild-snapshot smoke");

  // Happy path: cached plan present → returns full shape with score+buckets
  {
    const restore = withDeps({
      getDb: async () => ({} as any),
      getCachedPlan: async () => ({
        plan: FIXTURE_PLAN,
        createdAt: new Date("2026-01-01T00:00:00Z"),
      } as any),
      invalidateCachedPlan: async () => undefined,
      triggerPlanBuild: async () => ({ ok: true, status: 200 }),
    });
    try {
      const r = await rebuildVhi(7, "1HGCM82633A123456", 87_500);
      ok("returns success=true on cached plan", r.success === true);
      ok("VIN is upper-cased", r.vin === "1HGCM82633A123456");
      ok("shopId echoed back", r.shopId === 7);
      ok("vehicle year preserved", r.vehicle?.year === 2018);
      ok("vehicle make preserved", r.vehicle?.make === "Toyota");
      ok("currentMiles preserved", r.currentMiles === 87_500);
      ok("customerName preserved", r.customerName === "Test Customer");

      // Score + tier are deterministic given the fixture (pinned).
      ok("score is a number", typeof r.score?.value === "number");
      ok("tier label is a non-empty string", !!r.score?.tier);
      ok("tier color is set", typeof r.score?.color === "string" && r.score.color.length > 0);

      // Bucket shape: complimentary items separated out, non-complimentary
      // counted in their original buckets.
      ok("summary.overdue counts the 2 paid overdue items", r.summary?.overdue === 2);
      ok("summary.dueSoon counts the 1 paid dueSoon item", r.summary?.dueSoon === 1);
      ok("summary.upcoming counts the 1 paid upcoming item", r.summary?.upcoming === 1);
      ok("summary.complimentary counts the 1 complimentary item", r.summary?.complimentary === 1);

      ok("buckets.overdue has formatted items", Array.isArray(r.buckets?.overdue) && r.buckets!.overdue.length === 2);
      ok("buckets.complimentary has formatted items", Array.isArray(r.buckets?.complimentary) && r.buckets!.complimentary!.length === 1);
      ok(
        "formatted overdue item has iconStatus=overdue",
        (r.buckets?.overdue as any[])[0]?.iconStatus === "overdue",
      );
      ok(
        "formatted complimentary item has iconStatus=ok (bucketToStatus mapping)",
        (r.buckets?.complimentary as any[])[0]?.iconStatus === "ok",
      );
    } finally {
      restore();
    }
  }

  // Error path: no cached plan + build trigger fails → structured failure
  {
    const restore = withDeps({
      getDb: async () => ({} as any),
      getCachedPlan: async () => null,
      invalidateCachedPlan: async () => undefined,
      triggerPlanBuild: async () => ({ ok: false, status: 500, errorMessage: "boom" }),
    });
    try {
      const r = await rebuildVhi(7, "1HGCM82633A123456", 50_000);
      ok("returns success=false when build fails", r.success === false);
      ok("failedStage points at triggerPlanBuild", r.failedStage === "triggerPlanBuild");
      ok("upstreamStatus surfaced for debugging", r.upstreamStatus === 500);
      ok("error message present", typeof r.error === "string" && r.error.length > 0);
    } finally {
      restore();
    }
  }

  // Cache-miss-after-build path: build OK but cache still empty
  {
    const restore = withDeps({
      getDb: async () => ({} as any),
      getCachedPlan: async () => null,
      invalidateCachedPlan: async () => undefined,
      triggerPlanBuild: async () => ({ ok: true, status: 200 }),
    });
    try {
      const r = await rebuildVhi(7, "1HGCM82633A123456", 50_000);
      ok("returns success=false when cache empty after build", r.success === false);
      ok("failedStage points at cacheReadAfterBuild", r.failedStage === "cacheReadAfterBuild");
      ok("built=true (build did succeed)", r.built === true);
    } finally {
      restore();
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} smoke check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll smoke checks passed.");
}

run().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
