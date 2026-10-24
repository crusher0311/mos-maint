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
