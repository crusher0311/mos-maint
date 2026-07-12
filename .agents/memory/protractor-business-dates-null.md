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

**Backfill EXECUTED (2026-07-12, Brandon-approved):** fleet-wide repair is DONE.
Fast path used: `scripts/backfill-protractor-dates-fast.ts` — Mongo scan with a
tiny date-only projection → batched PG UPDATE keyed by (shop_id,
work_order_number), terminal statuses only, only ever filling NULL/<1990
columns (never overwrites a real date). 332,383 WO rows + ~1.35M service-job
completed_at fixed. Remaining 55 rows carrying the .NET `0001-01-01` sentinel
with NO real date in the raw payload were NULLed (`scripts/cleanup-garbage-dates.ts`)
so readers coalesce cleanly. Verified via `scripts/probe-protractor-dates.ts`
(oldest_real now 2018–2024 vs 2026 ingest floors; zero <1990 left).
Lessons that made it fast/safe:
- Full re-normalize replay (0.3 WO/s) = weeks; date-only SQL patch = ~1,700/s.
- The DATAONE PG enforces a DB-side **statement timeout** (~2 min): fleet-wide
  LIMIT-chunked UPDATEs that re-scan a big join die with 57014. Go per-shop
  chunked; for un-indexed scans, use a dedicated postgres client with
  `connection: { statement_timeout: "600000" }` (session-level override works).
- Phase 2 (sj completed_at from parent closed_date) has no per-shop checkpoint:
  a resumed run is silent while re-verifying done shops (only >0 fills log) —
  confirm liveness via pg_stat_activity, don't assume a hang.
- Scope one-off repair SQL by `provenance->>'sourceSystem'` even when the shop
  list is provider-filtered — mixed-source shops exist.

**Original pending note (superseded):** existing rows stay null until a
fleet-wide re-normalize re-processes already-imported Protractor records. Tooling
exists — `scripts/backfill-protractor-history-dates.ts` (npm
`backfill:protractor-history-dates`): Protractor-only, paced, resumable, and
DRY-RUN by default (only writes with `--confirm`). It re-ingests each WO off the
stored raw payload (fills WO closed/completed/checkIn) and replays its service
jobs (fills service-job completedAt). ~624k protractor WOs fleet-wide (2026-06).
**Do NOT run `--confirm` from an isolated/dev env** — dev Mongo IS prod Mongo and
an aggressive re-normalize saturates shared Mongo (fleet-wide login/cron outage);
the operator runs it OFF-HOURS. The panel won't change for historical shops until
then. **Why dry-run must stay namespaced from live in any such re-process script:**
a dry-run-by-default tool that advances one shared checkpoint will make the later
`--confirm` run resume *past* preview-visited rows and silently skip their writes.
