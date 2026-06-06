---
name: Extension button gating (AutoFlow DVI)
description: Why Detect Dog buttons appear/disappear on AutoFlow pages — feature entitlements + page-view gates, not bugs.
---

# Why extension buttons show or don't show on AutoFlow

When a shop reports "I see the print button but not Pre-fill DVI / Enhance Notes" or
"the floating icon isn't showing," check gating BEFORE assuming a bug. Two independent gates:

## 1. Per-shop feature entitlements
The extension calls `GET_SHOP_FEATURES` → `/api/extension/features` → `getFeatureEntitlements(mosShopId)`
(`lib/featureResolver.ts`). Effective features = plan features ∪ per-shop `enabledFeatures` override.
The AutoFlow VHI buttons gate on those booleans:
- `dvi_prefill`  → "Pre-fill DVI" + "Add VHI recommendations to RO" (concerns)
- `enhance_notes`→ "Enhance technician notes"
- `oil_sticker`  → the print/sticker button

So a shop can legitimately see the **print** button but NOT the VHI buttons if its plan/overrides
grant `oil_sticker` but not `dvi_prefill`/`enhance_notes`. Example confirmed: shop 29 Harrell's
(plan `appfueled_invoice`) → `oil_sticker:true`, `dvi_prefill:false`, `enhance_notes:false`. The
`plus` plan includes dvi_prefill+enhance_notes; `appfueled_invoice` does not.

**Fix to surface those buttons = turn the features ON for the shop (plan upgrade or per-shop
`enabledFeatures` override), NOT a code change.**

## 2. Page-view gates (`autoflow-content.js`)
- Floating "Create RO" bubble is gated on `isAutoflowDashboardView()`, which returns **false** on
  ticket/invoice/inspection/**DVI** pages. So the floating button is hidden on a DVI page **by design** —
  the inspection already belongs to an RO. Only appears on dashboard/workflow/board/ticket-list views.
- VHI buttons additionally require `isAutoflowDviView()` true, a detected `ctx.roId`, AND an anchor
  near the DVI action bar (looks for "Push DVI"/"PDF"/"Report Complete"/etc.); if no anchor yet it
  returns and retries next tick. So even with features ON, a missing/renamed action bar blocks them.

**Why:** features are entitlement-gated and several buttons are view-gated, so "missing button" is
usually correct behavior, not breakage. Verify entitlements (`getFeatureEntitlements(shopId)`) and the
page type first.
