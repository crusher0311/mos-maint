---
name: Enterprise job-search candidate fairness
description: Why PG job-search must pick candidates per-shop, not by global recency, or one enterprise shop starves the rest
---

# Enterprise job-search candidate fairness

**Rule:** The PG arm's candidate selection (`lib/supabase-job-search.ts`) must be fair
*per shop* — rank rows within each shop (`ROW_NUMBER() OVER (PARTITION BY shop_id
ORDER BY created_at DESC)`, keep each shop's top slice) — NOT a single global
`ORDER BY created_at DESC LIMIT`. Also apply make/model filters in SQL *before* the
per-shop cap, never in JS after it.

**Why:** In an enterprise (many sibling shops searched together), a single global
recency-ordered LIMIT lets the busiest / most-recently-backfilled shop fill the entire
candidate window, so every other location is dropped *before* scoring ever runs — the
symptom is "all results come from one location (e.g. Evanston) and my own shop never
even ranks." `created_at` is row INGEST time, not the service date, so whichever shop
was normalized/backfilled last wins. The old code compounded it by JS-filtering make
*after* the recency cut, discarding the relevant rows for less-recently-ingested shops.

**How to apply:** Keep it a SINGLE query (window function in a subquery, filter on
`rn <= perShopLimit`, then `ORDER BY rn, created_at DESC` for round-robin under a
global safety cap). Do NOT fan out one query per shop — the Drizzle PG pool is
`max: 2` and `searchJobsCombined` only gives PG a ~1.2s grace window before serving
the Mongo fallback, so N parallel queries would be slow and flip results to the
dormant Mongo arm. `mapServiceJobToCanonicalResult` shape must stay unchanged (it is
snapshot-tested and consumed by the route's scoreJob/dedup/sort pass). The final
relevance ranking still happens downstream in the route, not in this arm.
