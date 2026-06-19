---
name: Protractor canned-job line pricing fields
description: Where canned-job/service-package-template line items hide their pricing, and which normalizers feed the dashboard push.
---

Canned-job / service-package-template line items do NOT reliably put pricing on
the flat `Price`/`UnitPrice` field. They often carry it under nested
`PriceSummary.SellPrice` (unit) / `SellTotal`/`SellSubtotal` (extended), and
labor lines use a `Rate` field + a separate `EstimatedHours`/`Hours` quantity.
Reading only `Price`/`UnitPrice` zeroed every line → $0.00 package subtotals on
pushed work orders (V&F BG canned jobs).

**Why:** title/description read from different fields so only pricing was blank,
which masked the field-mapping mismatch.

**How to apply:** `lib/job-index.ts` (invoice extractor) is the source of truth
for Protractor line field names — mirror its field set. The shared helper
`normalizeProtractorPackageLine` (exported from `lib/integrations/protractor`)
now encapsulates this and is idempotent (safe on already-normalized lines).
The dashboard New Work Order push uses it at two points: the read step
(`app/api/dashboard/protractor/canned-jobs/route.ts` normalizeLines) and the
push step (`normalizeOneLine` inside `createProtractorWorkOrder`). If lines come
through with prices but still push as $0, check BOTH spots.

The plan-page "Canned" button is a DIFFERENT path
(`applyCannedJobToWorkOrder`) — it adds lines by reference via TimeClock /
template ID (Protractor supplies pricing), with a WorkOrder-POST fallback that
hardcodes a single $0.00 labor line. Don't confuse the two.
