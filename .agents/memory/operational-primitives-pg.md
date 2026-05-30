---
name: Operational primitives PG migration
description: Cron lock + Tekmetric rate-limiter buckets are transient runtime state — their Mongo→PG cutover needs no backfill, just a flag flip.
---

# Operational primitives (cron lock, Tekmetric rate-limiter buckets) → Postgres

The cron distributed lock and the Tekmetric shared rate-limiter token buckets each
got a Postgres backend behind a default-off flag (`CRON_LOCK_PG_CANONICAL`,
`TEKMETRIC_SHARED_LIMITER_PG_CANONICAL`). Default stays Mongo; behavior unchanged.

**Why this matters / the durable distinction:** unlike the data-bearing Mongo stores
(caches/reference/tokens/billing — which need backfill + multi-day soak + reader
ports before a flip), these two hold **transient runtime state only**. Cron leases
self-heal via TTL takeover; rate buckets regenerate every second. So their cutover is
a **pure flag flip with NO backfill and only a short verification window** — do not
plan a backfill/soak for them like the other stores.

**How to apply:** when the downstream "Final MongoDB decommission" work reaches these,
just flip the flag in prod (operator-only), verify one schedule cycle / one busy
window, then leave on. The schema is `lib/db/schema/operational.ts` (tables
`cron_locks`, `tekmetric_rate_buckets`), migration `drizzle/0018_*` (schema-only,
operator applies). Full operator steps live in `docs/db-migration-map.md` §12.
