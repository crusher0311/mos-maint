/**
 * Task #998 — plan & analysis cache family Mongo→PG cutover flags.
 *
 * Mirrors the established kill-switch pattern
 * (`lib/db/integration-cache-write-mode.ts`, `lib/db/wave4-write-mode.ts`):
 *
 *  - `PLAN_CACHE_PG_CANONICAL=1` flips the plan/analysis/recommendation
 *    cache family (cached_plans, maintenance_analysis_cache,
 *    ai_analysis_cache, plan_prefetch_cache, cached_work_orders,
 *    recommendations, recommendations_cache, recommendation_events,
 *    report_approved_items, remedied_deferred_work) from Mongo-canonical
 *    to Postgres-canonical. **Default OFF → Mongo canonical → zero
 *    behaviour change.**
 *  - `WRITE_MONGO_PLAN_CACHE=0` disables the Mongo shadow write during
 *    the post-flip soak. **Default ON.** While shadow writes are on,
 *    PG-canonical reads also fall back to Mongo on a miss so the warm
 *    cache survives the flip (these are TTL caches — no backfill; Mongo
 *    entries simply age out).
 *
 * Both flags are read on every call so they are no-deploy runtime
 * toggles. Flipping them in production is operator-only (see
 * docs/runbooks/db-plan-cache-cutover.md).
 */

export function isPlanCachePgCanonical(): boolean {
  return process.env.PLAN_CACHE_PG_CANONICAL === "1";
}

export function shouldShadowWriteMongoPlanCache(): boolean {
  return process.env.WRITE_MONGO_PLAN_CACHE !== "0";
}

/**
 * Runs a Mongo shadow write when PG is canonical and shadow writes are
 * enabled. Failures are logged, never thrown — a Mongo outage must not
 * break a PG-canonical cache write.
 */
export async function shadowWriteMongoPlanCache(
  label: string,
  fn: () => Promise<unknown>,
): Promise<void> {
  if (!shouldShadowWriteMongoPlanCache()) return;
  try {
    await fn();
  } catch (err) {
    console.error(
      `[ShadowMongoPlanCache] ${label} failed (non-fatal):`,
      (err as Error)?.message ?? err,
    );
  }
}
