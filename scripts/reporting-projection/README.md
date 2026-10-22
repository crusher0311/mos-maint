# Local invoice reporting projection

Production status, October 22, 2026: the reporting and hold-registry schema was
installed under explicit approval. The first shop-227 population attempt could
not pass live change-feed admission; no invoice build or report was produced.
Both shared switches remain off. See
`docs/reporting/projection-installation-2026-10-22.md` for the execution record.
The earlier design/prototype notes below are not current installation status.

## Gated stored-source worker

The disposable prototype below remains unchanged. The production-capable,
**disabled-by-default** implementation is in `lib/reporting-projection/`.
`production-schema.sql` is the explicit operator migration, not a startup hook.
It refuses existing objects and must not be rerun against the installed database.
Running the application does not create any tables or triggers.

Run the independent, credential-free acceptance suite:

```sh
bash tests/run-reporting-projection-worker.sh
```

This runner uses only synthetic data, a fresh Unix-socket PostgreSQL instance,
an empty environment and the network-denial preload. No retained customer
fixture is required. It exercises the actual SQL candidate, worker, source
adapter, projection reader, KPI integration and cache-key separation.

### Operation and authority

- `projectionRuntime(reporting, sourcePg, mongo).tick(shop, signal)` is the
  bounded worker entry for a separately approved operator scheduler. There is
  deliberately no startup hook, new cron registration, connection discovery,
  provider fetch, automatic migration, or implicit fleet/shop discovery.
- `REPORTING_INVOICE_PROJECTION_BUILD_ENABLED=true` enables the worker and change
  consumer only. `REPORTING_INVOICE_PROJECTION_READ_ENABLED=true` selects the KPI
  reader independently. Both default off. The retired combined flag enables
  neither path. Shadow rollout enables BUILD first, keeps READ off, and verifies
  schema, roles, inventory, reviews and freshness before approving READ.
- Supply a reporting-only writer connection, a **read-only** source PostgreSQL
  connection, and read-only MongoDB access with change-stream/list-collection
  privileges. The worker may SELECT the existing hold registry and review
  tables, never INSERT/UPDATE/DELETE them. Do not use application-owner
  credentials to bypass these boundaries.
- `reporting_invoice.reviews` contains independent, trusted reviewer
  attestations of financial and canonical-owner evidence. Each attestation
  binds the exact complete source inventory, identity reference digest, parser,
  accounting/owner evidence references, actor and expiry. Only a separate
  approved review role may write it. A reference alone, raw-copy agreement,
  fixture clearance, or a request-body approval boolean is never accepted.
  No financial-review authoring API or automatic approval is supplied.
- Hold clearance comes from the existing authoritative registry and its
  current, unexpired coverage review **for this inventory digest**. Empty holds
  without coverage do not clear anything. Holds/reviews are rechecked at report
  read time, including expirations that generate no change event.
- Noninvoice exclusion requires both reviewed classification and explicit
  noninvoice source evidence. Missing identity, missing/ambiguous owners,
  conflicting copies, unreviewed/held records and unknown dates remain
  unresolved. Missing labor remains null, never zero. Anonymous source
  documents are counted as unresolved units, not asserted to be distinct
  invoices or customers.

### Inventory, resource bounds and recovery

The adapter enumerates canonical work orders, three PostgreSQL/Mongo provider
caches, Mongo owner copies, all retained archive campaigns (checksum-verified),
history jobs/days/receipts and financial children in both stores. Namespace
availability is required; a query failure is not interpreted as an empty
inventory. Mongo keysets preserve BSON key types, and provider IDs are
case-normalized. No whole-shop manifest or raw payload is retained in memory
or copied into the reporting schema.

Each admitted shop has one active build. Per-document/identity transactions
atomically persist the checkpoint and derived rows. Lock contention returns
`busy`; lost responses resume committed state; cancellation preserves the
previous publication. Source refs/digests are durable. A second complete
enumeration verifies the inventory before projection, and each selected
reference is checked again before parsing.

Bounds: one source document per read (16 MiB), at most 100 references/32 MiB
per identity, 100,000 identities and 1,000,000 documents per build. Each tick
admits at most 25 steps/15 seconds, with 2-second SQL and Mongo source timeouts.
An admitted read/commit can finish after the admission deadline; these bounds
do not claim instantaneous cancellation of an in-flight database call.
Identity copy/byte/time limits preserve the identity as unresolved; inventory
limits fail the generation rather than publish a truncated population.
Retry transient source/DB errors using the same build ID. Failed/cancelled
builds require a new generation, not a silently advanced checkpoint.

Canonical PostgreSQL and registry statement triggers invalidate revisions,
including deletes/TRUNCATE. The Mongo change consumer commits its resume token
and invalidation together; a missing/history-lost token invalidates all scopes.
Consumers advertise freshness only after draining events. Reader admission
requires a heartbeat within 30 seconds and a complete verified inventory
younger than five minutes. The operator runtime periodically re-enumerates
even when no event arrives, reconciling missed notifications. These are
bounded-staleness snapshots, **not cross-store atomic snapshots**. No telemetry
claims otherwise. Cold/incomplete/stale fleet reads fail explicitly, without a
second operational scan.

### Report compatibility and rollout

The existing authorized reporting scope, invoice metric coverage, saved report
versions, recipient authorization and report-run queue remain the entry
points. Cache keys include projection generation/revision and review/freshness
state. A source change during execution prevents publishing that result.
Automatic refresh moves to the new cache key while retaining the old saved
snapshot/link; direct historical run access remains historical, not a claim
of current evidence. Other metrics and the default-off path are unchanged.

Installation, grants, capacity/index plans, retention, monitored scheduling,
comparison against a complete shop inventory and activation require separate
approval. This task performs none of them. Generation data is not automatically
deleted; an approved retention job must preserve published generations and
their review/audit references.

## Original disposable prototype

The code described below is a **disposable-database prototype**, not an application route, production
migration, repair tool, or deployable replacement for the current report.
Every exported database operation requires the disposable database marker.
Do not set that marker on a real database to bypass this boundary.

## Run

`bash tests/run-reporting-projection.sh`

Requires the project's PostgreSQL binaries and retained private ten-identity
fixture at `generated-artifacts/reporting-snapshots/archive96.wn5KHB/shop-227.json`.
The fixture is intentionally not committed: it contains raw customer data.
The runner creates and destroys a fresh Unix-socket PostgreSQL instance, clears
environment credentials, and denies network egress. It does not start the app.

## Implemented

- Build/coverage, invoice-fact and evidence-reference tables.
- Immutable manifest fingerprint and parser version for each generation.
- Strict shop/identity validation and existing stored-evidence reconciliation.
- Explicit unreviewed/held classifications. No raw-copy agreement overrides holds.
- Atomic batches/checkpoints with idempotent retry and resume.
- Source-change rejection rather than mixing different snapshots.
- Publication only after a declared complete inventory is fully processed.
- Atomic per-shop publication; prior result survives a failed/incomplete build.
- Shop-authorized report reader with source counts and unavailable averages
  for unresolved population. Unknown-date records remain counted for any range.
- Source references and digests rather than raw payloads or PII in these tables.

## Verified locally

Ten retained JWT-701 identities / 47 source copies, under **hypothetical fixture
clearance**, produce ten covered invoices and totals of 5.7 sold / 16.42 presented
hours (averages 0.57 / 1.642). This is a selected September/October cohort, **not**
the October 19–22 report, a full-shop result, or production-approved evidence.
The same cohort with its actual unreviewed clearance produces ten unresolved
identities and no averages.

Tests cover isolation of unpublished results, scope authorization, duplicate
identities, held/unreviewed records, missing/conflicting dates, rollback after
an injected mid-batch database failure, checkpoint recovery, lost-response retry,
changed-input rejection and incomplete inventory rejection.

Full workspace TypeScript check passed after this implementation.

## Original prototype follow-on plan

Items 1, 3 and the synthetic portion of 4 are now implemented by the gated
worker above. The list below records the original prototype boundaries;
installation, independent rollout verification and activation remain separate.

The database design is now specified in
[Production migration proposal](PRODUCTION-MIGRATION-PROPOSAL.md), including the
versioned source-adapter handoff, access matrix, retention, query plans, sizing,
rollback and bounded JWT-701 acceptance gates. This is a proposal for discussion,
not approved installation SQL. `schema.sql` and `model.ts` remain local-only.
The adapter, worker and integration below are still required; do not treat the
proposal as an implementation or as evidence/hold clearance.

1. **Source inventory and clearance adapter.** Read canonical owners, retained
   archives and relevant copies with bounded, resumable enumeration. Validate
   current financial/ownership evidence and authoritative hold coverage. The
   fixture's clearance and inventory booleans must not become user-supplied
   production approval flags. Persist reviewed input versions and cutoffs;
   detect stale review and cross-store source changes.
2. **Migration approval and implementation.** Review the linked proposal with
   the user and database owner, settle its open decisions, then separately
   implement and test the approved migration and roles. Use read-only operational
   credentials and reporting-only write permissions. Installation requires
   explicit approval, never a startup hook.
3. **Worker and report integration.** Replace the prototype's whole in-memory
   manifest with durable bounded work items. Add admission/deadline/memory caps,
   cancellation and observability. Tie fact invalidation to source changes and
   authoritative holds; periodically reconcile missed changes. Connect to the
   existing reporting authorization, jobs, caching, saved results and UI behind
   a disabled feature gate. Do not silently fall back to a second expensive scan.
4. **Acceptance beyond this cohort.** Test independent synthetic fixtures,
   missing labor, noninvoice classification, multi-shop publication semantics,
   concurrent rebuilds, stale holds and realistic resource/latency conditions.
   Exact decimal storage currently receives the existing parser's JS numbers;
   do not describe it as arbitrary-precision source parsing.
5. **Bounded first rollout.** With explicit approval, populate one shop, reconcile
   its complete declared population, and compare reports before fleet activation.

No production schema, data, configuration, deployment or report was changed.
