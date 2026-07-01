---
name: CARFAX inspect-vs-replace anchoring
description: Why an inspected CARFAX/history line must not reset a replacement interval clock, and the three duplicate code paths that must all verb-guard.
---

# CARFAX "checked ≠ replaced" anchoring

A CARFAX record description is a MULTI-PHRASE blob: `lib/integrations/carfax.ts`
joins several bullet lines into one string with `"; "`, and CARFAX phrases the
verb AFTER the noun ("Drive belts checked", "Alignment checked"). So anchoring
must **split into phrases and verb-guard each one** — never run a whole-blob
match and treat any noun hit as "last done".

**Rule:** an inspect-only phrase (check/inspect/test/examine/verify/monitor/
measure with NO performed verb) must NOT anchor a replacement service key.
Performed verbs (replace/change/flush/rotate/balance/service/perform/aligned/…)
DO anchor. A record mixing "Oil and filter changed; Drive belts checked" anchors
oil but not the belt. Operator/admin overrides are intentional and stay
verb-free.

**Exception:** `INSPECTION_SERVICE_KEYS` (currently just `emissions`) — for those
the inspection IS the scheduled service, so an inspect verb DOES anchor.

**Why:** "Drive belts checked" was resetting the serpentine_belt replace clock,
making a due belt look done. Reported on the AppFueled partner Vehicle Health
panel but present on every anchoring surface.

## How to apply — THREE duplicate anchoring implementations
The same "free-text history → last-done key" logic is copied in three places;
fixing one is not enough. Canonical primitives live in `lib/service-keys.ts`
(`splitServicePhrases`, `isInspectOnlyHistoryPhrase`, `INSPECTION_SERVICE_KEYS`,
`toAnchorKeysFromHistory`).
1. **Shared triage** `lib/plan-build/triage.ts` — used by `/api/plan-build`
   (which the partner VHI route rebuilds through). Uses `toAnchorKeysFromHistory`.
2. **Extension overlay** `app/api/extension/plan/route.ts` `getLastPerformedInfo`
   — does NOT call triage(); its own regex `SERVICE_KEY_PATTERNS` mapping. Guard
   both the shop-WO job loop and the CARFAX loop.
3. **Dashboard plan page** `app/dashboard/vehicles/[vin]/plan/page.tsx` — does NOT
   call triage(); has its OWN local `toKeyFromFreeText`/`SERVICE_KEYS`. Uses a
   local `toAnchorKeysLocal` wrapper (shared primitives + local dictionary) on
   its 3 anchoring loops. `page-fixed.tsx` in the same dir is DEAD/unused.

Guarding at the shop-history path too is correct (an inspection line item like
"Serpentine belt inspection" shouldn't anchor either), and does not break dedup
because inspect-only records were never legitimate anchors.
