---
name: Drizzle migration path (hand-written, not drizzle-kit)
description: How normalized-PG schema changes actually ship in this repo — drizzle-kit generate is dead.
---

# Drizzle migration path

`npm run db:generate` (drizzle-kit) is NOT the canonical migration mechanism in
this repo and will fail in a non-TTY shell with an interactive
`promptNamedWithSchemasConflict` / `tablesResolver` prompt.

**Why:** the drizzle-kit journal/snapshots are badly out of sync with reality —
`drizzle/meta/_journal.json` stops at `idx 12` (tag `0012_*`) and the `*_snapshot.json`
files stop at `0007`, yet the actual `drizzle/*.sql` files run up to `0020+`.
So drizzle-kit thinks every table added since then is a brand-new/renamed table and
tries to prompt to resolve, which dies without a TTY. This drift is pre-existing,
not something a feature task should "fix."

**How to apply:** when adding a normalized PG table/column:
1. Add the Drizzle table/columns to `lib/db/schema/normalized.ts` (typed access).
2. Hand-write the raw SQL as the next `drizzle/00NN_<task>.sql` — it MUST be
   fully idempotent (`CREATE TABLE/INDEX IF NOT EXISTS`, guarded `DO $$` blocks,
   `ALTER TABLE IF EXISTS ... ADD COLUMN IF NOT EXISTS`).
3. Append the filename to `drizzleMigrationFiles` in
   `scripts/apply-normalized-migration.ts` — since task #1020 the applicator
   executes the whole hand-written file series (0011+ plus the
   `0027_task1020_full_schema_baseline.sql` pre-wave baseline) via
   `sql.unsafe(file).simple()`, so no statement mirroring is needed anymore.
   Bump its hard-coded verification table list when adding tables. This raw
   idempotent applicator (`npm run db:migrate:normalized`) is the REAL apply
   path and gives a fresh environment the COMPLETE schema.
Do NOT try to run `db:generate`; do NOT hand-edit the drizzle journal/snapshots.

**Drift trap:** some drizzle files historically re-declared tables owned by an
earlier wave with a different shape (e.g. `sms_historical_work_orders`,
`platform_plans`); the earlier/wave-1/2 shape is what prod actually has, so a
later file's index on a column that only exists in its own stale CREATE will
fail on prod AND fresh envs. When a CREATE TABLE IF NOT EXISTS is skipped,
guard any index on shape-divergent columns with an information_schema check.

Applying the migration to the live DATAONE Postgres (esp. CREATE INDEX) is an
operator action — an isolated env agent should leave it as a follow-up, not run
it against the shared DB.
