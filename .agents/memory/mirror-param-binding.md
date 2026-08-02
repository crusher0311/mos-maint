---
name: Mongo→PG mirror parameter binding
description: Why raw drizzle sql`${v}` params break backfill mirrors (undefined + arrays) and the required binding rules.
---

Rule: mirror upserts must never hand raw extract values to drizzle's sql template.
- postgres-js hard-rejects `undefined` params (UNDEFINED_VALUE); absent Mongo fields must bind as SQL NULL (`transform: { undefined: null }` on the pool + explicit null in the param builder).
- drizzle renders a JS array param as a SQL tuple (`($20,$21,…)`/`()`), not jsonb — arrays/plain objects destined for jsonb columns must bind as ONE `JSON.stringify(v)::jsonb` parameter (Dates pass through).
- PG enum columns need enum-safe coercion: Mongo carries values outside the enum (e.g. support-ticket category `account`); map unknowns to a fallback and stash the original in metadata rather than failing the row.

**Why:** confirmed 2026-08-02 — every legacy-mirror row failed against prod Supabase while direct SQL succeeded; purely script-side binding.
**How to apply:** shared helpers in `scripts/backfill-mirror-utils.ts` (mirrorParam/buildMirrorUpsert/safeEnum, tested by tests/backfill-mirror-utils.smoke.ts); route any new mirror through them.
