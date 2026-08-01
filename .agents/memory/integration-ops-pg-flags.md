---
name: Integration ops PG flags
description: Flag families and quirks from the integration operational-store Mongo→PG migration.
---

**Rule:** integration operational stores dispatch on `TEKMETRIC_OPS_PG_CANONICAL` / `PROTRACTOR_OPS_PG_CANONICAL` / `SHOPWARE_OPS_PG_CANONICAL` / `API_USAGE_PG_CANONICAL` (AutoVitals rides the existing CACHE flag); shadow-write kill switches `WRITE_MONGO_<DOMAIN>`. Helpers in `lib/db/integration-ops-write-mode.ts`; map §13 of docs/db-migration-map.md.

**Quirks worth remembering:**
- `tekmetric_tokens` in Mongo is a SINGLE global doc keyed `{tokenKey:"current"}`; the PG table keys by shop_id → global doc = shop_id 0 sentinel.
- `tekmetric_api_usage` collection is dead/empty; real usage log is cross-provider `api_usage` (provider field), windowed reads need (provider,timestamp) index.
- `protractor_callback_events` deliberately NOT migrated: an ObjectId is threaded across the webhook request flow (~40 sites); needs a dedicated rework, not a repo swap.
- Repos round-trip unknown Mongo fields via `extra`/`payload` jsonb so flag-OFF/ON doc shapes stay identical.

**How to apply:** new operational-store consumers must go through the repos, not raw getDb; flips are operator-only (backfill classification: transient=pure flip, durable logs=scripts first — see runbook addendum).
