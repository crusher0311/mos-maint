# Protractor list-vs-detail probe — findings (2026-06-05)

**Task:** #583 — Probe Protractor list responses to confirm line items before rewrite.
**Goal:** Decide empirically (not by guessing) whether the Protractor *list*
endpoints already return the service-package line items our extractor needs, or
whether only the per-record *detail* endpoints carry them. The Protractor
backfill speed-up plan ("mirror AppFueled's bulk fetch") depends entirely on the
answer for **our** API credentials/tier.

This was investigation only. No backfill/extraction code was changed.

## How it was measured

Read-only probe: `scripts/probe-protractor-list-vs-detail.ts`.

- Reuses the existing client/auth (`resolveProtractorConfig` + `protractorFetch`)
  and therefore the shared Protractor rate limiter / circuit breaker. Only GETs;
  nothing is written back to Protractor.
- For one real configured shop (probed **shop 25**, "Southern Pines"), over a
  90-day window (`2026-03-07 .. 2026-06-05`) it:
  1. fetched a list page of `/Invoice/?startDate=…&endDate=…`,
  2. fetched `/Invoice/{id}` detail for the first 4 invoices and compared each,
  3. fetched a list page of `/WorkOrder/?…&readInProgress=True`,
  4. fetched `/WorkOrder/{id}` detail for the first 4 work orders and compared.
- For every record it counts: service packages, total line items, lines with
  pricing, deferred packages, and presence of `ServiceItem` (vehicle) / `Contact`
  / employees. "Parity" = list has **>=** the packages and lines of its detail.
- Raw (PII-redacted) payloads were dumped to `.local/protractor-probe/` for
  side-by-side inspection.

To reproduce:

```bash
npx tsx scripts/probe-protractor-list-vs-detail.ts --shop=25 --samples=4 --days=90
```

## Result — definitive

| Endpoint | List size (90d) | List carries line items? | Verdict |
|---|---|---|---|
| **`/Invoice/?…`** | 1446 | **YES — full parity with detail** | Per-invoice `/Invoice/{id}` N+1 is **AVOIDABLE** |
| **`/WorkOrder/?…&readInProgress=True`** | 283 | **NO — zero line items in list** | Per-WO `/WorkOrder/{id}` N+1 is **UNAVOIDABLE** |

Per-record comparison (4/4 sampled each):

```
-- INVOICE --   (list carries everything the detail does)
  03b28ca9…  listLines=3  detailLines=3   listPkgs=3 detailPkgs=3  deferred(list=F,detail=F)  parity=true
  36318c04…  listLines=12 detailLines=12  listPkgs=6 detailPkgs=6  deferred(list=F,detail=F)  parity=true
  f331413c…  listLines=8  detailLines=8   listPkgs=2 detailPkgs=2  deferred(list=T,detail=T)  parity=true
  13ed89d1…  listLines=3  detailLines=3   listPkgs=1 detailPkgs=1  deferred(list=F,detail=F)  parity=true

-- WORK ORDER -- (list is a thin summary; only detail has packages)
  1179f6ca…  listLines=0  detailLines=5   listPkgs=0 detailPkgs=4  deferred(list=F,detail=T)  parity=false
  127a8046…  listLines=0  detailLines=2   listPkgs=0 detailPkgs=2  deferred(list=F,detail=T)  parity=false
  6ae40dce…  listLines=0  detailLines=2   listPkgs=0 detailPkgs=2  deferred(list=F,detail=T)  parity=false
  6600c81a…  listLines=0  detailLines=4   listPkgs=0 detailPkgs=3  deferred(list=F,detail=F)  parity=false
```

### What this means field-by-field for our extractor

The invoice **list** response includes everything `extractJobIndexFromWorkOrder`
(`lib/job-index.ts`) consumes:

- `ServicePackages.ItemCollection[]` with `ServicePackageHeader.Title/Description`
  (or top-level `Title`).
- `ServicePackageLines.ItemCollection[]` with `Type` (Labor/Part), `Description`,
  `Quantity`, `PartNumber`, `Manufacturer`, and pricing.
- **Pricing note:** lines use **flat** fields (`Price`, `Total`, `ExtendedTotal`,
  `Cost`/`TotalCost`), *not* a nested `PriceSummary` object. Our extractor already
  reads both shapes (`priceSummary.SellPrice` **or** `line.Price`/`line.Total`),
  so flat-only lines are handled. (`linesWithPriceSummary=0`, `linesWithFlatPrice>0`
  for every record.)
- `DeferredServicePackages` are present in the list when the invoice has them
  (confirmed on invoice `f331413c…`).
- `ServiceItem` (vehicle) and `Contact` are present on list records, and odometer
  (`OutUsage`/`InUsage`/`Odometer`) is populated.

The **work-order** list response is a thin summary: `ServiceItem`, `Contact`,
employees and odometer are present, but `ServicePackages` is entirely absent —
the detail fetch is the only source of packages/lines for open/in-progress ROs.

## Recommendation for the rewrite (follow-up task)

The current backfill (`lib/integrations/protractor/sync.ts`) is **invoice-based**:
it pages `/Invoice/?…`, then for each invoice does a cache-first
`/Invoice/{id}` detail fetch (`fetchInvoiceById`) before extraction. That
per-invoice detail call is the N+1 that dominates runtime.

**Because the invoice list is already rich, drop the per-invoice detail fetch and
extract directly from the list page.** Concretely:

1. Page `/Invoice/?startDate=…&endDate=…` (it already paginates with `take`/`skip`).
2. Run `extractJobIndexFromWorkOrder(shopId, invoiceFromList, "protractor")`
   directly on each list item — no `/Invoice/{id}` call.
3. Keep the `protractor_invoice_cache` write if downstream consumers still read it,
   but it is no longer needed to *get* line items.
4. **Vehicle resolution:** the list's `ServiceItem` lacks VIN in some records, so
   keep the existing `fetchVehicleById(ServiceItemID)` path (deduped by
   `serviceItemId`, which the code already does) — that is a bounded number of
   calls, not one-per-invoice.

Expected effect: invoice backfill drops from ~1 list call + N detail calls per
chunk to ~1 list call per page (≈ N× fewer Protractor calls for the dominant path).

**Caveats / what to verify in the rewrite (cheap):**
- This was sampled on one shop (4 invoices). Before flipping the fleet, the
  rewrite should keep a lightweight guard: if a list invoice has
  `ServicePackages` empty but a nonzero `Total`, fall back to a single
  `/Invoice/{id}` detail for that record (detail-on-mismatch) rather than
  assuming. This keeps correctness if a different tier/shop ever returns thin
  list rows.
- Work orders are **not** part of the invoice backfill path, but if any flow ever
  backfills open ROs from `/WorkOrder/?…`, the per-WO detail fetch stays
  mandatory — the list has no packages.

## Artifacts

- Probe script: `scripts/probe-protractor-list-vs-detail.ts`
- Raw dumps (redacted): `.local/protractor-probe/shop25-*.json`
  (`*-invoice-list.json`, `*-invoice-detail-sample0.json`,
  `*-workorder-list.json`, `*-workorder-detail-sample0.json`,
  `*-comparison-report.json`).
