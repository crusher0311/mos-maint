/**
 * Task #998 — plan-cache PG cutover smoke test.
 *
 * Verifies (no live DB needed):
 *  1. Flag defaults: PLAN_CACHE_PG_CANONICAL off → Mongo canonical;
 *     WRITE_MONGO_PLAN_CACHE default on; shadow helper never throws.
 *  2. selectValidCachedPlan preserves every cache-validity rule
 *     (expiry, schema version, distance unit, oemMissing 30s window,
 *     mileage tolerance + freshness override) identically for docs from
 *     either store.
 *
 * Run: npx tsx tests/plan-cache-pg-cutover.smoke.ts
 */
import assert from "node:assert";

process.env.PLAN_CACHE_PG_CANONICAL = "";
process.env.WRITE_MONGO_PLAN_CACHE = "";

async function main() {
  const {
    isPlanCachePgCanonical,
    shouldShadowWriteMongoPlanCache,
    shadowWriteMongoPlanCache,
  } = await import("../lib/db/plan-cache-write-mode");
  const { selectValidCachedPlan, PLAN_CACHE_SCHEMA_VERSION } = await import(
    "../lib/plan-cache"
  );

  /* ---- 1. flag defaults ---- */
  assert.equal(isPlanCachePgCanonical(), false, "default must be Mongo-canonical");
  assert.equal(shouldShadowWriteMongoPlanCache(), true, "shadow default on");
  process.env.PLAN_CACHE_PG_CANONICAL = "1";
  process.env.WRITE_MONGO_PLAN_CACHE = "0";
  assert.equal(isPlanCachePgCanonical(), true);
  assert.equal(shouldShadowWriteMongoPlanCache(), false);
  process.env.PLAN_CACHE_PG_CANONICAL = "";
  process.env.WRITE_MONGO_PLAN_CACHE = "";

  // shadow helper: swallows failures, and skips fn when disabled
  let ran = 0;
  await shadowWriteMongoPlanCache("test", async () => {
    ran++;
    throw new Error("boom");
  });
  assert.equal(ran, 1, "shadow write should run and swallow the error");
  process.env.WRITE_MONGO_PLAN_CACHE = "0";
  await shadowWriteMongoPlanCache("test", async () => {
    ran++;
  });
  assert.equal(ran, 1, "shadow write must be skipped when disabled");
  process.env.WRITE_MONGO_PLAN_CACHE = "";

  /* ---- 2. selectValidCachedPlan semantics ---- */
  const now = Date.now();
  const base = (overrides: Record<string, unknown> = {}) =>
    ({
      vin: "1FTEW1EP5MKD73450",
      shopId: 42,
      mileage: 50_000,
      plan: { distanceUnit: "miles" },
      createdAt: new Date(now - 60_000),
      expiresAt: new Date(now + 60_000),
      schemaVersion: PLAN_CACHE_SCHEMA_VERSION,
      ...overrides,
    }) as any;
  const opts = { vin: "1FTEW1EP5MKD73450" };

  // valid entry is returned
  assert.ok(selectValidCachedPlan([base()], opts), "valid entry must HIT");
  // expired entry skipped
  assert.equal(
    selectValidCachedPlan([base({ expiresAt: new Date(now - 1000) })], opts),
    null,
    "expired entry must MISS",
  );
  // stale schema skipped
  assert.equal(
    selectValidCachedPlan([base({ schemaVersion: PLAN_CACHE_SCHEMA_VERSION - 1 })], opts),
    null,
    "stale schema must MISS",
  );
  // distance-unit mismatch skipped
  assert.equal(
    selectValidCachedPlan([base()], { ...opts, distanceUnit: "kilometers" as const }),
    null,
    "distanceUnit mismatch must MISS",
  );
  // oemMissing outside 30s window skipped…
  assert.equal(
    selectValidCachedPlan(
      [base({ plan: { distanceUnit: "miles", oemMissing: true } })],
      opts,
    ),
    null,
    "aged oemMissing must MISS",
  );
  // …but served within the just-built freshness window
  assert.ok(
    selectValidCachedPlan(
      [base({ plan: { distanceUnit: "miles", oemMissing: true }, createdAt: new Date(now - 5_000) })],
      opts,
    ),
    "just-built oemMissing must HIT",
  );
  // mileage tolerance: >500 mi drift skipped
  assert.equal(
    selectValidCachedPlan([base()], { ...opts, currentMiles: 51_000 }),
    null,
    "mileage drift >500 must MISS",
  );
  assert.ok(
    selectValidCachedPlan([base()], { ...opts, currentMiles: 50_400 }),
    "mileage drift <=500 must HIT",
  );
  // freshness override: just-built row accepted despite drift
  assert.ok(
    selectValidCachedPlan([base({ createdAt: new Date(now - 5_000) })], {
      ...opts,
      currentMiles: 60_000,
    }),
    "just-built row must HIT despite mileage drift (freshness override)",
  );

  console.log("plan-cache-pg-cutover smoke: ALL PASS");
}

main().catch((err) => {
  console.error("SMOKE FAIL:", err);
  process.exit(1);
});
