# JWT overnight recovery: read-only reconciliation, October 7, 2026

The October 6 overnight run paused at 10:07 p.m. Central after a PostgreSQL
statement timeout. Its source page was archived before financial processing.
The historical error does not identify whether lookup or update timed out.
The next candidate's read-only lookup used the existing unique shop/work-order
index and took 96 ms during investigation; this does not establish the
historical cause or prove that a locking update will be equally fast.

## Verified production evidence

Command: `scripts/reconcile-jwt-overnight.ts --job=jwt-overnight-2026-10-06`.
PostgreSQL enforced read-only transactions. Mongo operations were reads only.

- 42 archived pages passed source-digest validation.
- Manifest hash matched the run.
- Recorded results contain no duplicate shop/date/work-order keys; counters
  exactly match recorded results.
- All 387 corrected records passed native/source/identity/date/labor checks.
  Canonical labor and the raw-data labor mirror both matched.
- All 150 already-matching records passed the same checks, including mirrors.
- The corrected invoices' final signed labor totals sum to $61,687.61.
  This is not an incremental recovered-revenue measure.
- All 581 held outcomes remain held and were not modified.
- Saved cursor 41, page 0 is shop 230, September 18, out of 444 resume windows.
- That source page contains 43 native candidates: 4 recorded outcomes,
  26 unrecorded candidates still requiring correction, and 13 unrecorded
  candidates whose current labor already matches.

Current matching data alone cannot prove whether an unrecorded invoice was
already correct before this run or was committed before outcome bookkeeping.
Do not attribute those 13 matches as new corrections, replay the 4 recorded
outcomes, or move past the 26 outstanding candidates.

## Retry behavior implemented, not activated

At most three transaction attempts, with 500 ms then 1,000 ms backoff.
Only statement-timeout and lock-timeout errors propagated unchanged after the
transaction wrapper completes rollback qualify. Ambiguous connection, commit,
or rollback failures pause; validation holds remain holds.

Retries recheck worker suspension, ownership, stop flags, grant identity,
canary generation, quiet windows and morning-stop headroom. Financial
verification runs again inside each new transaction. Provider pacing, request
allowance, statement/lock timeouts, and financial scope are unchanged.
Logs identify lookup/update/begin/commit stage, SQLSTATE, attempt, page and
source-array position without exposing financial payloads.

No production rows, job status, permit, schedule or worker state were changed.
No new run was started. The expired window remains expired. A future resume
requires an explicitly approved window, a new guarded child checkpoint using
this latest paused run, and preservation of the 65 admissions already consumed.
