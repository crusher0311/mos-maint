---
name: job_index retirement is blocked (still has live readers)
description: Why the legacy Mongo job_index store cannot be retired/dropped yet, despite docs implying it's nearly orphaned.
---

The legacy Mongo `job_index` store is NOT safe to retire (stop `writeToJobIndex` /
drop the collection) despite task framing and an earlier migration-map claim that
it's "only read by helpers + calibration scripts."

**Why:** a reader re-audit found `job_index` still has multiple *live* readers — most
importantly the job-search **fallback arm** that fires whenever the Postgres arm
returns nothing, plus several secondary features (plan-build history, parts
intelligence, dashboard job-history/stats, labor-rate backfill). Crucially the
production Mongo→PG service-jobs backfill has NOT been run, so PG
`normalized_service_jobs` lacks pre-cutover history — making `job_index` the *only*
source for that data. (Don't trust migration-map prose that calls it "nearly
orphaned"; grep for readers before retiring — the prose lagged reality here.)

**How to apply:** Before retiring `job_index`, the prerequisite (operator action,
not doable in an isolated task env) is: run the service-jobs backfill, pass the soak
with the parity verifier clean, repoint the live readers to Postgres, THEN stop
writers and drop the collection. Note dev Mongo == prod Mongo, so dropping the
collection in dev destroys prod data. Tracked in `docs/db-migration-map.md` §3.6
(BLOCKED on the normalized_service_jobs cutover).
