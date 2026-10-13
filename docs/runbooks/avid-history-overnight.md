# Avid Auto Care: one-use history import

Operator authorized MOS 457, 24 months, October 13 close at 18:00 Eastern,
October 14 open at 07:00 Eastern. Training is October 14 at 08:00 Central.
This is not authority to change other shops, fleet quiet hours, or recurring jobs.

The fixed scope is October 14, 2024 through October 13, 2026 (730 daily windows).
Admission opens 22:00 UTC October 13 and expires 10:55 UTC October 14, five minutes
before opening. No new page starts in the final three minutes. At most 2,000
physical invoice-list GET attempts share the existing fleet limiter and relay.
The separate `avidHistory` grant never resets Afton, Burnett, or JWT budgets.
General workers remain suspended. No provider writes or detail fan-out.

Run the tested production artifact as a single Render one-off job:

```
NORMALIZED_INGEST_WRITE_CONCURRENCY=1 NODE_OPTIONS='--require ./scripts/_stubs/server-only-stub.cjs' node --import tsx scripts/run-avid-history.ts --schedule-approved
```

Before the night starts this persists a stopped grant and a scheduled job, then
waits. It verifies suspended workers, generation, operator stop, connection
binding and exclusive ownership before opening admission. Existing job/grant
records are never overwritten. Do not retry an ambiguous scheduling POST.

Source pages are archived before ingestion. Daily completion requires a short
terminal page and successful ingestion of every fetched page. Failed provider
reads defer that day for a later pass (three passes maximum). Each page runs
serial ingestion in a child, with a two-minute invoice watchdog and a 15-minute
page cap. A hung child cannot freeze the parent or other days.

An invoice receipt is marked `processing` before database writes. After timeout,
partial failure or lost acknowledgment that state is deliberately NOT replayed.
Other invoices continue on the next page pass; unresolved receipts keep the day
incomplete. This favors correct reporting and non-destructive recovery over a
false promise of finishing the entire import overnight.

Inspect `operator_history_import_jobs` for `avid-history-2026-10-13`. The status
`completed` requires all 730 windows; `needs-attention` is not completion.
Use source-page and invoice-receipt IDs for exact recovery. Do not reset the
budget, delete receipts, widen dates, or schedule a second overlapping runner.
Follow-up recovery requires proving the prior process and database operations
have stopped and reviewing any partially committed invoices.

This job's coverage ledger does not change the legacy fleet backfill cursor.
The scheduled Afton comparison remains independent on its original artifact.
