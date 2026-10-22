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

### Non-superuser installation regression coverage

Run `bash tests/run-reporting-projection-installation.sh` with PostgreSQL 16+
on PATH. To exercise multiple installed versions, pass their **bin directories**
as arguments (for example, `/path/to/pg16/bin /path/to/pg17/bin`).
The worker acceptance runner also invokes this installation suite.
Verified locally on PostgreSQL 16.10 and 17.6; the combined installation/worker
acceptance runner passed on 16.10.

Each version gets a fresh private `/tmp` cluster with TCP disabled, synthetic
data, an empty inherited environment, network-denial preload, and unconditional
cleanup. No database URL or credentials are accepted. The fixture administrator
only bootstraps roles and grants; the actual, unchanged migration runs through
a separate NOSUPERUSER CREATEROLE login.

Coverage includes the original missing-SET failure, late missing-dependency
rollback (including transactional roles and triggers), successful owner
assignment and removal of temporary SET permission, repeated-install refusal,
default API grants including a BYPASSRLS service role, registry RLS with a
SELECT-only/no-policy control, non-UUID text coverage IDs, and real DML under
the migration-created builder/invalidator roles. Operational CRUD and TRUNCATE
are exercised on every source table and must increment reporting revisions.
Both reporting roles must fail INSERT/UPDATE/DELETE/TRUNCATE against source
invoices, payments, holds, coverage reviews and accounting reviews.

**Additional finding, not changed by this test-only work:** after transferring
the invalidation function and revoking installer SET membership, the later
function `REVOKE ... FROM PUBLIC` runs without the owner's authority. PostgreSQL
warns rather than failing the installation, and PUBLIC EXECUTE remains. The
suite prints `KNOWN GAP` when it observes this. Direct invocation of a trigger
function is rejected by PostgreSQL, but that is not proof of an EXECUTE ACL
denial. Correcting ACL ordering needs separate migration/security review; this
test work does not alter the SQL or any installed database.

The installation tests verify text IDs persist in the registry and projection
items. This is **not** an end-to-end text-ID worker claim: an additional worker
probe using `hold-review:<uuid>` instead of a UUID produced zero verified
invoices. The shared hold-coverage validator still requires UUID review IDs.
The established worker suite retains UUID fixtures; accepting valid text
identifiers through the full coverage path is a separate follow-up.

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

For the offline-tested bounded-drain correction and a separately approved
operator resumption, see [JWT-701 resumption](projection-jwt-701-resumption.md).
That correction does not change this installation/population receipt.
