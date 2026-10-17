# October 17–19 history catch-up

Operator-approved, history-only campaign. Hard provider-admission cutoff:
2026-10-19 10:00 UTC (05:00 America/Chicago). No upstream writes, financial
corrections, broad background-worker restart, or callback-width changes.

## Entry points

Run only as a Render job with the production application's configuration and
NORMALIZED_INGEST_WRITE_CONCURRENCY=1. The entry point rejects Replit/dev runtime.

- `node --require ./scripts/_stubs/server-only-stub.cjs --import tsx scripts/protractor-weekend/main.ts --inventory`
- Same command with `--prepare-approved`: persist an immutable fleet manifest.
- Same command with `--run-approved`: claim the campaign and process it.

Never reset/recreate existing permission or progress records to retry a job.
One fleet runner owns a renewable four-minute lease. Child ingestion is bounded
to three minutes; each invoice has a two-minute watchdog. A replacement waits
for lease expiry. Physical requests additionally require fresh activity evidence,
the fixed campaign deadline, matching shop/connection and canary generation,
and an atomic shared request budget. Workspace monitoring is not the cutoff.

## Eligibility and capacity

Three recent WorkOrder/ServiceItem callbacks on at least two UTC dates within
seven days establish connection evidence, not proof of closure. Any callback
in the last hour defers that shop. Evidence can expire; unknown connections
remain blocked. Read failures or a capped activity query never mean quiet.
Activity is rechecked before each page and invoice.

One provider page at a time, no automatic provider retries, at least 20 seconds
between request starts, maximum 10,000 physical admissions across the campaign.
Existing relay serialization, transport pacing, and operator stop remain.
25 callbacks older than five minutes in the recent two-hour window pause work.
Three consecutive page errors impose a 15-minute pause.

## Coverage and reporting

The default horizon is 24 months; Burnett is 14 months. Complete legacy walks
only establish coverage before their last run, not current freshness. Incomplete
walks retain their covered range and edge overlaps. Burnett's completed separate
import and Avid's completed-day ledger are honored.

New page snapshots and receipts use the campaign prefix in the existing
operator_history_import_* collections. Existing normalized invoices are not
overwritten; missing search history is held for review. Ambiguous ingestion,
thin invoices, repeated failures, and pagination caps remain unresolved.
Completion means all planned pages checked with no unresolved receipts, not
merely that a process exited. Existing legacy completion flags are not changed.

Monitor Render job status plus the campaign and per-shop job documents.
Stop by setting campaign `stopped:true` and `weekendHistory.stopped:true`;
normal grants must not be altered. A lost process cannot renew its lease and
the deadline is checked again at the physical transport admission boundary.
