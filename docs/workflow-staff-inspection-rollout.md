# Staff inspection: implementation, not activation

This slice is internal manual evidence only. It does not call providers, create
tickets, publish customer reports, change job authorization, close visits or
release capacity. Legacy VIN storage, VISIT_DVI_RELEASE_ENABLED and durable push
enrollment are unchanged. Do not start the normal app in an isolated task fork:
its development Mongo credentials can reach production.

## Storage and identity

Canonical identity is shop + workflow visit. VIN and displayed RO are not keys.
The S1 binding coordinator still admits through workflow-board CAS and exact
request receipts. Pending intake blocks linking; imported conflicts require
separate reconciliation. GET reads never call intake or synchronize providers.
An interrupted initialization is recovered using its original request ID and
board revision, surfaced only to the originating authorized actor. A different
actor must not guess ownership or create another visit.

`workflow_staff_inspections` stores one version-1 document per `shop:<id>`.
Its single-document CAS atomically commits uniqueness checks for all shop-local
canonical IDs, aliases, provider GUIDs, receipts, evidence and append-only events.
This intentionally chooses a bounded pilot aggregate instead of requiring
multi-document transactions and new compound indexes. Inspections have independent
evidence/edit revisions; aggregate CAS collisions return explicit conflicts.
Bindings preserve evidence. There is no two-store atomicity claim: authorization
and the board are rechecked immediately before sinks, but a subsequent board
change may race a local commit. Reads enforce canonical identity; no automatic
reconciliation or evidence merging is performed.

Limits: 500 inspections, 5,000 receipts/events/uploads, 8 MiB serialized shop
aggregate; existing board caps remain. Audit stores accepted before/after
inspection evidence, opaque actor ID and server time, not keystrokes. The same
staff authorization protects audit and evidence. Full-state audit snapshots
consume this cap faster than result deltas. Fail closed when full; never trim
receipts, aliases or events automatically.

Retain unresolved admissions, receipts, aliases, events, results and committed
media until separately approved legal/operational archival. No TTL indexes.
No legacy migration, backfill or automatic production index creation is included.

## Trusted access and configuration

Cookie session must be verified (no development/test bypass), fresh user
membership must explicitly include the current shop, and both `shop_workflow`
and `auto_dvi` entitlements must be enabled. No platform-admin scope bypass.
Current user documents map owner→owner, admin/manager→manager,
advisor→advisor, technician/tech→technician; unknown roles deny by default.
S1 permission precedence is reused: explicit restrictions win, enterprise
governance cannot be overridden locally, technician publication stays forbidden.
Internal review is advisor/manager/owner only. All staff may document findings.

Provision `workflow_staff_inspection_config` only after operator approval:

- Standalone `_id: shop:<id>`; enterprise `_id: enterprise:<canonical enterprise id>`.
- Remaining document must pass `configurationSchema` in
  `lib/auto-dvi/staff/access.ts`: version 1, enabledShopIds, approved sheets,
  defaultSheet (`id@version`), rules, individual permission rules by opaque actor.
- Enterprise configuration is authoritative; no local fallback. Explicit
  enterprise read/edit allow is needed; individual/local grants cannot override.
- Empty enabledShopIds disables all new admissions/edits/uploads/review. Missing
  standalone configuration defaults off. For rollback **retain** configuration
  and read permission rather than deleting enterprise settings.
- Templates in `staff/model.ts` are candidates, not pre-approved production
  sheets. Approve documentation rules, required measurements and original units.
  Change version when changing a sheet; existing instances retain their snapshot.
  The configured default is installed only on explicit initialization, which
  does not start inspection work. Manual selections are never auto-replaced.
  Selecting a sheet makes previous sheets inactive unless staff explicitly keep
  them active. This slice deliberately performs no implicit equivalence reuse.

## Photos and cleanup

Internal GridFS bucket: `workflow_staff_inspection_media`. JPEG/PNG/WebP magic
bytes and MIME must agree; 4 MiB/photo, six photos/item, 60 photos/visit,
20 unresolved photo reservations/shop. Browser camera choice is reported
provenance, not verified capture time. Server upload time and actor are retained;
gallery uploads are never represented as capture on this visit.

Provision the GridFS files/chunks collections and standard indexes before a pilot:
files `{filename:1,uploadDate:1}` and unique chunks `{files_id:1,n:1}`.
The aggregate and configuration collections require their normal unique `_id`
index only. Index provisioning is an operator action, not part of application
startup or this implementation's validation.

Upload reservations commit before bytes. Exact retries bind content digest,
actor, item, visit and revision. Only committed item photo references authorize
downloads; partial/unattached bytes are inaccessible. Closure, permission
revocation or stale revision after upload leave a recoverable visible failure,
not an exposed orphan. Existing attached media is readable on closed visits.
Server media streams have 10-second deadlines; database reads use five-second
maxTimeMS and writes use majority acknowledgment with five-second write timeout.
Underlying shared driver connection/socket deadlines also apply; a timeout is
not proof of non-commit, so retry the exact request.

Operator cleanup: identify reservations older than 24 hours, stop new uploads for
that shop, wait for in-flight streams to settle, then call `abandonPhotos` with
that cutoff (at most 20 per batch). Its aggregate CAS fences attachment commits.
Delete only the returned IDs via `deleteAbandoned`, including partial chunks.
Repeat deletion of those exact IDs after at least 15 seconds to catch a finishing
stream, and retain abandoned receipt tombstones. Reattempt exact-ID cleanup after
failure; never sweep by filename/VIN or delete committed references.

## Named-shop pilot checklist (separate approval required)

1. Obtain named shop/enterprise, approving operator, roles, sheet versions,
   retention approval and rollback owner. No fleet-wide enablement.
2. Run offline suites below. Provision collections/indexes and approved settings
   in an authorized staging environment first. Verify fresh role/membership data.
3. Explicitly enable only the approved shop ID. Test repeated VIN visits,
   technician saves/reloads, advisor review, green documentation and photo access.
4. Observe 409 comparison states, 503 uncertain saves, pending binding receipts,
   capacity warnings and photo reservations. Never replay ticket creation.
5. Disable enabledShopIds to roll back edits. Keep read permissions, evidence,
   configuration, media ownership, aliases and receipts intact. GET supports
   safe read-only receipt/evidence inspection; no hidden finalization on reads.
6. Re-enabling editing or reconciling conflicting imported bindings needs
   independent operator authorization. Do not lift customer/provider gates.

## Offline verification

The test harness starts an isolated loopback mongod with temporary storage and
uses the real Mongo adapter, service and GridFS implementation. Production
network egress is denied. The browser harness substitutes only trusted session
authority and board persistence, not inspection storage/results.

```
PROTRACTOR_OFFLINE_ALLOW_LOOPBACK=true \
NODE_OPTIONS='--require ./tests/helpers/deny-network-egress.cjs --require ./scripts/_stubs/server-only-stub.cjs' \
node --import tsx --test tests/staff-inspection.test.ts tests/staff-inspection-access.test.ts tests/auto-dvi-workflow-binding.test.ts tests/shop-dispatch-intake.test.ts tests/auto-dvi-visits.test.ts tests/auto-dvi-visit-routes.test.ts

PROTRACTOR_OFFLINE_ALLOW_LOOPBACK=true \
NODE_OPTIONS='--require ./tests/helpers/deny-network-egress.cjs --require ./scripts/_stubs/server-only-stub.cjs' \
node --import tsx tests/browser/staff-inspection.smoke.ts

npx tsc --noEmit
```
