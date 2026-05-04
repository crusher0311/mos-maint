# Task #347 — Final MongoDB Decommission: ABORTED at Step 1

**Date:** 2026-05-04
**Outcome:** Decommission aborted per the task's own architectural constraint:

> If any step uncovers a Mongo dependency that was missed, abort the
> decommission, reclassify the entity into a follow-up wave, and resume
> only after that's fixed and soaked.

No destructive action was taken. `lib/mongo.ts`, `lib/supabase-dual-writer.ts`,
the `mongodb` / `mongoose` packages, the `MONGODB_*` env vars, the Atlas
cluster, and every Mongo collection are **untouched**.

## Step 1 (pre-decommission audit) result

Re-running the required grep (`mongodb` / `mongoose` / `getDb()` /
`getMongoClient()` / `MONGODB_`) across the live tree (excluding
`_archive/**`, `node_modules/**`, `.local/**`, `docs/**`,
`attached_assets/**`) returns **487 distinct files** still actively
importing from MongoDB or holding a Mongo handle.

Breakdown by area:

| Area       | Files |
| ---------- | ----- |
| `app/`     | 319   |
| `lib/`     | 112   |
| `scripts/` | 50    |
| `tests/`   | 3     |
| **Total**  | **487 (≠ 0)** |

The pass criterion in Step 1 is "zero matches outside `_archive/**` and
the files this task is about to delete." We are nowhere close.

## Top live Mongo callsites (by reference count)

```
lib/data/repositories/pg/identity.ts            44   (W4 dual-write path)
lib/db/repositories/call-center.ts              25
lib/integrations/protractor/client.ts           17
lib/mongo.ts                                    13   (the file we'd delete)
lib/db/repositories/conversations.ts             8
lib/featureResolver.ts                           7
lib/data/repositories/shopware-cache.ts          7
lib/data/repositories/auto-booking-queue.ts      7
lib/cron/scheduler.cjs                           7   (distributed lock)
lib/stripe.ts                                    6
lib/integrations/tekmetric/job-index.ts          5
lib/db/repositories/voicemails.ts                5
lib/db/repositories/call-logs.ts                 5
app/api/settings/tekmetric/route.ts              5
app/api/settings/shopware/webhook/route.ts       5
app/api/settings/labor-rates/route.ts            5
app/api/enterprise/route.ts                      5
app/api/dashboard/concern-assistant/route.ts     5
…and 469 more
```

## Why the precondition isn't met

Cross-checking the migration map (`docs/db-migration-map.md`) and the
runtime kill-switches confirms the audit:

1. **W3a (six normalized entities) is still in soak.** PG is canonical
   but Mongo writes are still on by default
   (`WRITE_MONGO_NORMALIZED=1`, see
   `lib/integrations/core/normalized-write-mode.ts` and
   `lib/integrations/core/normalized-ingestion.ts`). Mongo is also
   still the read source for `app/api/estimate-assist/job-builder`,
   `lib/integrations/autovitals.ts`,
   `lib/estimate-assist/job-knowledge-base.ts`, and the
   `scripts/repair-patterns-from-jobindex.ts` /
   `scripts/verify-normalized-data.ts` paths called out in §2 of the
   migration map.
2. **W4 (identity / tenancy) only landed schema + central-lib gating.**
   `lib/db/wave4-write-mode.ts` defaults to `IDENTITY_PG_CANONICAL=0`
   and `WRITE_MONGO_IDENTITY=1`. The migration map's own §3.1 callout
   lists the unrefactored direct callsites (Stripe webhook 23 refs,
   settings/users 14, dashboard/enterprise-users 13, platform-admin
   shops 12, login 8, signup 7, admin-login 6, reset-password 5,
   billing portal 4, platform-admin plans 4, …). All still write Mongo.
3. **W2 / W3 raw-mirror entities** (Tekmetric / Protractor / Shop-Ware
   work-order, vehicle, customer, token, prewarm, drain-lock,
   webhook-log mirrors; Carfax; Autovitals; AutoFlow; plan caches;
   recommendations; ai_*_cache; canned_jobs; dvi; pre-normalized
   `repair_orders` / `vehicles` / `customers`; `job_index` family) are
   either not migrated or, where mirrored to PG by
   `scripts/backfill-mongo-to-supabase.ts`, are still read from Mongo
   at runtime by the integration adapters and prewarm jobs.
4. **Cron infrastructure depends on a Mongo-backed distributed lock**
   (`lib/cron/scheduler.cjs`, `scripts/clear-stale-drain-locks.mjs`,
   `scripts/drain-{tekmetric,protractor}-backfill.ts`). Removing
   `lib/mongo.ts` would break every cron run on the next deploy.
5. **Auth / sessions read from Mongo on every request** via
   `lib/auth.ts` → `sessions` collection. Removing the Mongo client
   would log every user out and 500 every authenticated route.

Any one of these would warrant aborting; together they make it clear
the prior waves haven't actually completed.

## Action taken in this task

- **Audit captured** (this file).
- **Migration map updated** to flag the decommission as BLOCKED with a
  pointer to this audit (see `docs/db-migration-map.md` header note
  added by this task).
- **No code, package, secret, env, or DB change.** Nothing was
  deleted, paused, or dropped.

## What needs to happen before #347 can resume

The migration map's existing wave structure already names the work.
In dependency order:

1. **Finish W3a soak and flip `WRITE_MONGO_NORMALIZED=0`.** Per-entity
   24–168 h soak windows for the six normalized entities. Move the
   remaining Mongo readers listed in map §2 onto PG first.
2. **Land the W3a-followup** that renames `lib/supabase-dual-writer.ts`
   → `lib/normalized-pg-writer.ts`, strips the Mongo-shape adapters,
   and wires `ingestLineItem` into the live single-WO path.
3. **Refactor the W4 direct callsites** (Stripe webhook, settings,
   admin, auth flows) onto `lib/data/repositories/pg/identity.ts` so
   `WRITE_MONGO_IDENTITY=0` and `IDENTITY_PG_CANONICAL=1` can ship.
4. **Cut over the W2 / W3 raw mirrors** at the read side — adapters,
   prewarm jobs, drain workers, cron lock, dashboard reads, plan
   caches, recommendations, AI caches, canned jobs, DVI, pre-normalized
   `repair_orders` / `vehicles` / `customers`, `job_index`. Today they
   are mirrored into PG by `scripts/backfill-mongo-to-supabase.ts` but
   still read from Mongo.
5. **Retire the legacy Express server** (`server.js` + `routes/*.js`)
   that still mounts `services_by_ymm` Mongo readers (map §3.4).
6. **Re-run Step 1 of #347.** Only when the grep returns zero matches
   outside `_archive/**` and the files this task is about to delete is
   it safe to proceed to Step 2 (final snapshot + collection drop +
   code/package/secret removal + cluster pause).

Until then, this task stays in BLOCKED state.
