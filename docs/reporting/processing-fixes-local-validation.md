# Reporting processing fixes — local package

## What changed

1. **Bounded inventory bookkeeping**: one data-modifying CTE writes the source,
   all of its (at most 101) identities/references, and its digest/cursor checkpoint.
   Shared identities are counted once. Transaction rollback leaves no partial
   checkpoint. Source retrieval remains one document at a time with the existing
   source byte cap and ordering. This is not a wider unbounded raw-data batch.
   One single-identity document now needs eight rather than twelve reporting-side
   round trips; source-side round trips remain.
2. **Independent feed catch-up**: `projectionRuntime.catchUp()` drains without
   starting an inventory build. Each call is limited to 40 polls / 60 seconds
   maximum (defaults 10 / 15 seconds), plus bounded completion of in-flight work.
   It returns aggregate event/poll counts and honors cancellation. It never
   changes either shared flag or treats a nonempty backlog as fresh.
3. **Proposed scoped invalidation migration**:
   `scripts/reporting-projection/scoped-invalidation.sql` uses per-statement
   transition tables for all source and review/hold tables with authoritative
   integer shop_id. Inserts/deletes affect their owners; updates affect old and
   new owners. Unknown/null/nonpositive owners and TRUNCATE invalidate the fleet.
   Bulk statements invalidate each affected scope once, with ordered scope locks.
   Empty statements do not invalidate scopes.

## Safety boundaries

Production is unchanged. The migration is deliberately NOT wired into startup,
deployment, or automatic migration execution. The original installation remains
unchanged; this separate transactional migration must be reviewed and explicitly
approved for installed databases. It fails on missing authoritative ownership
columns or unexpected prior trigger state, rather than guessing ownership.

The definer remains non-login/non-superuser. Temporary schema CREATE and SET
authority are revoked, and PUBLIC execution is revoked as the function owner.
The only added table privilege is reading shop_id from reporting scopes; no
operational write permission is granted.

The independent catch-up entry is not scheduled in production by this package.
An approved operator runner must call it with explicit limits and lifecycle
management. Runtime inventory ticks still poll before/after work for freshness.
The existing five-minute verification window, evidence review requirements,
holds, byte/row limits and reader checks remain unchanged.

## Verification

Disposable PostgreSQL 16.10 and 17.6 worker/installation suites, with egress
denied and production credentials removed, exercise:

- non-superuser installation and effective role/ACL boundaries;
- operational CRUD after migration;
- unrelated-shop open transactions no longer blocking the target builder;
- bulk insert, ownership moves, deletes, empty statements, unknown owners,
  TRUNCATE and fleet fallback;
- bounded catch-up, exact token replay, no false freshness and cancellation;
- atomic batched checkpoint rollback/replay and shared identity reference counts;
- existing source-change, review, hold, deadline, publication and privilege tests.

The 20 ms artificial-RTT check asserts eight reporting exchanges for one
single-identity document. This is a local cost regression check, not a fleet
completion estimate. Indexes and these fixes do not prove that a full shop's
verification/project phase can finish inside its freshness window.

## Before another live run

Review the migration against actual source ownership columns and existing
trigger/role definitions read-only. Obtain approval before applying it.
Then use a bounded operator pilot with independent feed catch-up, retaining the
existing inventory checkpoint. Record busy rates, event counts, inventory
throughput, freshness and final verification separately. Keep shared readers
disabled and do not create financial/hold reviews automatically.

## Read-only production preflight

At 2026-10-22 16:13:30 UTC, the approved read-only check found no migration
prerequisite blockers on PostgreSQL 17.6:

- Target matched the deployed web service's database configuration; both shared
  reporting switches were off.
- All eleven target tables were ordinary, nonpartitioned tables with a NOT NULL
  integer shop_id and installer ownership.
- Each table had exactly the expected enabled statement-level reporting trigger,
  with no condition or arguments, bound to the original invalidator.
- The installed function body matched the reviewed original. Its definer was
  restricted, and builder execution remained revoked.
- Installer schema-create, role-administration and object ownership prerequisites
  passed. The new scoped function did not already exist.
- Health snapshot: four active queries, zero lock waiters, zero old idle
  transactions, and no active index builds.

Receipt: generated-artifacts/reporting-snapshots/scoped-invalidation-preflight-20261022.json
(ignored). The receipt binds the reviewed migration hash. This was not an
installation or a lock-acquisition test; conditions must be refreshed before
applying the transactional migration. No production writes, population,
deployment, report activation, or Protractor calls occurred in this check.
