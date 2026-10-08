# JWT timeout investigation and continuation preparation

## Observed failure

The production job stopped at 2026-10-08 05:08:50 UTC (00:08 Central).
Structured logs show shop 233, August 25, page 0, invoice position 7:
three UPDATE-stage SQLSTATE 57014 statement timeouts. The transaction helper
retried three times, then propagated the timeout to the global stop boundary.
The logs do not establish the underlying cause of the slow database update.
Read-only catalog inspection found the ID primary-key index and no user
triggers on normalized_work_orders; this is not evidence of an API rate limit.

## Reconciliation

Read-only source/native/PG verification passed for 5,908 corrected and 1,528
already-matching results. No duplicate outcomes or raw-mirror discrepancies.
There are 1,929 preserved holds and 355 archived pages.

354 of 403 windows completed. Remaining: 7 windows for shop 233 and 42 for
shop 235. The actual active partial page is shop 233 / August 25, not the
earliest-incomplete cursor. Its 7 recorded outcomes remain protected; the
unrecorded remainder contains 22 correction candidates, 4 matching records,
and 6 hold candidates.

Consumed budget: 419 of 1,000. No new permit has been activated, and no
production data was modified in this investigation.

## Changes prepared

- Classify only confirmed rolled-back statement/lock timeouts as deferrable.
- Keep the failed page pending, process other invoices and eligible windows.
- Preserve immutable archived source and recorded results across retries.
- Delay retries, allow at most four page passes, and expose exhausted work as
  needs-attention rather than reporting successful completion.
- Cool down after three consecutive timed-out invoice transactions.
- Continue failing closed for ambiguous commits, connection/rollback errors,
  expired authority and explicit safety stops.
- Reconcile the active page correctly after out-of-order scheduling.
- Provide read-only continuation inventory and an explicit operator-approved
  later-window handoff without resetting consumed requests.

The helper is reusable, but authorization remains JWT-scoped. Other Protractor
shops require their own verified source/manifest and authorization; this change
does not authorize an automatic fleet-wide financial correction.

Deployment and a new execution window still require activation. Do not claim
the overnight job has restarted based on passing tests or preparing this file.

Validation passed: TypeScript typecheck, the existing overnight suite, pure
deferral/checkpoint tests, and a VM execution of the actual invoice loop with
synthetic stores. The real-loop test verifies a repeatedly timed-out invoice
remains pending while a later invoice succeeds, and an ambiguous connection
failure still stops without acknowledging any invoice.
