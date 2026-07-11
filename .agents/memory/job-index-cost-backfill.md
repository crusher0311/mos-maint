---
name: job_index part-cost backfill
description: How to patch cost onto historical Protractor job_index rows without churn; sweep script exists, live run operator-gated.
---

# Patching cost into historical Protractor job history

Rows indexed before real part-cost capture lack `cost`/`extendedCost` on lines and fall back to the ratio estimate. `scripts/backfill-protractor-part-costs.ts` re-runs the live extractor over `normalized_work_orders.rawPayload` (Protractor-only) and patches ONLY missing cost fields onto matching `job_index` lines; `--normalized` opt-in replays line items for the normalized/PG side.

**Why the design matters:**
- Any in-place patch of `job_index.lines` MUST recompute `contentHash` from the patched row (computeJobHash reads only workOrderId/servicePackageId/vehicle/job/lines/totals — all present on the stored doc), or the next backfill pass sees a spurious "changed" row and rewrites the fleet again.
- Match stored↔extracted lines by identity (lineType|description|partNumber|qty), NOT price — list-vs-detail float noise breaks price-keyed matches; consume duplicate keys in order so two identical parts each get their own cost.
- The lint:direct-db guard's import regex only matches `@/lib/mongo` / `../mongo`; one-off backfill scripts follow the established precedent of importing `../lib/mongo` (like backfill-protractor-history-dates.ts).

**How to apply:** dry-run default, `--confirm` to write, `--shop/--limit/--batch/--sleep`, resumable checkpoint with separate dry/live namespaces. Live run is operator-gated (dev Mongo IS prod) — run off-hours via a console workflow. Dry-run sample 2026-07-11: ~3 of every ~11 job rows per WO gain costs; ~980k WOs ≈ 10h paced.
