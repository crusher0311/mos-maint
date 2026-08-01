/**
 * Task #998 — ai_analysis_cache PG freshness smoke test.
 *
 * Proves that a re-upsert refreshes the 24h TTL clock in PG mode: the
 * /api/recommended/cache GET keys freshness on `createdAt`, so the PG
 * upsert must reset `createdAt` on conflict (matching Mongo `$set`
 * semantics). Uses a synthetic negative shopId + test VIN and cleans up
 * after itself. Skips gracefully when no PG connection is configured.
 *
 * Run: npx tsx tests/ai-analysis-freshness-pg.smoke.ts
 */
import assert from "node:assert";

const TEST_SHOP_ID = -999998; // synthetic, never a real shop
const TEST_VIN = "TESTVIN00TASK998X";

async function main() {
  let getDb: () => any;
  try {
    ({ getDb } = await import("../lib/db/drizzle"));
    getDb();
  } catch {
    console.log("ai-analysis freshness smoke: SKIPPED (no PG connection configured)");
    return;
  }
  const { aiAnalysisCache } = await import("../lib/db/schema/wave2");
  const { pgUpsertAiAnalysis, pgGetAiAnalysis } = await import(
    "../lib/data/repositories/pg/plan-cache"
  );
  const { and, eq, sql } = await import("drizzle-orm");
  const db = getDb();
  const where = and(
    eq(aiAnalysisCache.shopId, TEST_SHOP_ID),
    eq(aiAnalysisCache.vin, TEST_VIN),
  );

  try {
    // Seed a stale row (createdAt 2 days ago) — as if written pre-TTL.
    await db.delete(aiAnalysisCache).where(where);
    await pgUpsertAiAnalysis(TEST_SHOP_ID, TEST_VIN, { summary: "old" });
    await db
      .update(aiAnalysisCache)
      .set({ createdAt: sql`now() - interval '2 days'` })
      .where(where);

    const stale = await pgGetAiAnalysis(TEST_SHOP_ID, TEST_VIN);
    assert.ok(stale, "seed row must exist");
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    assert.ok(
      new Date(stale!.createdAt as any).getTime() < oneDayAgo,
      "seed row must read as stale (>24h old)",
    );

    // Re-upsert (conflict path) — must reset the TTL clock.
    await pgUpsertAiAnalysis(TEST_SHOP_ID, TEST_VIN, { summary: "new" });
    const fresh = await pgGetAiAnalysis(TEST_SHOP_ID, TEST_VIN);
    assert.ok(fresh, "row must still exist after re-upsert");
    assert.ok(
      new Date(fresh!.createdAt as any).getTime() >= oneDayAgo,
      "re-upsert must refresh createdAt so the 24h TTL check passes again",
    );
    assert.deepEqual((fresh as any).result, { summary: "new" }, "payload must be replaced");

    console.log("ai-analysis freshness smoke: ALL PASS");
  } finally {
    await db.delete(aiAnalysisCache).where(where);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("SMOKE FAIL:", err);
  process.exit(1);
});
