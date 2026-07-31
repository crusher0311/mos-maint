---
name: Estimate Assist labor-hour sources
description: Where recommended labor hours come from and why shop history can't supply hours for Protractor shops
---

The Smart Job Builder's hours are NOT from a labor guide (no Mitchell/MOTOR feed exists). Precedence in `/api/estimate-assist/job-builder`: vehicle-scoped shop history (>=2 jobs, join to normalized_work_orders vehicle jsonb) → AI vehicle-specific estimate (gpt-4o-mini, clamped 0.5x KB min..1.5x KB max) → shop-wide history (>=3, avg>0.2h) → generic KB typical.

**Why:** the KB "typical" is a cross-vehicle generic (owner flagged 2.5h vs 3.2 Mitchell for a Traverse water pump).

**Key data fact:** Protractor-normalized `normalized_service_jobs` rows have NULL `labor_hours_billed`/`labor_hours_actual`, BUT the labor LINES in `normalized_line_items` DO carry hours (verified shop 66: 11/11 water-pump labor lines, avg 3.77h). getShopHistoricalAverage coalesces to a per-job SUM over labor lines so Protractor shops still get shop-history hours. Root fix (populate at ingestion) is a proposed task. The `avgHours > 0.2` guard stops a 0/NULL average beating the AI estimate.

**Drizzle gotcha:** interpolating a table column (e.g. `${normalizedServiceJobs.id}`) inside a `sql\`\`` SELECT expression renders it UNQUALIFIED (`"id"`), which breaks correlated subqueries — write the qualified name literally. The query helper's try/catch swallows such SQL errors as silent nulls.

**Enterprise scope:** the job-builder route resolves the shop's enterprise (Mongo `getEnterpriseByShopId`) and queries history across ALL locations' shopIds; single-shop is the fallback.

**How to apply:** don't "fix" a Protractor shop's missing shop-average hours by loosening the guard; the hours are absent at the source. The AI vehicle pass and description-fallback AI call are mutually exclusive (`shouldUseAiFallback`) to avoid double billing one build.
