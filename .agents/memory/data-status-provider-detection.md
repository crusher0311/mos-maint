---
name: Data Status provider detection
description: Why shop provider detection must honor integrationProvider, not just nested *.configured/*.shopId flags.
---

# Shop provider detection: integrationProvider vs nested flags

A connected shop can store its live SMS integration under the top-level
`shop.integrationProvider` field (e.g. `"tekmetric"`) WITHOUT any nested
`tekmetric.configured` / `tekmetric.shopId` flag. The nested `tekmetric`
object may only hold runtime state (`connectedAt`, `lastSync`, cursors).

**The bug it caused:** the Data Status panel's `detectProvider` (in
`lib/data-status.ts`) checked only nested flags, so a real connected
Tekmetric shop (e.g. shop 1, "CAR Experts LLC") false-reported
`connected: false / provider: null`. Meanwhile the backfill trigger's
`detectBackfillProvider` (in `lib/backfill/trigger.ts`) DID match via
`integrationProvider`, so the "request a re-sync" POST succeeded for a shop
the panel showed as disconnected — an inconsistent split.

**Rule:** any shop provider detector must check `integrationProvider` FIRST,
then fall back to nested flags / legacy top-level fields
(`tekmetricShopId`, `protractorConnectionId`, `protractorApiKey`). Keep the
panel detector and the trigger detector in agreement, and remember Mongo
projections must actually INCLUDE `integrationProvider` (and the legacy
top-level fields) or the detector silently never sees them.

**Why:** these two detectors disagreeing makes "connection state" and
"what we'll actually re-sync" contradict each other in the UI.
