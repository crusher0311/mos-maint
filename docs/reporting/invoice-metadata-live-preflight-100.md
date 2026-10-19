# Read-only live preflight: 100-invoice metadata proposal

## Decision

**Target/source checks passed; execution remains blocked by undeployed
preservation fixes.** No repairs, deployment, feature changes, provider calls,
database grants or writes were performed.

This preflight is an observation, not a lease or authorization to write later.
Any future executor must recheck current state atomically.

## Target and retained-source checks

Bound to canonical proposal digest:

`e9bdcc87b9eeca067e65eddb2ca66575886f56bb0de2ba0de6f567fe8dd0db1a`

Using the actual main Render service's effective database configuration, the
database host/database matched the approved external production target.
PostgreSQL used a read-only repeatable-read transaction, a five-second statement
limit and a single connection. Mongo reads were separately bounded, sequential,
and limited to the same source identities.

| Check | Result |
|---|---:|
| Planned identities checked | 100 |
| Exactly one PostgreSQL owner | 100 |
| Target row hashes match saved snapshot | 100 |
| Captured reporting projection unchanged | 100 |
| Identities with newly differing current raw copies | 0 |
| Ambiguous Mongo owner/competing native alias | 0 |
| Existing non-null Mongo invoice evidence | 0 |

The compared PostgreSQL projection includes status, soft-delete state, provenance
and custom fields. Current raw payloads from normalized records and available
provider caches matched supplied-source digests. This does not prove that every
historical archive occurrence is unchanged or that no newer archive copy exists;
archives were not reread during this preflight.

The comparison did not inspect or approve financial amounts. The previous
ownership-review overlap check remains limited to that specific retained review.
No broader financial hold registry or complete historical graph was certified.

## Live deployment records and source inspection

Render reported these live deployment commits. Both commits were available
locally and their ingestion source was inspected directly using `git show`.

| Service | Live commit | Deployment finished (UTC) |
|---|---|---|
| mos-tools | `fe244d68b9fabd5b7a8a4173404271b7962736b9` | October 17, 2026, 22:46 |
| mos-protractor-callback-worker | `fe244d68b9fabd5b7a8a4173404271b7962736b9` | October 17, 2026, 22:34 |
| mos-maint-background-v2 | `8d190f07b70c4f15affa1faba19f8e13041e41b8` | October 5, 2026, 23:03 |

At both deployed commits:

- The invoice-identity preservation module/call is absent.
- The PostgreSQL existing-work-order update omits the native raw payload.
- Create and Mongo shadow update paths retain raw payloads.

Therefore the locally tested preservation and raw-retention fixes are **not in
these deployed commits**. A web-only release would leave another writer on old
code. Deployment metadata/source inspection does not certify every process's
runtime behavior or imply that a suspended worker is actively running.

## Separate fleet-query gate

The actual main runtime database role is on PostgreSQL 17.6 and still lacks SET
permission for `temp_file_limit`. The fleet-aggregation feature setting was
absent from the inspected effective main-service environment. No permissions
were changed and no unguarded fleet query was executed.

This permission gate is separate from the data repair and from release of the
preservation fixes. Do not enable the fleet aggregation lane to bypass it.

## Evidence retained

Private preflight summary, per-identity outcomes and deployment metadata:
`generated-artifacts/reporting-snapshots/preflight100.ZEfWms/`

Identity-bearing files remain excluded from Git/deployments. This document is
the sanitized summary.

## Next safe sequence

1. Prepare/test a release containing the preservation and raw-retention fixes
   for all relevant ingestion services, with repair and fleet enablement off.
2. Obtain separate release approval; verify the deployed commits on each writer.
3. Build/test the guarded metadata-only executor and review its canonical/shadow
   consistency, compare-and-set, audit, retry and conditional rollback behavior.
4. Refresh target/source/hold preflight and obtain explicit repair authorization.
5. Execute the approved pilot only, then validate its resulting report separately
   from fleet-wide coverage and fleet-query permission setup.

No step in this document authorizes production mutation.
