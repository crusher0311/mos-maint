# Same-account Protractor reconnect

This change is local until separately approved for release. It does not authorize
repairing production records, provider calls, or starting historical imports.

## Supported behavior

- Credentials still undergo the existing provider validation.
- A retained account fingerprint, or consistent stored connection ID, establishes
  account identity independently of the API key.
- A changed API key for that same account can be saved without deleting history
  or resetting the canonical progress cursor.
- Credential generation and sync revision still fence old checkpoint writers.
  Rotation is refused while a checkpoint mutex exists or historical progress is
  marked in progress, even if its activity timestamp is old.
- Disconnect retains the non-secret account fingerprint and removes credentials.
- An exact match to an older credential-pair fingerprint can establish the new
  account fingerprint during reconnect.
- Inconsistent stored credentials or a different account remain blocked.

## Older disconnected shops

A record containing only the old credential-pair fingerprint cannot establish
which connection ID it belonged to. The fingerprint is not reversible. A new
submitted connection ID, valid API key, matching display name, or user confirmation
alone must not silently rewrite that historical identity.

These records return `PROTRACTOR_RECONNECT_REVIEW_REQUIRED` through the existing
settings error display. This release does **not** include a production recovery
writer or a client-supplied override.

Before proposing a one-shop recovery:

1. Establish the intended account identity against trusted retained provider
   evidence or a separately reviewed operator recovery record. Do not put API keys
   or connection IDs in logs, chat, or source-controlled plans.
2. Confirm the canonical stores and ownership of retained history, callbacks,
   exports, and queued work. An empty bounded Mongo read is not proof that all
   stores are empty.
3. Verify that relevant workers have stopped and outstanding checkpoint writes
   have settled. Never clear a mutex merely because it is old.
4. Prepare an exact, compare-and-set guarded metadata proposal preserving existing
   history and cursors, and obtain explicit production approval. Re-read the
   snapshot before applying; changes invalidate approval rather than widening it.
5. Verify saved credential presence and account consistency without printing
   secrets, then verify reload and reconnect behavior. Activation of historical
   processing remains a separate decision.

## Offline checks

`npm run test:protractor-onboarding` includes route and browser coverage.
Runtime cases cover key rotation, legacy identity learning, disconnected retained
identity, unresolved legacy recovery, mismatched accounts, busy/stale workers,
conflicting stored credentials, compare-and-set races, and retained cursors.
Run the complete prebuild suite before a release; client resolver changes also
affect canned-job fixtures outside the onboarding suite.
