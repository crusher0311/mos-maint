---
name: Estimate Assist labor-hour sources
description: Where recommended labor hours come from and why shop history can't supply hours for Protractor shops
---

The Smart Job Builder's hours are NOT from a labor guide (no Mitchell/MOTOR feed exists). Precedence in `/api/estimate-assist/job-builder`: vehicle-scoped shop history (>=2 jobs, join to normalized_work_orders vehicle jsonb) → AI vehicle-specific estimate (gpt-4o-mini, clamped 0.5x KB min..1.5x KB max) → shop-wide history (>=3, avg>0.2h) → generic KB typical.

**Why:** the KB "typical" is a cross-vehicle generic (owner flagged 2.5h vs 3.2 Mitchell for a Traverse water pump).

**Key data fact:** Protractor-normalized `normalized_service_jobs` rows have NULL `labor_hours_billed`/`labor_hours_actual` (verified shop 66: 11 completed water-pump jobs, all NULL hours), so shop-history hours never win for Protractor shops — the AI vehicle pass is their effective source. The `avgHours > 0.2` guard exists specifically so a 0/NULL average can't beat the AI estimate.

**Enterprise scope:** the job-builder route resolves the shop's enterprise (Mongo `getEnterpriseByShopId`) and queries history across ALL locations' shopIds; single-shop is the fallback.

**How to apply:** don't "fix" a Protractor shop's missing shop-average hours by loosening the guard; the hours are absent at the source. The AI vehicle pass and description-fallback AI call are mutually exclusive (`shouldUseAiFallback`) to avoid double billing one build.
