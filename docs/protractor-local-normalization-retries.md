# Local normalization recovery (disabled)

`PROTRACTOR_LOCAL_NORMALIZATION_RETRIES` must be exactly `true` to opt in.
No environment setting or schema has been installed by this change.
`docs/sql/protractor-normalization-retries.sql` is a **separate review-only**
installation proposal, not an automatic migration or startup operation.

## Contract

- Enabled callbacks retain a complete payload in PostgreSQL before acknowledging
  their normalization handoff. A failed handoff fails the callback; a handoff is
  reported as skipped/pending normalization, never as completed normalization.
- The existing callback drain also drains up to five independent retry intents
  before callback processing, on the configured web/worker execution target.
  No pending callback event is needed to recover retained normalization work.
- Retained content is deduplicated per shop/provider identity, independent of
  JSON object key order. Completed and terminal duplicates do not reopen work.
- Each claim has a unique token, 90-second lease and six-attempt cap. Retry delays
  start at 30 seconds and double (capped at one hour). Expired final claims become
  terminal. Claim selection skips locked rows; stale tokens cannot finish work.
- Attempts re-check the current shop's Protractor eligibility and validate the
  provider ID and VIN. They perform no provider request, snapshot fetch, history
  indexing, attribution, audit scheduling, repair-pattern replay or export.
  Existing shop metadata remains a read dependency, **not Mongo retry state**.
- Canonical PG parent, child and completion updates share a transaction. Forced
  parent writes enforce the existing atomic identity/provider-version guard,
  even when mapped content hashes match. The parent row lock remains held
  through child writes, preventing old queued generations overwriting newer ones.
  Failed prerequisites (vehicle/customer) and any failed child prevent completion.
- Existing Mongo-only inspection/recommendation data writes remain idempotent
  normalization operations. They are not distributed transactions with PG.
  Deterministic new parent/vehicle IDs preserve their associations after PG
  rollback; a lost acknowledgement causes retry, not false completion.
  Mongo shadow writes and ingestion stamps are suppressed for this path.
- Statement/lock/idle-transaction timeouts bound database stalls. The drain
  budget limits admissions, not already admitted work; lease expiry prevents a
  late attempt from committing its PG data or completion marker.

## Operations and review

Review installation privileges, sensitive payload retention policy and capacity
before installing the SQL or enabling the flag. Retained payloads contain
customer data; do not expose the table in browser APIs or logs.
`protractor_normalization_retry_health` exposes payload-free counts, ages,
states and failure categories. Terminal failures are also logged without payloads.
No automatic terminal reset or deletion is provided: preserve evidence for review.
Disabling the flag stops intake and execution without deleting pending work.
No old failed callbacks are retroactively fetched or imported.

Run `bash tests/run-protractor-normalization-retries.sh` for disposable PostgreSQL
coverage with a clean environment and denied non-loopback network access.
Existing identity/freshness and callback runtime suites remain applicable.
