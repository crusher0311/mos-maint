# Task #1001 — Final MongoDB Decommission: ABORTED at Step 1 (again)

**Date:** 2026-08-01
**Outcome:** Aborted at the pre-decommission audit, exactly like task #347
(2026-05-04). No destructive action was taken. `lib/mongo.ts`, the
`mongodb`/`mongoose` packages, the `MONGODB_*` env vars/secrets, the
`lint:direct-db` allowlist, all Mongo-facing scripts, and every Atlas
collection are **untouched**.

## Step 1 (pre-decommission audit) result

Grep across the live tree (`mongodb`/`mongoose` imports + `getDb()` /
`getMongoClient()` call sites; excludes `_archive/**`, `node_modules/**`):

| Area       | Files |
| ---------- | ----- |
| `app/`     | 335   |
| `lib/`     | 183   |
| `scripts/` | 96    |
| `tests/`   | 9     |
| **Total**  | **623 (≠ 0)** |

The count is *higher* than #347's 487 because the intervening work
(integration-cache repos, ops stores, Shopmonkey integration, alerter crons)
added new flag-gated dual paths and operational collections that legitimately
still touch Mongo while the flags default to Mongo-canonical.

## Why the decommission cannot proceed

1. **No canonical flag is flipped anywhere.** `IDENTITY_PG_CANONICAL`,
   `<INT>_CACHE_PG_CANONICAL`, `<INT>_OPS_PG_CANONICAL`,
   `API_USAGE_PG_CANONICAL`, `CRON_LOCK_PG_CANONICAL`, and
   `WRITE_MONGO_*` shadow kill-switches are unset in every config
   (`.env*`, `.replit`, `render.yaml`) — production is still on the
   pre-cutover defaults (Mongo-canonical, shadow writes on).
2. **Prerequisite tasks are unmerged.** Task #560 (move job history / parts /
   plan off legacy `job_index`), #327 (move drain/prewarm jobs off the
   direct-DB list), and the operator flip+soak work per
   `docs/runbooks/mongo-cutover-sequence.md` are all still open.
3. **Many writers are still direct-to-Mongo by design** while shadow writes
   are on (integration cache sync/backfill writers, dashboard/plan-build/vhi
   aggregates, identity long-tail writers) — inventoried in
   `docs/runbooks/db-integration-cache-cutover.md` and the migration map.

Per the decommission's own architectural constraint ("If any step uncovers a
Mongo dependency that was missed, abort"), the removal steps were not run.

## Resume conditions

Re-attempt only when ALL of:
- Every `*_PG_CANONICAL` flag flipped in prod and soaked 24–168 h with
  `scripts/cutover-parity.ts` clean, and every `WRITE_MONGO_*` set to `0`.
- Tasks #560 / #327 and the remaining direct-writer fold-ons merged.
- The Step-1 grep returns zero live files.

When those hold, execute the operator checklist:
`docs/runbooks/mongo-final-decommission-checklist.md`.
