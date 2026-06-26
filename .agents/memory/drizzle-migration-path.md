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
2. Hand-write the raw SQL as the next `drizzle/00NN_<task>.sql` (use
   `CREATE TABLE/INDEX IF NOT EXISTS` so it's idempotent). Match the style of
   0013–0019 which are all hand-written without journal entries.
3. Mirror the same statements into `scripts/apply-normalized-migration.ts`
   (tableStatements + indexStatements) and bump its hard-coded verification
   table list. This raw idempotent applicator (`npm run db:migrate:normalized`)
   is the REAL apply path.
Do NOT try to run `db:generate`; do NOT hand-edit the drizzle journal/snapshots.

Applying the migration to the live DATAONE Postgres (esp. CREATE INDEX) is an
operator action — an isolated env agent should leave it as a follow-up, not run
it against the shared DB.
