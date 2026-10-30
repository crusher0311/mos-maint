# Tekmetric Tire DOT report — release and reconciliation

## Status and approval boundary

Implemented for isolated verification, **not installed or verified in production**.
The separately approved HEART October reporting-only pilot now has a dedicated
installation and worker path; see `docs/heart-october-tire-dot-pilot.md`.
Its reporting storage is installed, but live data/UI verification is still a
separate requirement. The generic raw-history setup below remains unapproved.
No production index, migration, grant, history scan, upstream fetch, provider
write or artifact modification is authorized by this document. The feature
defaults off (`REPORTING_TIRE_DOT_ENABLED` must equal `true`).

The existing Reporting page exposes the controls; location metadata is the only
new page-load read. Run queues a typed row-evidence report, not a KPI definition.
The existing report-runs cron dispatches a separate bounded Tire DOT queue.
Existing saved reports, pinned versions, deliveries and subscriptions are unchanged.

## Semantics

- Tekmetric `data.postedDate`, inclusive UTC calendar days. Timestamp offsets
  convert to UTC; timestamps without an offset are interpreted as UTC. No
  completed-date, ingestion-date or current-vehicle fallback.
- Require retained raw provider identity and posted date. Deleted/archived/void,
  explicit open work and unrecognized statuses do not contribute.
- Jobs require `authorized === true`, no declined/deferred/open status and no
  archived/deleted markers. Parts must not be archived/deleted or explicitly
  unauthorized, and must have positive recorded quantity.
- Tire candidates use **part** evidence: tire wording/type/category, standard
  tire size, or a nonempty textual `dotNumbers` collection. Brake fluid, rotation,
  mounting/balancing labor, disposal, repairs, sealants, valves, TPMS and warranty
  products are excluded. Job titles, brand alone and the word DOT are not evidence.
  This is conservative identification, not a complete tire catalog classification.
- Mileage precedence: raw RO `milesIn`, `mileageIn`, `milesOut`, `mileageOut`.
  Zero is valid. Never use the current vehicle mileage.
- Invoice identity is shop plus provider RO ID, not human invoice number.
  Detail identity also contains job/part snapshot positions and DOT array index;
  original job and part IDs remain separate fields. Missing IDs use explicit
  positional fallback labels. A generation is immutable.
- Each repeated DOT string remains a separate entry. A line without DOT yields
  a missing-DOT detail row and remains in the one-row-per-invoice export.
  Part quantity repeats on detail rows: sum quantities from invoices, not DOT rows.
  DOT-to-quantity mismatches are exceptions, not reconstructed identifiers.

## Bounded extraction and storage

Canonical source selection follows `TEKMETRIC_CACHE_PG_CANONICAL`. A run pins
the source mode; switching modes mid-run fails rather than mixing stores.
Only the background worker reads raw `tekmetric_work_orders`. It uses shop-scoped
keyset pages (25 records), a 2-second source statement deadline, 1 MB per raw
document, at most 100,000 scanned records, 5,000 output detail rows and a 4 MB
result budget. Admission is atomic per invoice. Limits produce explicit partial
counts and incomplete coverage, never a silently truncated complete report.

Each worker batch processes up to ten pages or 15 seconds. Every page checkpoints
the cursor and accumulator atomically with a lease token. Abandoned leases expire
after two minutes; stale workers cannot publish. Queued timestamps rotate for
fairness. Query/setup failures fail the run explicitly; users can retry.

Runs live in `tire_dot_report_runs` in the same Mongo reporting store used by
existing report runs, even when raw cache reads are PG-canonical. Active runs
deduplicate by requester, definition version, exact selected scope and store.
Completed generations may be reused for 15 minutes; explicit refresh creates a
new generation, preserving previous downloads. Parser semantic changes must bump
the definition version and its cache identity.

This scans retained work-order snapshots, not normalized part projections.
It is not a point-in-time snapshot of a changing provider. Missing raw payloads,
missing posted dates, incomplete collections and extraction limits are disclosed.
Even a successful full traversal means **stored evidence only**, never a certified
upstream coverage audit. An empty report does not establish no tire sales.

## Separate production setup checklist (approval required)

1. Review canonical store and current Tekmetric membership/permissions. No HEART
   shop list is hardcoded. Confirm Mongo raw keys are ObjectIds and inspect
   shop-scoped duplicate provider identities before approving extraction.
2. In Mongo-canonical mode, review/install the source index
   `{ shopId: 1, _id: 1 }` named **`tire_dot_shop_id`**. The worker deliberately
   hints that name and fails rather than scanning unindexed history.
3. Review/install queue indexes on `tire_dot_report_runs`:
   - `{ activeKey: 1 }`, **unique and sparse**;
   - `{ requestKey: 1, status: 1, heartbeatAt: -1 }`;
   - `{ status: 1, queuedAt: 1, heartbeatAt: 1 }`.
   Do not enable the feature until the unique active-run index is verified.
4. In PG-canonical mode verify the existing `tekmetric_work_orders` table,
   `(shop_id, work_order_id)` primary key, retained `payload`, and bounded query
   plan. No new PG table or role grant is required by this implementation.
5. Verify the authenticated existing report-runs cron actually executes at the
   intended cadence and has capacity alongside existing report work.
6. Only after explicit approval, enable the switch and run a narrow date/location
   reconciliation. Inspect generation, coverage, exceptions and source evidence.
   Approve broader scope separately; do not use the old 700-RO sample as coverage.
7. Disabling the switch stops new submissions and worker extraction. Existing
   persisted generations remain readable only after current authorization checks.

## User reconciliation checklist

Choose the same inclusive UTC posted dates and authorized Tekmetric locations.
Export **Invoice CSV**, one row per shop/provider RO identity, including invoices
missing DOT or mileage. Compare human invoice numbers within location, never
across the enterprise alone. An all-invoices Tekmetric export includes invoices
without tire sales, so its population and totals differ.

Inspect coverage and limits before treating counts as complete. Investigate
missing DOT/mileage and count mismatches against the original invoice. Use Details
CSV to inspect individual DOT occurrences; do not deduplicate identical DOTs.
Import identifiers as Text: CSV prefixes textual identifiers with an apostrophe
to preserve leading zeros and prevent formulas. This is intentional text
protection, not a formula. Scope/date/generation/coverage context is included even
in an empty CSV's headers. UI pagination does not truncate downloads.

## Offline verification

Run with a clean environment and the deny-network guard:

```
env -i PATH="$PATH" HOME="$HOME" PROTRACTOR_OFFLINE_ALLOW_LOOPBACK=true \
 NODE_OPTIONS='--require ./tests/helpers/deny-network-egress.cjs --require ./scripts/_stubs/server-only-stub.cjs' \
 node --import tsx --test tests/tire-dot-*.test.ts
```

Storage tests create and remove a disposable loopback Mongo database, exercise
the real index/aggregation/checkpoint operations, and test PG query shape with an
isolated adapter. Browser fixtures bundle the real dashboard without booting
Next or production auth/database initialization. Fixture results are not live
readiness evidence.
