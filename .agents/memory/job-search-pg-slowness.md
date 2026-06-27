---
name: Job search PG slowness (enterprise + leading-wildcard ILIKE)
description: Why extension/dashboard job-history search is painfully slow for large enterprise shops, and the real (non-obvious) root cause in the Postgres path.
---

# Job search PG slowness

Both job-search routes (`app/api/extension/jobs/search/route.ts`, `app/api/jobs/search/route.ts`)
read Supabase `normalized_service_jobs` first via `searchSupabaseServiceJobs`
(`lib/supabase-job-search.ts`), then fall back to Mongo `job_index`
(`lib/mongo-job-search.ts`) ONLY when PG returns zero.

## The "never wired up" comment is STALE
The route comment (~lines 254-280) says PG ingestion of `normalized_service_jobs`
"was never wired up" so PG always returns empty and Mongo always serves. **Not true
anymore.** As observed: `normalized_service_jobs` had ~2.3M rows total and ~18k for a
single HEART shop (shop_id 122). PG IS populated and IS the live path. Do not trust
that comment.

## Real root cause
The PG query filters with **leading-wildcard `ILIKE '%token%'`** across
title/description/canned_job_name, plus a `(soft_delete->>'isDeleted')::boolean=false`
JSONB filter, joins work orders, and `ORDER BY created_at DESC LIMIT`.

- There is **no `pg_trgm` GIN index** (pg_trgm not even installed), so leading-wildcard
  ILIKE cannot be index-assisted.
- The planner satisfies the ORDER BY + LIMIT by scanning `nsj_created_at_idx` **backward**
  and filtering each row. For a COMMON term (e.g. "brake") it finds the 40 rows fast
  (~64ms). For a RARE term, a MULTI-token AND, or a ZERO-match/typo term it must walk a
  huge fraction of the rows → **>25s (hits statement timeout)**. Measured on the HEART
  enterprise subset (246,355 rows across 7 shops).
- There is **no app-level statement_timeout** on the PG query (unlike Mongo's 8s
  `maxTimeMS`), so a pathological search blocks the extension for the full DB timeout.

## Enterprise fan-out amplifies it
`resolveSearchShopIds` returns **all** enterprise shopIds when the shop has no
`preferences.jobHistoryShopIds`. HEART (enterprise `HEART Certified Auto Care`) = 7 shops
(internal ids 32,36,37,82,112,122,123), ~1.77M Mongo `job_index` docs and ~246k PG service
jobs combined. So every search at one HEART location scans all 7 shops' data.

## Fix applied (durable, option 1)
`pg_trgm` is now installed on prod Supabase and three `gin_trgm_ops` GIN indexes exist on
`normalized_service_jobs` (`nsj_title_trgm_idx`, `nsj_description_trgm_idx`,
`nsj_canned_job_name_trgm_idx`), built with `CREATE INDEX CONCURRENTLY` (all valid).
Re-EXPLAIN: the timing-out cases dropped from 25s+ to sub-second (rare term ~887ms,
two-token ~613ms, zero-match ~2ms); common "brake" stayed ~68ms. Persisted idempotently in
`scripts/apply-normalized-migration.ts` (CREATE EXTENSION + 3 CREATE INDEX IF NOT EXISTS)
and `drizzle/0019_job_search_trgm.sql`.
**Watch out:** the persisted SQL is plain (non-concurrent) `CREATE INDEX IF NOT EXISTS` —
fine for fresh/empty envs, but on a populated live table use `CREATE INDEX CONCURRENTLY`
outside a transaction to avoid a write lock.

## Sequential→concurrent + Mongo date-sort removal (task #692)
Two separate slowness sources beyond the PG trgm work:
- **Mongo `job_index` arm was self-inflicting a timeout.** It asked Mongo to `$sort
  { performedAt: -1 }` before `$limit`. With the sort the identical query takes ~22s;
  without it ~0.1s (160×). Capped at `maxTimeMS: 8000`, enterprise shops ALWAYS timed
  out → zero results even though the history existed. Fix: drop the DB-side `$sort`,
  keep `$limit`, sort the (already-bounded) result set by `performedAt` in app code
  (`lib/mongo-job-search.ts`). **Never re-add a `$sort` before `$limit` on `job_index`.**
- **The two arms ran sequentially** (PG first, Mongo only when PG returned zero), so the
  ~16s enterprise PG arm blocked before the fallback could even start. Fix: run both
  concurrently via `selectCombinedResults` in `lib/job-search-combined.ts`; prefer the
  canonical PG result when it returns rows within a short grace window (`PG_GRACE_MS`),
  otherwise serve the now-fast Mongo arm promptly. Both routes call `searchJobsCombined`.
  **Why grace, not pure race:** Mongo always wins a raw race (sub-second vs PG's variable
  time), which would silently demote PG from canonical for fast single-shop queries.
  Covered by `tests/jobs-search-concurrency.smoke.ts`.

## Other options NOT taken (Brandon's call)
- App-level statement_timeout (~8s fail-fast) — Brandon explicitly did **not** want this.
- Narrowing search to the current shop instead of the whole enterprise — behavior change,
  not done.

## Entitlement is NOT the cause
Founder plan code is the string `"detect_dog_founder"` (`FOUNDER_PLAN` in
`lib/featureResolver.ts`; `isFounderPlan` matches it exactly) and grants ALL `FEATURE_KEYS`,
so `job_lookup` is entitled for founder-plan shops. (Older note calling the founder code
"n" is outdated.)
