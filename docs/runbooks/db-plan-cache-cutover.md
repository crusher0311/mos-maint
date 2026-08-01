# DB plan & analysis cache cutover — Mongo→Postgres flip

Task: **#998 — move plan & analysis caches to Postgres**.
Family: `cached_plans`, `plan_prefetch_cache`, `cached_work_orders`,
`ai_analysis_cache`, `maintenance_analysis_cache`, `recommendations`,
`recommendations_cache`, `recommendation_events`, `report_approved_items`,
`remedied_deferred_work`. (`viewed_vins` was already PG-canonical in Wave 1;
`plan_cache` is a dead legacy collection with no writers — its only
remaining reference is a cleanup delete.)

> **Safety.** In this repl, dev MongoDB == the **production** cluster.
> All flips/backfills below are operator actions against the deployed
> app's env during an announced window.

## Flags (`lib/db/plan-cache-write-mode.ts`)

Read on every call — toggling is a no-deploy env change:

| Flag | Default | Meaning |
| --- | --- | --- |
| `PLAN_CACHE_PG_CANONICAL=1` | OFF | Facade reads/writes **Postgres**; Mongo shadow-written. OFF = Mongo canonical, byte-for-byte legacy behaviour. |
| `WRITE_MONGO_PLAN_CACHE=0` | ON | Turns off the soak-window Mongo shadow write. Any value other than literal `"0"` keeps it on. |

Dispatch lives in `lib/data/repositories/plan-cache-store.ts` (facade) →
`lib/data/repositories/pg/plan-cache.ts` (PG arm). PG tables already exist
(`drizzle/0012` wave2 + `drizzle/0014` wave3) — **no new migration**.

Key semantics preserved on both arms:
* TTLs stay in caller logic (`lib/plan-cache.ts` 4h / 10-min `oemMissing`,
  24h ai/recommendations caches, 4h prefetch & analysis) — validity is
  evaluated at read time by the shared pure `selectValidCachedPlan`.
* Mongo arm keeps `shopId $in [String, Number]`, `createdAt:-1` sort, and
  the legacy string-shopId cleanup on upsert.
* **Invalidations/deletes always hit BOTH stores** regardless of flags
  (intervals-save, protractor disconnect, oil-duty, admin clear).
* While the shadow write is ON, a PG read miss falls back to Mongo, so the
  warm cache survives the flip; a fully cold PG cache at flip time is also
  acceptable (these are rebuildable caches).
* When PG is canonical, `recommendation_events` inserts go to PG
  canonically with Mongo still written for the ObjectId return contract;
  analytics aggregates run as PG SQL group-bys.

## Flip sequence

0. **Verify the wave-2 tables exist** in the target PG before anything
   else: `ai_analysis_cache`, `maintenance_analysis_cache`,
   `report_approved_items`, `remedied_deferred_work` come from
   `drizzle/0012_wave2_operational.sql`, which is **not** mirrored in
   `scripts/apply-normalized-migration.ts` — a fresh environment can have
   the wave-3 tables but not these (the dev PG did). Apply 0012 (it is
   idempotent `IF NOT EXISTS` DDL) if any are missing.
1. **Backfill durable stores** (off-peak, resumable):
   ```bash
   npx tsx scripts/plan-cache-family-backfill.ts            # events, recommendations, cached_work_orders
   npx tsx scripts/plan-cache-family-backfill.ts --dry-run  # preview
   npx tsx scripts/plan-cache-family-backfill.ts --store recommendation_events
   ```
   plus the wave-2 script for `report_approved_items` /
   `remedied_deferred_work` / both analysis caches:
   `scripts/wave2-mongo-to-pg-backfill.ts`.
   Resume file: `.plan-cache-family-backfill-resume.json` (rerun continues;
   delete to restart). TTL caches need **no** backfill.
2. **Flip**: set `PLAN_CACHE_PG_CANONICAL=1` (leave shadow ON).
3. **Soak** ≥ 1 week: watch plan/VHI hit rates, extension + dashboard +
   partner VHI latencies, `[PlanCacheStore]` shadow-write warnings, and
   shop analytics totals vs. pre-flip.
4. **Verify durable-store parity** (counts per shop for
   recommendation_events / recommendations / cached_work_orders), then set
   `WRITE_MONGO_PLAN_CACHE=0`.
5. **Rollback** at any point pre-step-4: unset `PLAN_CACHE_PG_CANONICAL`.
   Mongo is still fresh because the shadow write was on.

## Smoke checks

```bash
npx tsx tests/plan-cache-pg-cutover.smoke.ts   # flags + validity rules
npx tsx tests/plan-build-cache-write.smoke.ts
npx tsx tests/plan-cache-oem-missing.smoke.ts
npx tsx tests/vhi-analysis-cache-task-945.smoke.ts
```
