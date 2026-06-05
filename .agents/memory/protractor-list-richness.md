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
