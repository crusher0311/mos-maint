# Normalized work-order collision recovery

## Scope

This local change corrects parent identity propagation after a concurrent
non-Protractor work-order create loses the PostgreSQL natural-key race.
It does not deploy anything, repair historical data, enable Telle capture,
change export eligibility, or change shop 635's backfill.

The canonical writer returns the persisted parent ID. Ingestion carries that
ID through create, update, and Mongo-fallback skip paths, including shadow and
child writes. Collision recovery requires unambiguous matching provider
identity and a conditional update against the ownership evidence just read.
Missing, conflicting, or changed ownership remains an explicit failure.
Existing Protractor identity and snapshot-freshness vetoes remain in place.

Concurrent create shadows use insert-if-absent semantics under the canonical
ID; they do not overwrite an existing shadow snapshot. This is not a
historical shadow migration or a stale-snapshot ordering fix.

## Local verification

Run `bash tests/run-normalized-parent-identity.sh`.
The runner strips inherited credentials, starts disposable PostgreSQL on a
Unix socket with TCP disabled, and removes it on exit. A database marker is
required before test schema creation. The test exercises the actual writer and
ingestion code, with real parent/child foreign keys and an in-memory Mongo
double. It covers:

- Two creates resolving to one canonical parent, including retained raw ID.
- Missing, conflicting, and ambiguous provider identities.
- Ownership changing between the collision lookup and conditional update.
- Service jobs, line items, and payments using the returned parent.
- Create, update, and skip-path shadow identities.
- Disabled Mongo shadows.
- A failed parent preventing child ingestion.

Also run the existing FK skip-path, invoice background compatibility, invoice
evidence preservation, callback normalization runtime, and Protractor
work-order identity regressions in a credential-free environment. The
Protractor identity runner uses its own disposable PostgreSQL instance.

Production release checks and deployment require separate approval. Historical
reconciliation must match provider identities and independently check child
completeness; a failed transient local ID does not prove a provider job is
still missing.
