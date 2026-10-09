# Unified enterprise vehicle history: staged operator pilot

## Status and boundaries

Code is default-off. This runbook does **not** authorize migration, indexes,
backfills, environment changes, production reads, or pilot execution.
Obtain separate operator approval for each live step.

The cross-location section is a read-only evidence view, separate from the
location-local maintenance plan. It is not persisted in plan, analysis, prefetch,
extension memory-plan, or signed-report caches. Every view/focus/refresh and
visible 30-second poll makes a no-store request and resolves authorization again.
The reader rechecks scope before returning. Do not inject shared rows into
existing plan caches or use them as current-RO/DVI/interval inputs.

Current repair-order actions retain the current authorized shop and its original
local vehicle/provider validation. Shared rows expose no add/edit/delete action.
Provider IDs are source evidence, not write capabilities. No cross-location live
provider lookup occurs. Existing job-search/pricing preferences are unchanged.

Signed reports, partner endpoints, public links, and derived plan consumers
remain **local-only**: their credentials do not grant enterprise redistribution.
The shared resolver rejects those channels even if called directly. Extending
those delivery contracts requires a separate explicit channel grant, not merely
using a common VIN.

## Required checks before enabling any enterprise

1. Identify one pilot enterprise with two or three locations; supported policy
   size and settings discovery are limited to 12 enterprise locations in this
   release. Record the current policy/revision and storage-mode flags.
2. Verify each shop points to exactly that enterprise AND that enterprise lists
   the shop, with no second enterprise claiming it. Confirm numeric/string IDs.
   Resolve conflicts through the existing authorized membership tooling; do not
   auto-merge vehicles or infer ownership from VIN/customer/plate.
3. Confirm explicit per-account shop assignments. A current-shop login alone
   does not authorize siblings. Owners/admins may edit only policies whose
   selected, still-member locations they are explicitly assigned to administer.
   Verified extension users use the same assignments; Basic sessions cannot
   read cross-location history.
4. Confirm maintenance entitlement at every location. Missing/unavailable
   entitlement data fails closed. No platform-admin entitlement bypass is used
   for sharing.
5. Sample each provider's exact VINs in source receipts and canonical records.
   Record missing/invalid VINs, conflicting normalized vehicle references,
   missing job source IDs, missing business dates, unknown statuses, oversized
   receipts, soft deletions, and truncation rates. A 17-character exact VIN
   identity is required; no punctuation repair, partial lookup or fuzzy linkage.
6. Prove at least one positively completed, dated service at A and an earlier
   distinct decline at B for the same VIN, using original provider receipts.
   An authorized job on a closed RO is **not** sufficient proof. Inspection-only
   work must not settle a repair/replacement.
7. Confirm canonical normalized PG coverage by shop/VIN. Mongo normalized
   mirrors are never a fallback. Validate on fixtures with
   `WRITE_MONGO_NORMALIZED=0`. The initial read is at most 200 joined job rows
   per location; the query must not silently scan an unindexed fleet.

### Source-coverage matrix

| Source | Reader authority | Important limitations |
| --- | --- | --- |
| Normalized performed/deferred jobs | Canonical PG only | Job status defaults are not proof. Recover exact-ID original provider jobs from preserved work-order rawPayload. Missing/ambiguous or >16 KB receipts remain unknown. |
| Tekmetric legacy declines | Canonical Mongo job_index | Exact shop + vehicle.vin + sourceType + authorized:false; no PG mirror inference. Legacy rows can lack stable RO identity or decline dates. |
| Protractor deferred snapshot | PROTRACTOR_OPS_PG_CANONICAL selects authority | Missing snapshot means unknown, never completed. Fetch time is not the decline date. Prior items omitted by a provider snapshot cannot be reconstructed without source evidence. |
| Manual declines | LEGACY_VEHICLES_PG_CANONICAL selects authority | Exact owned vehicle only, no NULL-shop fallback. Duplicate ownership records are excluded. Old entries may have no mileage unit or complete component evidence. |
| Shopmonkey / Shop-Ware | Normalized PG + manual evidence | Older/default-mapped completion states are unknown; sparse provider payloads may not establish completion. Certify provider coverage before using that location in a pilot. |

All locations currently advertise incomplete source coverage, even for a
successful empty query. “No records returned” is never “no work ever performed.”
Do not promote a provider without original-evidence comparison. Historical
repair guidance must identify affected shops/VINs and missing fields, the
authoritative receipt, a dry-run count, and an approval gate. Do not run a repair
or backfill as part of this release.

## Storage prerequisites (operator approved, not application startup)

Inspect live `pg_indexes` first: equivalent custom-named indexes may already
exist. Apply the new policy table in `drizzle/0037_enterprise_vehicle_history.sql`
only after approval. New policy state has one PG authority and no FK to the
possibly unmigrated enterprise identity table.

Supporting indexes:

- `normalized_work_orders(shop_id, (vehicle->>'vin'), closed_date DESC, id)`
- `normalized_service_jobs(shop_id, work_order_id, id)`
- Existing normalized vehicle primary key and shop/VIN unique index.
- Legacy Mongo `job_index`: shopId + vehicle.vin + metadata.sourceType +
  authorized + performedAt descending (verify existing compatible indexes).
- Legacy Mongo vehicles: shopId + vin; Protractor deferred snapshots: shopId + vin.
- PG legacy stores: existing shop/VIN and Protractor shop/deferred_work_id keys.

Run index creation **CONCURRENTLY**, individually outside a transaction in a
quiet window if production indexes are needed. The SQL file and legacy
apply-normalized-tables script use ordinary CREATE INDEX for offline/new-store
setup; do not blindly execute that script against a live fleet.
No storage canonical switch is needed for this feature or its rollback.

## Isolated verification

```
npm run test:enterprise-vehicle-history
node --check mos-tools-extension/sidepanel.js
npm run typecheck
```

The first command denies network egress. It covers tenant/source-ID isolation,
VIN validation, membership ambiguity, excluded shops, entitlement removal,
revocation during a read and on subsequent reads, dashboard/extension parity,
Basic/partner/signed rejection, provider status proof, inspection-only work,
date ambiguity, partial bundles, recurrence ordering, non-destructive evidence,
SQL shop predicates, PG canonical reads with normalized shadow disabled, legacy
canonical routing, and UI context races/read-only behavior.

For visual fixtures only:
`node components/vehicle-history-fixture/server.cjs` (port 5010).
Never start the ordinary application just to obtain a screenshot in an isolated
environment: its startup can write to the shared live database.

## Performance and shadow comparison

Two location-read lanes maximum. Each normalized SQL transaction sets a 1.5s
statement timeout; legacy Mongo operations use 1.5s maxTimeMS; the shared request
has an 8s total response deadline including scope revalidation. The deadline
does not cancel database connection acquisition; observe pool pressure before
increasing any limit. Source rows and receipts have hard caps. Browser refreshes
are 30s and do not retain shared evidence on failure or context change.

Before enabling display, use operator-approved read-only samples to compare
local source records with the proposed shared set. Record:

- location count, returned count by provider/status/origin, source-identity
  duplicates/conflicts, unknown-status/date rate, truncated/failed-location rate;
- performed/declined matches and mismatches against source receipts;
- false completion count (must be zero), partial bundle count, completed
  elsewhere proof pairs (decline ID/date + completion ID/date + component/action);
- total and per-source p50/p95/p99 latency, database statement timeouts, pool
  waits, response bytes, and normalized receipt-size exclusions;
- existing local plan and write-payload equality before/after enabling.

Use 1, 3, and 12 location fixtures plus an oversized/truncated location and one
failed source. Pilot acceptance: p95 <= 3s, p99 < 8s, zero scope leaks and zero
false completions; no material regression in existing VHI/RO endpoint latency.
On missing evidence or exceeded latency, remain in performed-only mode or
disable sharing. Do not relax completion semantics to improve apparent coverage.

## Three-stage rollout

After separate operator approval and prerequisites:

1. Set `ENTERPRISE_VEHICLE_HISTORY_ENABLED=1` in the approved environment only.
   This exposes controls; every enterprise still starts disabled. In Preferences,
   select exactly the approved locations and save **performed** stage. Compare
   dashboard/extension fresh and cached-plan views using the same verified user.
2. Enable **deferred** visibility only after provider/date/identity coverage is
   documented. Verify unrelated/excluded same-VIN records never appear. Confirm
   the UI has no cross-location add-to-RO or mutation actions.
3. Enable **reconcile** only after every pilot completed-elsewhere match has
   sufficient exact component/action evidence. Partially classified bundles must
   stay outstanding/partial; same-day/undated/inspection/authorized-only examples
   must stay unresolved. Keep original evidence visible.

At every stage test: remove a user's sibling assignment, remove shop membership,
uncheck a selected location, revoke maintenance entitlement, disable sharing,
switch extension shops while a request is pending, and visit a signed/partner
plan. The next server read must contain no revoked foreign evidence, including
when the local maintenance plan came from cache. Current screens clear on the
next refresh/focus or at most their visible 30-second poll; revocation does not
recall data already displayed on another device.

## Rollback

Set the enterprise policy disabled (revision-checked) or turn the global
`ENTERPRISE_VEHICLE_HISTORY_ENABLED` switch off. The next shared read is empty
and disabled; local history and RO actions continue unchanged. No plan-cache
purge, history deletion, vehicle merge reversal, provider-side deletion,
backfill, or database cutover is required. Preserve policy and source rows for
audit. Record the reason and any evidence/latency mismatch before re-enabling.
