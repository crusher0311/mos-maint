# Runbook — Final MongoDB Decommission (operator checklist)

**Status:** PRE-STAGED. Do not execute until the resume conditions in
`docs/audits/2026-08-01-task-1001-decommission-aborted.md` are met (all
`*_PG_CANONICAL` flags flipped + soaked, all `WRITE_MONGO_*=0`, prerequisite
tasks merged, Step-1 grep returns zero live Mongo files).

**Irreversibility warning:** once `lib/mongo.ts` and the env vars are removed
and the Atlas cluster is deleted, "fall back to Mongo" no longer exists.
Every step below is ordered so the point of no return comes last.

---

## Phase A — Final verification (read-only, any time)

1. `rg -l "from ['\"]mongodb['\"]|from ['\"]mongoose['\"]|getDb\(|getMongoClient\(" app lib scripts tests` → must return **zero** files.
2. Confirm in the production environment (Render dashboard, both web + workers):
   every `*_PG_CANONICAL=1` and every `WRITE_MONGO_*=0`, and the app has run
   ≥7 days in that state with Better Stack (host `mos-maintenance-mvp-main`)
   clean of Mongo references.
3. `tsx scripts/cutover-parity.ts --domain=all` exits 0 (last time it will run).

## Phase B — Code removal (deploy)

1. Delete `lib/mongo.ts` and all remaining flag-gated Mongo branches
   (dual-writers, shadow-write helpers, Mongo arms of repositories).
2. `npm uninstall mongodb mongoose` (check `package-lock.json` has no residue;
   beware the Replit-proxy-URL lockfile trap — `check-lockfile-sync` guards it).
3. Delete obsolete Mongo-only backfill/migration scripts
   (`scripts/backfill-mongo-to-supabase.ts`, `scripts/verify-normalized-data.ts`,
   wave backfills, drain-lock Mongo paths); keep PG-only tooling.
4. Empty the `ALLOWLIST` in `scripts/check-direct-db.cjs` and repurpose the
   guard to forbid *any* `mongodb`/`mongoose` import (it runs in the Render
   prebuild, so this permanently gates regressions out of prod deploys).
5. Remove all `MONGODB_*` references from code and configs.
6. Full build + test pass; deploy; watch one peak window.

## Phase C — Environment cleanup

1. Remove `MONGODB_USERNAME`, `MONGODB_PASSWORD`, `MONGODB_URI`, `MONGODB_DB`,
   `MONGODB_SOCKET_TIMEOUT_MS` from: Render env groups (web `mos-tools`,
   `backfill-drain-worker`), Replit workspace secrets, `.env*` files.
2. Rotate nothing into place — there is no replacement secret.

## Phase D — Production data (Atlas) — the irreversible part

1. **Snapshot to cold storage:** take a full `mongodump` of both databases
   (`mos-maintenance-mvp` — app data, AND `mos` — cron bookkeeping; note the
   two-db split), verify the archive restores locally, upload to object
   storage, record checksum + location here.
2. **Pre-drop counts:** for every collection, record
   `db.collection.estimatedDocumentCount()` into a dated audit file.
3. **Drop collections** (only after snapshot verified).
4. **Pause the Atlas cluster** — keep paused **≥30 days** as the last-resort
   recovery window. Calendar the delete date.
5. After ≥30 days with no incident: **delete the cluster**, remove the Atlas
   project/users/IP allowlist entries.

## Phase E — Docs closeout

1. Mark every entity in `docs/db-migration-map.md` dropped/retired; flip the
   status header to COMPLETE.
2. Update `replit.md` + architecture docs to describe a single-DB
   (Supabase Postgres) world.
3. Write the migration post-mortem note in `docs/runbooks/`.
4. Prune stale memory entries that assume Mongo exists (e.g.
   "Dev Mongo is Prod Mongo").
