---
name: job_index retirement is blocked (still has live readers)
description: Why the legacy Mongo job_index store cannot be retired/dropped yet, despite docs implying it's nearly orphaned.
---

The legacy Mongo `job_index` store is NOT safe to retire (stop `writeToJobIndex` /
drop the collection) despite task framing and an earlier migration-map claim that
it's "only read by helpers + calibration scripts."

**Why:** A 2026-05-30 reader re-audit found `job_index` is still read by the live
job-search **fallback arm** (`lib/mongo-job-search.ts`, called by
`app/api/jobs/search` and `app/api/extension/jobs/search` whenever the Postgres
arm returns nothing) AND by several other live features: `plan-build`
(service-history secondary source), `parts/*` (parts intelligence), dashboard
`protractor/job-history`, `jobs/stats`, and `backfill-labor-rates`. The production
Mongo→PG backfill (`scripts/backfill-mongo-to-supabase.ts`) has not been run, so PG
`normalized_service_jobs` lacks history — making `job_index` the *only* source for
pre-cutover data.

**How to apply:** Before retiring `job_index`, the prerequisite (operator action,
not doable in an isolated task env) is: run the service-jobs backfill, pass the §2
soak with the parity verifier clean, repoint the live readers above to Postgres,
THEN stop writers and drop the collection. Also note dev Mongo == prod Mongo here,
so dropping the collection in dev destroys prod data. Tracked in
`docs/db-migration-map.md` §3.6 (BLOCKED on the §2 normalized_service_jobs cutover).
