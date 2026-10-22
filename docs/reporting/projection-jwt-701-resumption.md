# JWT-701: bounded shadow population resumption

This is an operator runbook, **not authorization to run it**. The isolated fix
did not connect to production, populate reporting tables, change installed
triggers, deploy, change shared switches or enable customer reads. See
`projection-installation-2026-10-22.md` for the installation receipt and the
previous stopped attempt.

## What changed, and what did not

- Each feed transaction consumes at most 100 events / 1.5 seconds of loop time,
  with 100 ms server await and a 1-second driver operation timeout. PostgreSQL
  statements remain limited to 2 seconds and lock acquisition to 250 ms.
  These are operation/iteration limits, not a hard process termination deadline.
- Consumed tokens and invalidation commit atomically. The MongoDB 6.19 driver
  does not advance `resumeToken` on `tryNext()` events: the worker explicitly
  saves the last consumed event `_id`. Only an empty batch can use its
  post-batch token to certify catch-up. Every transaction reopens from the
  durable cursor, including after another process polled.
- `draining` is useful progress, **never freshness**. It sets watcher time to
  epoch. Inventory can start/continue while draining; verification/project work
  cannot start on that tick. No event filtering by selected shop is introduced.
- Event-time insert ownership, delete preimages, and unchanged-owner update
  preimages can narrow Mongo invalidation. Missing ownership/preimages, moves,
  replacements and ambiguous cases still invalidate the fleet. No preimage
  configuration change is needed or authorized; absence is conservative.
- Inventory preserves its exact source manifest across revision changes.
  Verification begins against the latest scope revision and compares every
  key/digest with that manifest. New/changed keys fail; deletions change the
  complete manifest digest and fail. Any later scope revision restarts
  verification and item processing, **not inventory**. Old item classifications
  are unpublished and are overwritten one at a time before publication.
- A temporary stream/timeout error withdraws watcher freshness but retains the
  durable token. Lost/invalid resume history or namespace destruction fails all
  active generations and clears the cursor in the same transaction as fleet
  invalidation. Reopening without a cursor establishes a new baseline only
  after invalidating old active generations; it does not claim the gap was read.
- Expiry, strict shop selection, document/identity/copy/byte/step limits,
  financial/owner reviews, and hold coverage are unchanged. No review is
  generated, widened or renewed by population.

**Important limit:** the installed PostgreSQL statement triggers remain
fleet-wide. Sustained PG writes (even at another shop), or Mongo events with
unknown ownership, can still delay a stable verification/publication window.
This patch permits bounded durable population under traffic; it does not
promise a fresh report under arbitrarily high write rates. Repeated verification
restarts are an explicit stop/escalation condition, not permission to ignore
revisions, rewrite freshness timestamps, disable triggers or enable reads.

## Preconditions for a separately approved operator session

1. Review and merge this code through the normal process. Confirm the approved
   runtime actually contains this implementation, not the previous single-event
   poller. Do not redeploy as part of this isolated task.
2. Reconfirm the production target and restricted reporting-builder role
   against the installed schema/roles. Do not rerun `production-schema.sql`,
   modify triggers, grant broader privileges or use the installer as builder.
3. Provide operational PostgreSQL read-only and Mongo read/change-stream
   connections through the approved secret mechanism. Do not log their values,
   raw payloads, resume tokens, invoice IDs or customer information.
4. Select **shop 227 only** for this approval. The feed is database-wide so it
   can account for all relevant events; that is not permission to build any
   other shop. Keep the shared builder and reader switches off. If explicitly
   approved, the operator process alone may set the builder switch; the reader
   switch remains off everywhere.
5. Agree on the session's wall-clock/work cap before starting. Suggested first
   checkpoint: at most four runtime ticks or 60 seconds, whichever comes first;
   stop admission of new ticks at the deadline and allow the in-flight bounded
   transaction to settle. Expansion of the session requires approval, not an
   unbounded retry loop. Always close the runtime and connections on exit.

## Resume and inspect, without resetting state

Use the existing approved operator harness with
`projectionRuntime(reporting, sourcePg, mongo).tick(227, signal)`.
Do not delete cursors or active builds and do not manufacture `observed_at`.
`start(227)` returns the existing active generation after a normal restart.
Keep checkpoints between sessions; rerunning a completed transaction after a
lost response is safe.

Record sanitized statuses and the following reporting-only state:

```sql
SELECT b.id, b.phase, b.channel, b.document_count, b.identity_count,
       b.revision, s.revision AS current_revision, b.created_at,
       b.verified_at, b.failure
FROM reporting_invoice.builds b
JOIN reporting_invoice.scopes s USING (shop_id)
WHERE b.shop_id = 227
ORDER BY b.created_at DESC
LIMIT 5;

SELECT name, resume_token IS NOT NULL AS has_resume_token, observed_at
FROM reporting_invoice.change_cursors WHERE name = 'mongo';
```

- `draining` / `awaiting_feed`: save the counters and stop at the agreed cap.
  A progressing inventory is successful bounded progress, not publication.
- `deferred`: retain the generation and resume later within approval.
- `busy`: another consumer holds the lock; do not add more consumers to force
  progress.
- `stream_unavailable`: stop and diagnose read access/connectivity/driver
  compatibility, keeping the cursor. Do not interpret this as empty inventory.
- `stream_gap`: old generations have been vetoed. Review the incident and
  authorize a new bounded baseline; never restore an old published pointer.
- `failed` with `source_changed` / `inventory_changed`: retain evidence of the
  veto. Do not clear the failure or reuse its manifest as reviewed evidence.
  A new generation is a separate bounded attempt.
- `verify` repeatedly returning to channel zero: record both revisions and
  stop/escalate. A separately approved narrower invalidation design may be
  needed; no PG trigger modification is included here.
- `complete`: verify the scope still matches the build revision, the watcher
  really caught up, and the five-minute verification window has not expired.
  Completion alone is not financial clearance or permission to activate reads.

## JWT-701 acceptance and stop boundary

Compare the complete declared shop inventory and its unresolved population,
not just the ten retained cohort identities. The earlier hypothetical cohort
totals (5.7 sold / 16.42 presented hours) are not production clearance, a
full-shop result, or the October 19–22 report.

Check that source refs/digests are retained, true changed/deleted evidence is
vetoed, and missing/expired ownership, accounting or hold review stays
unresolved. Reviewers must independently authorize any exact manifest-bound
reviews through the established process. Population cannot do so.

Stop after recording the bounded receipt. Customer report activation, a larger
shop allowlist, continued population, fresh review approvals and any trigger
changes each remain separate operator decisions.

## Offline evidence

`bash tests/run-reporting-projection-worker.sh` uses disposable PostgreSQL,
the installed migration verbatim, and a deterministic Mongo stream fixture
that reproduces the driver's stale event-token behavior. It covers sustained
traffic/admission, exact unrelated-shop Mongo events, conservative PG
invalidation, real source changes/deletes, expiry, cursor loss, transaction
rollback/replay, restarts and role isolation. Outbound networking is denied.

`bash tests/run-reporting-projection.sh` checks the retained cohort with both
hypothetical and absent clearance. `npm run typecheck` checks workspace types.
These are not live Mongo replica-set or production population acceptance.
