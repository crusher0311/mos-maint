---
name: Dashboard/KB search index-friendly
description: Why dashboard Mongo search and KB Postgres search are anchored/trigram, and the semantics tradeoff.
---

# Dashboard/KB search index-friendly

Dashboard search (archived work-orders/vehicles + Protractor job-history) and the
KB search used leading-wildcard "contains" matches that CANNOT use a b-tree index
and degrade to collection/table scans as data grows — the same slowness class as
the pre-pg_trgm job-search path.

## Rule
- Mongo text search branches are ANCHORED (prefix `^…`, escaped) via
  `lib/dashboard-search.ts` so each `$or` branch is index-eligible. VIN is
  upper-cased + case-sensitive (VINs are stored upper-case → tight bounds); other
  human-entered fields stay case-insensitive.
  **Why:** a case-insensitive `{ $regex, $options:'i' }` is never index-usable in
  Mongo, and one non-indexable `$or` branch forces the whole `$or` to COLLSCAN.
  **Semantics tradeoff:** "contains" → "starts with". Accepted: VIN/RO are
  prefix by nature; customer last-name search still works via its own branch.
- KB search (`pgSearchArticleCandidates` in `lib/db/repositories/wave1.ts`) keeps
  its `ILIKE '%term%'` predicate but relies on pg_trgm `gin_trgm_ops` indexes,
  exactly like the job-search fix.

## How to apply (operator-gated — never run from an isolated/dev env)
- Postgres: `drizzle/0021_task758_kb_search_trgm.sql` + mirrored in
  `scripts/apply-normalized-migration.ts` (`npm run db:migrate:normalized`).
- Mongo: companion `{shopId, field}` indexes are in `scripts/ensure-indexes.ts`.
- On populated prod tables build with `CREATE INDEX CONCURRENTLY` (PG) / background
  (Mongo) to avoid write locks. Dev Mongo IS prod — do not create from dev.
