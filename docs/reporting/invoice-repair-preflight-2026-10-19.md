# Read-only metadata-repair prerequisite recheck

Scope: the original fixed 100-identity proposal, unchanged plan digest. No
provider requests, repairs, deployments, worker resumes or feature activation.

## Current target and source comparison

All 100 targets were found uniquely in canonical PostgreSQL. All target hashes
and reviewed metadata projections matched the existing proposal. No new current
source-copy digests were found in the checked canonical/cache/shadow copies.
No ambiguous Mongo owners or competing native aliases were found; none of the
checked Mongo targets already had invoice-hours metadata.

This comparison is complete for its limited scope, NOT execution-ready. It does
not freshly inventory every retained archive, certify a complete financial/owner
hold registry, compare every full-row revision, or fence concurrent writers.
The existing proposal must not be silently rebased.

Private details: generated-artifacts/reporting-snapshots/preflight100.9icc3t.
An additional writer-only inventory included the drain worker omitted from the
web service's shared environment-group membership.

## Actual deployed writer versions

- Web and callback worker: live on the approved preservation release 77310a41.
- Generic background and backfill-drain workers: both still suspended, pinned to
  release/invoice-background-20261019 but their deployed images remain 8d190f07.
  Branch pinning does not establish that the prepared compatibility fix runs.

No worker was resumed or reconfigured. No running-process revision endpoint was
used; the version claims above are Render deployment metadata, not independent
in-process attestation.

## Remaining stop gates

1. Finish approved writer rollout and verify actual revisions for all writers,
   including scheduled resume paths. Preserve suspension until authorized.
2. Implement and verify the production PostgreSQL/Mongo repair boundary; the
   existing executor is disposable-database-only and cannot safely apply repairs.
3. Complete fresh archive/hold/full-state preflight and writer fencing before
   requesting execution approval bound to the exact plan and current evidence.

The successful streaming report test does not waive these repair requirements.
