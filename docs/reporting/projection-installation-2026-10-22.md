# Production installation and first population attempt

## Result

The authorized transaction installed seven tables in `reporting_invoice`,
three public hold/coverage registry tables, indexes, restricted roles and
invalidation triggers on October 22, 2026 at 12:45 UTC.
The target was verified against the production web service's effective database
configuration. Customer report activation and shared builder settings remain off.

Installation checksum:
`9bd762b7c5d8b9347682799c4533228dfe0484dcc4830bbe05cba335bd918db9`.
Private execution receipt:
`generated-artifacts/reporting-snapshots/install-receipt-20261022.json`.

Two earlier transactional attempts failed with PostgreSQL 42501 because the
installer could not SET ROLE to the new function owner. Subsequent catalog
checks confirmed rollback. The corrected migration temporarily grants installer
SET permission for ownership assignment and revokes it afterward. No broader
application membership in the invalidator role was granted.

Registry definitions preserve immutable hold identity/evidence and append/
resolution semantics. Hold review IDs are text, matching the established
registry contract, not the UUID-only simplified test fixture. Empty registries
are not clearance. No hold coverage, financial/owner attestation or approval was
inserted. Public API-role grants are revoked and registry RLS is enabled.

## Local acceptance

The synthetic PostgreSQL suite uses the complete migration, including registry
constraints and triggers. It passed evidence/coverage, invalidation, restricted
operational CRUD/TRUNCATE and reporting-role isolation tests before installation.
No Protractor requests were made.

## Population attempt: incomplete

An explicitly scoped operator process used the restricted reporting builder role,
read-only PostgreSQL source transactions and Mongo read/change-stream operations.
No shared settings or deployment was changed. Only shop 227 was eligible.

The first four polls and the subsequent bounded attempt (up to 100 polls/60s)
all returned `invalidated`, never `caught_up`. Consequently no build was created,
no invoice facts were populated, and no report was published. The persisted
change-feed cursor is retained; no source work or financial updates were issued.
The operator process stopped; there is no continuing background population job.

The runtime currently admits a build only when its single-event polling reports
an empty feed. Scope invalidation is fleet-wide. Continuous relevant writes can
prevent admission or invalidate a long build, so blindly repeating this attempt
is not a completion strategy. Correct this with bounded feed draining and a
reviewed source-version/invalidation strategy that can progress under live
traffic while still rejecting changed or stale evidence. Do not skip events,
mark the feed fresh artificially, disable triggers or relax review requirements.

Production report results remain unchanged. Installation success is not
population success and does not authorize activating the reader.
