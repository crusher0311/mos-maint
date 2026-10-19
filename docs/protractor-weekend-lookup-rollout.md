# Weekend history lookup and scheduler fix — LOCAL ONLY

## What was verified

Production diagnosis found successful provider GETs followed by PostgreSQL
`57014` timeouts in the duplicate check. Its plan scanned the tenant's rows
and expanded their source-ID arrays. Fixed-order retries and a failure streak
that survived cooldown repeatedly delayed later shops.

The replacement query looks up case-insensitive Protractor IDs using a GIN
expression index. It retains every source-ID type and shop isolation. Only
indexed candidates are materialized: adding an index alone did not prevent
LIMIT 1 from choosing a scan in the first local test.

The runner now records the next shop before attempting work, resumes after
that shop on restart/cooldown, resets the failure streak after a fleet pause,
and closes its request grant before sleeping. The three-failure fleet cooldown
and each shop's retry delay remain. Existing page checkpoints, held-day
accounting, ambiguous receipts, callback priority, budgets, pacing, workers'
suspension requirement and hard campaign deadline are unchanged.

## Tests

- `bash tests/run-protractor-history-duplicate-query.sh`: disposable, marked
  loopback PostgreSQL only. Executes the actual migration and query against
  120,000 background records plus correctness fixtures. Both hits and misses
  use the index without forcing planner settings. Approximately 1.4 ms in the
  initial local run; this is not a production latency guarantee.
- `node --import tsx tests/protractor-weekend-scheduling.smoke.ts`: actual runner
  loaded with fake stores, clock and provider. Tests starvation prevention,
  cooldown reset, grant closure, saved rotation, held-day accounting and
  refusal to claim the campaign before index readiness.
- Existing ingestion and campaign-policy tests retain coverage for ambiguous
  outcomes, existing invoices, scope, callback activity, budgets and expiry.

## Production prerequisites — require separate approval

1. Inspect production sourceIds shapes and index state. A non-array JSON value
   is rejected rather than silently converted into “invoice absent.” Do not
   proceed with an index build if malformed stored provenance needs review.
2. Apply only `drizzle/0040_protractor_history_identity.sql`, one statement at
   each explicit statement boundary, outside a transaction. The function is
   followed by `CREATE INDEX CONCURRENTLY`. This does not repair invoice data.
   Do not run the entire migration collection against production for this fix.
3. Verify the index is valid, ready, non-partial and has the exact expression.
   `IF NOT EXISTS` does not repair an invalid concurrent build. Startup fails
   closed for missing, invalid, partial or wrongly defined indexes.
4. Measure an approved bounded hit and miss using the actual query and current
   production plan. Do not raise timeouts or disable duplicate protection.
5. Release the tested runner separately. Drain the old owner; do not clear its
   lease or launch overlapping runners. Resume the same campaign, request
   counter, captured pages and receipts only while its original window remains
   valid. The new code does not extend an expired window.
6. Verify actual page/receipt progress and shop rotation, not merely heartbeats.

No production migration, runner restart, deployment or provider request was
performed while building these fixes. Previously held work and existing records
needing indexing review remain separate recovery work; they are not replayed
automatically by this change.
