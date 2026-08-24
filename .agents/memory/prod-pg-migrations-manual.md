---
name: Prod PG migrations are manual and lag deploys
description: Render deploys don't run drizzle SQL; prod Supabase lacks wave4 identity tables so FKs to users/shops fail there
---
Rule: shipping code that writes a NEW Postgres table breaks prod at runtime until someone hand-applies the drizzle/00NN.sql to the prod Supabase DB — the Render build/deploy does NOT run migrations. Symptom: feature 500s in prod ("Failed query: insert into <table>") while dev works.

**Why:** 2026-08-24 extension login was down fleet-wide: the extension-sessions code deployed but its migration was never applied, so every login 500ed at the session insert.

**How to apply:**
- Prod Supabase (same DB `slow_queries` etc. live on) is the app PG; verify with `psql "$SUPABASE_PROD_DATABASE_URL"`.
- Prod does NOT have the wave4 identity tables (`users`, `shops`, `sessions` in public) — identity is still Mongo-canonical there. Any new table whose migration has `REFERENCES "users"/"shops"` must be applied to prod with those FK clauses stripped (dev keeps them). extension_sessions/extension_action_grant_uses were applied FK-less on prod.
- After merging a task that adds a drizzle migration, apply it to prod around the same deploy, and probe with a BEGIN/insert/ROLLBACK shape test.
