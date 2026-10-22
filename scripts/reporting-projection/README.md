# Local invoice reporting projection

This is a **disposable-database prototype**, not an application route, production
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

## Production work still required

1. **Source inventory and clearance adapter.** Read canonical owners, retained
   archives and relevant copies with bounded, resumable enumeration. Validate
   current financial/ownership evidence and authoritative hold coverage. The
   fixture's clearance and inventory booleans must not become user-supplied
   production approval flags. Persist reviewed input versions and cutoffs;
   detect stale review and cross-store source changes.
2. **Reviewed migration and access roles.** The SQL here is local-only. Prepare
   production schema naming, grants, retention, query plans, storage estimates
   and rollback. Use read-only operational credentials and reporting-only write
   permissions. Installation requires approval, not a startup hook.
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
