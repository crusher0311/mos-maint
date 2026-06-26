---
name: Protractor normalized dates are all null
description: Why the Data Status panel shows the MOS import date (not real history) for Protractor shops, and what a real fix requires.
---

# Protractor normalized work-order / service-job dates are 100% null

On the Settings → Integrations "Data Status" panel, Protractor shops show their
Customers / Vehicles / Work Orders "oldest record" as the MOS **import/sync date**
(e.g. a recent Jan/Mar date), not true history. Service Jobs likewise show their
own import floor. Confirmed in DATAONE PG for a real shop: of ~19k work orders,
**0** had `closed_date`, `completed_date`, or `check_in_date`; of ~106k service
jobs, **0** had `completed_at`. Every date column is empty, so the panel's
`coalesce(closed_date, completed_date, created_at)` (and the customers/vehicles
mirror of the WO span) falls back to `created_at` = the import timestamp.

**Root cause (TWO independent bugs, both confirmed against real cached invoices):**
1. Field-mapping miss in the Protractor normalized adapter. The real `/Invoice/`
   payload has NO top-level `InvoiceDate`/`ClosedDate`/`DateIn`/`CreatedDate`.
   The actual dates are top-level `InvoiceTime` (invoice/close ts) and nested
   `Header.CreationTime`/`Header.LastModifiedTime`; service packages carry their
   own `Header.CreationTime`/`LastModifiedTime`. The adapter was reading only the
   absent legacy names, and `mapServiceJob` never set `completedAt` at all. Also
   note `WorkflowStage` on invoices is the singular `"Invoice"` (NOT `"Invoiced"`)
   so it isn't in the stageMap and `mapProtractorStatus` returns the `'closed'`
   default — so the status guard was actually fine; the date *source* was the bug.
2. **The shared PG dual writer (`lib/supabase-dual-writer.ts` `upsertServiceJob`)
   silently dropped `completedAt` — it was never in the row object.** So even a
   correct adapter value would never reach `normalized_service_jobs.completed_at`.
   (The work-order writer DOES map closed/completed/checkIn, which is why
   Tekmetric work-order dates worked.) Adding `completedAt` to the writer is
   null-safe for other providers (their `mapServiceJob` doesn't set it).

**Why:** this is a DIFFERENT root cause than the Tekmetric "misleading oldest
date" fix. Tekmetric has real WO dates and we only had to mirror the WO history
span onto customers/vehicles (panel-side, cheap). Protractor never captured the
dates in the first place, so there is nothing good to mirror — the WO span is
itself the import date.

**Status: code fix DONE (task #640).** `mapWorkOrder` now resolves dates from
`InvoiceTime`/`Header.*` (legacy names kept as fallback) and sets closed/completed
for terminal statuses (closed|invoiced|paid); `extractRawServiceJobsFromWorkOrder`
stamps the parent invoice date onto each raw package as `_parentClosedAt`;
`mapServiceJob` sets `completedAt` from the package `Header.*` → `_parentClosedAt`;
and `upsertServiceJob` now writes `completedAt`. Validated via read-only dry run on
real cached invoices (real 2022–2026 dates out). Adding these fields changes the
content hash, so the next normal backfill sweep will update each Protractor RO once
(bounded one-time re-index churn) — that is the going-forward fill mechanism.

**Still PENDING (operator-gated):** existing rows stay null until a fleet-wide
re-normalize re-processes already-imported Protractor records. Don't run it from an
isolated/dev env — dev Mongo IS prod Mongo and an aggressive re-normalize saturates
shared Mongo. The panel won't change for historical shops until that runs.
