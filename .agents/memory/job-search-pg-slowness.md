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

## Fix directions (all need Brandon to deploy; some are prod-DB ops)
1. **Durable:** add `pg_trgm` and a GIN trigram index on title/description/canned_job_name
   (CREATE EXTENSION + CREATE INDEX CONCURRENTLY on prod Supabase — operator/deploy action),
   then the ILIKE can use it.
2. **Quick mitigation (code-only):** add an app statement_timeout (~8s) to the PG query so
   pathological searches fail fast with the existing "Search timed out, try a more specific
   term" UX instead of hanging.
3. **Scope:** default search to the current shop (or set `jobHistoryShopIds`) instead of the
   whole enterprise — behavior change, ask first.

## Entitlement is NOT the cause
Founder plan code is the string `"detect_dog_founder"` (`FOUNDER_PLAN` in
`lib/featureResolver.ts`; `isFounderPlan` matches it exactly) and grants ALL `FEATURE_KEYS`,
so `job_lookup` is entitled for founder-plan shops. (Older note calling the founder code
"n" is outdated.)
