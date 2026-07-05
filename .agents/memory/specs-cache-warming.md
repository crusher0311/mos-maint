---
name: Specs/plan cache warming
description: Which cache layer is worth warming ahead of page loads, and why plan-warming is a trap.
---

# Warming maintenance-plan page performance

**Rule:** To make plan / vehicle-health pages load fast on a cold cache, warm the
**DataOne OEM schedule cache** (`dataone_cache`, 7-day TTL, keyed by VIN *squish*)
— NOT the computed-plan cache (`cached_plans`).

**Why:**
- `cached_plans` has only a **4-hour TTL** (`CACHE_TTL_MS` in `lib/plan-cache.ts`)
  and is keyed by {vin, shopId} + mileage tolerance. A nightly warm is stale by
  mid-morning, so warming it is near-pointless for a daily job.
- `dataone_cache` is the expensive, durable layer the on-demand plan build blocks
  on. It's keyed by squish, so many VINs share one entry → warming dedups hard.
- It reads from our own DataOne DB (local PG first, external API fallback) — free.
  Warming must NOT call CARFAX (`fetchCarfaxWithCache`) — CARFAX costs money per
  lookup. Keep warmers to `getMaintenanceScheduleCached(vin)` only.

**How to apply:**
- The warmer lives at `app/api/cron/specs-warm/route.ts`, registered in
  `lib/cron/jobs.cjs` (daily 04:20 UTC), gated behind `SPECS_WARM_ENABLED=true`
  (default OFF). Scope = recently-viewed VINs (`viewed_vins.lastViewedAt`).
- Idempotent: skip squishes already fresh in `dataone_cache`. Bounded: small
  concurrency + per-run cap + internal wall-clock deadline < scheduler timeout,
  so it can't overrun or hammer shared DataOne.
- `getMaintenanceScheduleCached(vin)` takes a **full VIN** and squishes internally
  — never pre-squish the arg (the plan-prefetch batch route passes a squish, which
  is a latent double-squish bug; don't copy it).
- Recency source is the Mongo `viewed_vins` mirror while PG is canonical (Wave 1);
  acceptable because `getMaintenanceScheduleCached` checks PG-canonical cache
  first anyway — mirror lag only reduces warm coverage, never correctness.
