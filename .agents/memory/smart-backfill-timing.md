---
name: Smart per-shop backfill timing
description: How the activity-profile quiet-window gate is wired and gated; flip rules.
---

# Smart per-shop backfill timing (activity-log quiet windows)

Per-shop timezone + quiet window(s) + confidence are inferred from organic
webhook/callback activity and used to gate each shop's *historical backfill* to
its own local quiet window. Sits ON TOP of the global concurrency cap + worker
power schedule (it only ever *narrows* when a shop backfills, never widens).

**Three layers:**
- `lib/integrations/activity-profile/{profile,timezone}.ts` — pure logic (flag
  reader, burst filter, histogram, quiet-window derivation, confidence,
  tz-from-activity, gate decision). No DB. Covered by
  `tests/activity-profile.smoke.ts`.
- `lib/data/repositories/activity-profiles.ts` — the ONLY Mongo layer. Burst-
  filtered `$facet` aggregation per provider source, shop-key mapping, tz
  resolution (shop→address→activity→default), upsert into
  `shop_activity_profiles`. Also exports the scheduler hook
  `prepareQuietWindowGate` / `applyQuietWindowGate`.
- Cron `compute-activity-profiles` (daily) writes profiles;
  `/api/admin/activity-profiles` (CRON_SECRET) is the read-only operator readout.

**Gate wired into all 5 provider selection points:** tekmetric-backfill route,
shopware-backfill route, protractor `findAndResumeStaleBackfills`, shopmonkey
`runFullPageBackfillCycle` (pushes `skippedReason:"deferred_quiet_window"`), and
AutoFlow feeds its primary backfill provider's profile.

**Timezone write-back:** `computeAndStoreProfiles` also populates `shops.timezone`
(the field `getPaceConfig`/`getShopTimezone` already read) with the inferred zone,
but ONLY when the shop has no tz set AND the source is address/activity (never the
Central default, never overwrite an operator value). Marked `timezoneInferredBy`.
This is gated by the compute cron, so OFF mode writes nothing.

## Flag + flip rules (IMPORTANT)
- Env `SMART_BACKFILL_TIMING` = `off` (default) | `observe` | `enforce`.
- **OFF = byte-for-byte previous behavior**: `prepareQuietWindowGate` returns
  early with NO Mongo read, no logging; tekmetric path skips the filter
  entirely. The compute cron is also a pure no-op when off (unless `?force=1`).
- OBSERVE logs `[smart-timing][observe][provider] would-ALLOW/would-BLOCK ...`
  but never skips a shop.
- ENFORCE actually defers out-of-quiet-window shops (shopware pushes
  `status:"deferred_quiet_window"`).
- **Why operator-gated:** flipping to observe/enforce is a prod action (it reads
  prod Mongo and changes which shops backfill when). Same class as the DB-cutover
  flips — never flip it on from an isolated env. Populate profiles first
  (cron or `?force=1` in prod), eyeball the readout, then observe, then enforce.

**How to apply:** any change here must preserve the off-path no-op guarantee
(no DB read / no log when off). Confidence floor is
`SMART_BACKFILL_TIMING_MIN_CONFIDENCE` (default 0.5); below it the gate falls
back to the generic schedule (eligible=true, fallback=true) so a low-data shop
is never starved.
