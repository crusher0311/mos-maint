---
name: Protractor list-vs-detail line items
description: Which Protractor list endpoints already carry service-package line items (so the per-record detail N+1 can be dropped).
---
Probed empirically 2026-06-05 on a real shop (shop 25), 90-day window, via
`scripts/probe-protractor-list-vs-detail.ts` (read-only, reuses client/auth + shared limiter).

- **`/Invoice/?startDate&endDate` list IS RICH**: every sampled invoice's list row already carries full `ServicePackages` + `ServicePackageLines` (Type/Description/Quantity/PartNumber/pricing) AND `DeferredServicePackages`, with parity (>=) to the `/Invoice/{id}` detail. So the invoice backfill's per-invoice `/Invoice/{id}` detail fetch is the avoidable N+1.
- **`/WorkOrder/?…&readInProgress=True` list IS THIN**: zero ServicePackages in the list; only `/WorkOrder/{id}` detail has packages/lines. Per-WO detail is unavoidable.
- **Pricing shape gotcha**: list lines use FLAT fields (`Price`,`Total`,`ExtendedTotal`,`Cost`/`TotalCost`), NOT nested `PriceSummary`. `extractJobIndexFromWorkOrder` already reads both shapes, so flat-only is fine.
- Vehicle VIN sometimes absent on list `ServiceItem` → keep deduped `fetchVehicleById(ServiceItemID)` (bounded, not per-invoice).

**Why:** Protractor backfill speed-up (mirror AppFueled bulk fetch) hinges on this; rewrite can extract straight from the invoice list and skip detail.
**How to apply:** When rewriting invoice backfill, drop `fetchInvoiceById` per invoice; keep a detail-on-mismatch fallback (list ServicePackages empty but Total>0) for safety across tiers/shops. Full finding: docs/protractor-list-vs-detail-probe-2026-06-05.md.

**IMPLEMENTED** (backfillShopChunk in lib/integrations/protractor/sync.ts): extracts job entries straight from each `/Invoice/` list row; per-invoice `fetchInvoiceById` is gone. Thin rows (no extractable lines but Total>0) take a single cache-first detail fallback. Invoice cache (`protractor_invoice_cache`) + prewarm now ONLY accelerate that rare fallback, not the main path. The old per-chunk "invoice cache hit/miss" metric was repurposed to list-extracted vs detail-fallback (still surfaced via the `jobsCache*` fields / "Jobs cache" column in admin sync-health).
**Decision — fallback cap is a LOUD stall:** detail fallbacks are capped (~max(25,10% of chunk)); exceeding it sets chunkHadError (holds cursor) + logs `[OPS-ALERT]`. Deliberate: a systematically-thin list = tier regression, and we must NOT advance the cursor over invoices indexed without line items. Prefer paging on-call over silently corrupting history. (This is an intentional exception to the usual "avoid silent stalls" rule — this stall is loud.)

**Normalized-store corollary (live-verified):** OPEN Protractor WOs in normalized PG (`status IN scheduled/draft/authorized/estimate/inspection_*`) carry NO grand_total and NO priced service jobs — pricing only lands once invoiced. Any open-estimate feature must read the `protractor_work_orders` Mongo cache (via its repository: `packageSummaries` per-package totals + `pricing.grandTotal`, dollars, kept fresh by sync/callbacks), not normalized PG.
