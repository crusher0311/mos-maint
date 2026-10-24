---
name: Shopmonkey service-job history ingestion
description: Operational traps when turning Shopmonkey orders into service history (line-item fetch limits, VIN-less units, terminal gating, repair-run forceUpdate)
---

- Shopmonkey v3 never embeds line items on an order; `/service_item` is the only source and it only filters by customer/vehicle. **Fetch once per customer group, never per order** — per-order fan-out saturates the shared rate limiter (slot timeouts silently drop lines) and Cloudflare 429s make a mid-size shop take hours.
  **Why:** limiter budget is ~1-2 RPS for background work with a 5s slot timeout; a swallowed timeout looks like "order has no lines".
  **How to apply:** any new Shopmonkey read path that needs lines for >1 order must go through the shared batched attach, and degraded attachment must be logged/surfaced, never an invisible `[]`.
- A missing VIN must never block Shopmonkey normalization — marine/fleet units legitimately have none (this stalled an entire shop at 0 normalized WOs for months). History rows just carry no VIN.
- Only terminal (invoiced/completed/posted/archived) Shopmonkey orders may become job_index history; `invoicedDate` is Shopmonkey's "closed". Estimates as anchors would poison last-performed.
- Re-normalize/repair runs over already-ingested work orders need `forceUpdate` — unchanged content hashes short-circuit before the job_index dual-write, so history stays at 0 no matter how often you rerun.
- When lines truly can't be fetched, closed orders with order-level money still deserve one synthetic history job (better a dated, line-less anchor than CARFAX fallback).
- Rate-limited fleet rebuilds of a few-thousand-order shop take hours even batched; always run them via a console workflow, and memoize vehicle/customer fetches per run (orders share them ~10:1).

## Related read-path constraints

- [API quirks and authentication](shopmonkey-api-quirks.md)
- [User-approved extension placement](shopmonkey-extension-placement.md)
- [Dashboard/backfill wiring](shopmonkey-dashboard-source.md)
- [Historical-mileage rollout gate](shopmonkey-dashboard-mileage-gate.md)

Shopmonkey reader additions must bound scans to a shop with an explicit index hint and a short query budget; a missing supporting index must fail rather than silently scan the shared collection.

**Why:** prior VIN lookups saturated shared Mongo. Old normalized history may lack the legacy search-keyword shape, so compatibility reads need explicit limits, not an unbounded fleet-wide title scan.

**How to apply:** retain the independent per-shop candidate caps and round-robin merge; verify live index availability before rollout, without creating indexes from an isolated fork.

Use source service chronology, never ingestion timestamps, to choose an RO or assess odometer freshness.

**Why:** a backfill may import old repairs after recent visits; using import recency can regress mileage and label an old reading as current.

**How to apply:** prefer active visits when appropriate, otherwise compare service dates. Refuse an incomplete candidate set instead of selecting by ingest order.
