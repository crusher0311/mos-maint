---
name: Integration ops PG flags
description: Flag families and quirks from the integration operational-store Mongo→PG migration.
---

**Rule:** integration operational stores dispatch on `TEKMETRIC_OPS_PG_CANONICAL` / `PROTRACTOR_OPS_PG_CANONICAL` / `SHOPWARE_OPS_PG_CANONICAL` / `API_USAGE_PG_CANONICAL` (AutoVitals rides the existing CACHE flag); shadow-write kill switches `WRITE_MONGO_<DOMAIN>`. Helpers in `lib/db/integration-ops-write-mode.ts`; map §13 of docs/db-migration-map.md.

**Quirks worth remembering:**
- `tekmetric_tokens` in Mongo is a SINGLE global doc keyed `{tokenKey:"current"}`; the PG table keys by shop_id → global doc = shop_id 0 sentinel.
- `tekmetric_api_usage` collection is dead/empty; real usage log is cross-provider `api_usage` (provider field), windowed reads need (provider,timestamp) index.
- `protractor_callback_events` NOW migrated: the ObjectId contract was replaced by an opaque string key (Mongo mode = ObjectId hex, PG mode = app-generated UUID in `event_key`); repo in lib/data/repositories/protractor-callback-events.ts, runtime columns in drizzle/0024. Webhook-health's `__deps` fake-db test seam is preserved via optional `dbOverride` params on the Mongo-path read helpers.
- Repos round-trip unknown Mongo fields via `extra`/`payload` jsonb so flag-OFF/ON doc shapes stay identical.

**How to apply:** new operational-store consumers must go through the repos, not raw getDb; flips are operator-only (backfill classification: transient=pure flip, durable logs=scripts first — see runbook addendum).
