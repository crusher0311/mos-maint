---
name: Enterprise job-search candidate fairness
description: Why BOTH job-search arms (PG and Mongo) must pick candidates per-shop, not by global recency, or one enterprise shop starves the rest
---

# Enterprise job-search candidate fairness

**Rule:** Candidate selection in BOTH job-search arms must be fair *per shop*, NOT a
single global cap across all enterprise shops:
- PG arm (`lib/supabase-job-search.ts`): rank within each shop
  (`ROW_NUMBER() OVER (PARTITION BY shop_id ORDER BY created_at DESC)`), keep each
  shop's top slice, then round-robin under a global cap.
- Mongo arm (`lib/mongo-job-search.ts`): for multi-shop searches, fetch a bounded
  slice PER shop in parallel (indexed `{$match:{shopId,keywords,make}}` + `$limit`),
  then round-robin interleave and cap. Single-shop path stays a plain bounded fetch.

**Why the Mongo arm ALSO matters (the non-obvious part):** `lib/job-search-combined.ts`
runs both arms concurrently but gives PG only a ~1.2s grace window (`PG_GRACE_MS`).
Enterprise multi-word PG queries take ~16s, so for a multi-location enterprise the PG
arm blows past the grace window and the combined search **serves the Mongo arm**. So
fixing only PG looks correct in isolation but does nothing for the enterprise case that
actually fails — Mongo is what serves it. Symptom: extension job lookup shows results
from only ONE location (e.g. Evanston) while the user is at another (e.g. Arlington
Heights). A single global `$match {shopId:{$in:all}} + $limit` returns whatever the
index yields first (one shop). `created_at`/index order is ingest order, not service
date, so the busiest / most-recently-backfilled shop wins.

**How to apply:**
- Keep it ONE PG query (window function subquery) — the Drizzle PG pool is `max: 2` and
  PG only has the ~1.2s grace, so N parallel PG queries are wrong. Mongo has no such
  tiny pool, so per-shop *parallel* fan-out is fine there (bounded + indexed + fast:
  ~250ms for 20 shops on live data).
- Do NOT add a DB-side `$sort: {performedAt:-1}` to the Mongo query — measured ~160x
  slower / guaranteed timeout on enterprise data. Sort in app code per shop instead.
- The route (`app/api/extension/jobs/search/route.ts`) passes `supabaseLimit=limit*2`,
  `mongoLimit=limit*5`, then re-scores/dedups (key = title-make-model-year, NO shopId)
  /sorts and slices to `limit`. Final ranking is by merit downstream, so each arm only
  needs to return a FAIR candidate set; keep `mapServiceJobToCanonicalResult` and the
  Mongo `{...doc, dataSource:'job_index'}` shape unchanged (snapshot/shape tested).
- Beware dedup collapses cross-shop identical jobs to one representative by score; that
  is expected. Fairness is about getting every shop's DISTINCT jobs into the candidate
  set, not about forcing every shop into the final list.
