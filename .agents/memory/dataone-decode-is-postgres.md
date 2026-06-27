---
name: DataOne decode is Postgres + ACES backfill poisoning
description: Why the job_index ACES backfill can't run at peak and how a failed decode silently corrupts the resume marker
---

# DataOne VIN decode is a Postgres query

`enrichVinsWithAces` (`lib/job-index-aces.ts`) decodes VINs by reading the
DataOne dataset from a **Postgres** DB — `lib/integrations/dataone-local.ts`
connects to `DATAONE_DATABASE_URL` (falls back to `DATABASE_URL`). So there is
**no Postgres-free path** for the ACES backfill, even with
`--skip-reindex --skip-vin-recovery --skip-pg-mirror` (those only avoid the
*app* Postgres phases A2/C; Phase B still hits the DataOne Postgres).

**Why it matters:** At peak hours both the app Postgres (Supabase) and the
DataOne Postgres can hit their connection limit and reject new connections with
`53300 remaining connection slots are reserved for roles with the SUPERUSER
attribute`. Confirmed mid-afternoon CT 2026-06-27: both refused. The decode
simply cannot run then.

**How to apply:** Run `scripts/backfill-job-index-aces.ts` (npm
`backfill:job-index-aces`) only **off-peak**. An upgrade isn't strictly needed
— it's a transient connection-limit, not a sizing problem — but the DataOne PG
connection pool is the real bottleneck for the decode.

# Resume-marker poisoning under connection pressure

Phase B of the backfill stamps `vehicle.acesDecodedAt` on every processed doc
**even when the batch decode threw** — it can't distinguish "VIN genuinely not
in DataOne" from "DataOne connection failed", so it marks the whole batch
`unresolvable` (null ACES) AND stamps `acesDecodedAt`. Since `acesDecodedAt` is
the resume marker (`baseFilter = { "vehicle.acesDecodedAt": { $exists: false } }`),
those docs are then **skipped forever** — silently stuck at null ACES.

**Why:** observed live — a shop-114 `--skip-reindex` run during PG saturation
logged `[DataOne] Batch decode error` then `unresolvable=500`; 604 docs were
poisoned before the run was stopped, then repaired by `$unset`-ing
`vehicle.acesDecodedAt`/`acesVehicleId`/`acesEngineId`/`submodelKey`.

**How to apply:** Never run the decode while DataOne/PG is connection-saturated.
The backfill is now hardened against this: a preflight `pingDataOneDb()` aborts
the run before mutating any doc if DataOne is unreachable, and Phase B decodes
via the strict path (`enrichVinsWithAcesStrict` → `batchDecodeSquishesStrict`)
so a mid-run connection failure THROWS and aborts before stamping that batch
(instead of swallowing the error into an empty map and marking everything
unresolvable). A genuine no-match is still stamped unresolvable (correct).
Legacy poisoning from runs made BEFORE this guard still needs the manual
`$unset` of `acesDecodedAt`/`acesVehicleId`/`acesEngineId`/`submodelKey` on the
freshly-null docs.

**Key gotcha:** `batchDecodeSquishes` itself ALSO swallows errors (logs
`[DataOne] Batch decode error` and returns an empty map) — the soft-fail is at
the DataOne layer, not just the enrich layer. That's why a strict sibling
(`batchDecodeSquishesStrict`) was needed for the backfill to even see the
failure.
