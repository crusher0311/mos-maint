---
name: Vehicle specs cache
description: How the Specs tab avoids re-hitting DataOne/CARFAX; keying and invalidation rules for vehicle_specs_cache.
---

The Specs tab payload is cached in PG table `vehicle_specs_cache` (drizzle/0022), NOT squish-keyed like `dataone_cache` — it's keyed `<VIN>|<normalized hint key>` because caller-provided SMS hints change the resolved result. A second row kind `hint|<VIN>` persists the resolved CARFAX-derived disambiguation hint (90d) so the ambiguous-VIN double-decode + CARFAX lookup run at most once per vehicle.

**Rules:**
- Never cache `ok:false` builds — a transient DataOne outage would otherwise poison the vehicle for 30 days.
- Cache lookups/stores must be soft-fail (route builds live if PG cache errors).
- Interactive DataOne routes should use `pingDataOne(budgetMs)` from `lib/integrations/dataone-local` and return a `{ warming: true, retryAfterMs }` 503 instead of blocking on the 6+s endpoint wake loop; the client auto-retries (bounded). The ping kicks the wake-up in the background.
- Rows expire logically on read; there is no sweep job yet (proposed follow-up).

**Why:** Specs are static per vehicle; every tab visit used to re-run heavy per-candidate spec queries and re-run everything after a CARFAX hint.
