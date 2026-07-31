---
name: Per-shop feature override stores
description: shops.enabledFeatures is the ONLY resolver-backed feature override store; legacy shop_features collection is metadata-only.
---

The rule: all per-shop feature on/off state lives in `shops.enabledFeatures` (object of FeatureKey→bool overrides) read by `getFeatureEntitlements` and written via `updateShopFeatures` (PG-canonical aware). The standalone Mongo `shop_features` collection is legacy and now only holds featureSettings/subscriptions metadata — never gate a feature on it.

**Why:** the old `/admin/features` page and `lib/features.ts` helpers read/wrote `shop_features`, which the entitlement resolver never consulted, so those toggles silently did nothing (and parts-route `part_xref` gates disagreed with everything else). Unified July 2026: `lib/features.ts` enable/disable/set/isFeatureEnabled now delegate to the resolver store; the legacy admin routes report resolver-effective state (shop override ?? enterprise ?? plan ?? false; founder = wildcard).

**How to apply:**
- New feature gates: use `getFeatureEntitlements(...).effectiveFeatures` (or lib/features helpers), never `shop_features` reads.
- Very old shops may store `enabledFeatures` as a `string[]`; always go through `normalizeShopFeatureOverrides` before merging/spreading (an array spread corrupts to numeric keys).
- Legacy `shop_features` data was verified inert (only 2 docs, labor_rates-only) — no migration needed or performed.
- `setShopFeatures(array)` writes explicit true/false for EVERY legacy feature id, pinning the shop above/below plan defaults — that's the intended "set exactly these" semantics of the legacy page.
