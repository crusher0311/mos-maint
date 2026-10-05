# AutoFlow dashboard notification recovery

AutoFlow webhook processing and workflow save/reset reserve a Mongo notification
intent **before** changing event/settings data. Reservation failure fails the
request before its business write. Once reserved, marker or finalization failures
do not fail an otherwise successful request. Existing business-write errors still
surface.

This is deliberately write-ahead rather than a transaction spanning PostgreSQL,
MongoDB, and DVI provider calls. A retry delivers only a shop-scoped dashboard
change marker. It never reinserts the event, updates customers, fetches DVI, or
reapplies workflow settings.

## Normal and recovery paths

- Normal completion marks the intent ready, tries the dashboard marker immediately,
  and removes the intent after success.
- The authenticated `autoflow-dashboard-notifications` scheduler job runs every
  minute. It claims durable work atomically; process restarts require no local
  timers or browser retry loop.
- A reservation left prepared by a crash or a failed finalization becomes due
  after one minute. It emits conservative invalidations but stays pending:
  an early recovery must not consume the notification while business work is
  still finishing. Finalization resets prepared attempts **once**.
- An uncertain marker acknowledgement may cause a duplicate refresh, not duplicate
  event processing. A reservation whose business write never ran can also cause
  harmless refreshes. These are intentional at-least-once invalidations.
- Shop IDs are validated and each notification updates only that shop's token.
  The shared global marker is not bumped.

## Bounds and failure visibility

- At most 25 intents per tick, with a 20-second drain budget and per-operation
  two-second server/client Mongo timeouts. Claims have a 30-second fenced lease.
- At most eight attempts per prepared/ready phase, including crashed claims.
  Backoff starts at one minute and caps at one hour. Intents expire after 24 hours
  from reservation, even when the ready phase starts later.
- Exhausted/expired intents become terminal and log
  `[autoflow-dashboard-outbox] delivery exhausted` with operation ID, shop ID,
  and source only. `finish deferred` means the durable intent remains available.
  No webhook data, tokens, or raw database error text are stored in the outbox.
- Terminal rows have seven-day retention via a TTL index. Successful ready
  intents are removed. Index setup is cached per database and retried on failure.
- Retry endpoint failures return 503 to the existing scheduler. Missing or
  incorrect cron authorization returns 401 and does not touch the database.

Recovery is automatic **within these bounds**, not a promise to retry forever
through an indefinite outage. After exhaustion, inspect the database/scheduler
failure first. Do not replay a webhook just to refresh a dashboard. A user page
reload reads current durable data; a later workflow save/reset or new event
creates a fresh notification intent.

## Verification and rollout

Run `npm run test:autoflow-visibility` and `npm run typecheck`. The suite includes
failure injection across webhook and both identity-store save/reset paths, actual
marker/token behavior, cron auth, leases, exhaustion, and bounded draining. The
admin UI has a separate fixture-only browser test documented in
`tests/browser/README-autoflow.md`.

No live backfill, historical webhook replay, environment change, or SQL migration
is needed. This change starts protecting new operations when deployed; it does
not reconstruct notifications lost before the outbox existed. The new Mongo
collection/indexes are created on first use. Deployment remains operator-owned.