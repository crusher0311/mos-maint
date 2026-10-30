# Babes Auto: same-account recovery review

## Decision — HOLD, not approved for execution

Prepared 2026-10-30. Scope: MOS shop **499**, same Protractor account, not a
migration. The operator's confirmation establishes intent; it does not recover
the historical account identity. No identity can be derived from the retained
credential-pair fingerprint alone.

The proposed change is **one metadata field only**, subject to the proof and
approval gates below. There is no recovery writer in this change. Do not run
the settings test/connect endpoints as part of this review: they contact the
provider. Do not disconnect again, delete data, clear locks, register callbacks,
rotate credentials, enable processing, deploy, or apply this proposal.

## Read-only evidence obtained

Reads ran approximately 18:36:04–18:36:50 UTC on 2026-10-30, using direct database
drivers, not application initialization, repositories that can write, or provider
clients. Mongo reads used a single connection, no retries, 2–3 second server
budgets and limits of 2 (3 for shop/snapshot ambiguity checks). PostgreSQL used
the external `SUPABASE_PROD_DATABASE_URL`, one connection,
`default_transaction_read_only=on`, 2-second statement and 500ms lock timeouts.
No credential, connection ID, callback token, customer record, or raw payload
was printed or retained in this document. No production writes or provider
requests were made.

### Mongo: `mos-maintenance-mvp`

- Numeric and string shop ID representations were checked together. Exactly one
  shop matched; its `shopId` is numeric, provider is `protractor`, and configured
  is false.
- Credential generation exists; account binding does not. Top-level and nested
  credential values are absent/empty. A sync revision exists. Initial state is
  `pending`; backfill-complete flag is absent.
- No checkpoint-write-token property was present at the read instant. This is
  **not** proof that every writer has stopped.
- One `backfill_progress` record: `completed:false`; sampled `inProgress`,
  current chunk start/end and lock-owner fields absent; no sampled lease.
  Preserve the entire document, including fields not summarized here.
- One webhook subscription record exists. The projected connection ID,
  `active`, and `verifiedAt` fields were absent; the record alone does not
  establish historical account identity or current callback delivery.
- Bounded `shopId in [499,"499"]` samples returned no matches in
  `protractor_work_orders`, `protractor_invoices`, `protractor_invoice_cache`,
  `protractor_service_items`, `normalized_work_orders`, `job_index`, or
  `protractor_deferred_work`.
- The callback-events read failed/timed out. Index inspection showed no
  shop-leading index. No unbounded scan or index creation was attempted.
  Callback evidence remains **unknown**, not empty.

### External PostgreSQL

Schema discovery and bounded `shop_id=499 LIMIT 2` reads returned no matches in:

- `normalized_work_orders`, `normalized_service_jobs`, `job_index`;
- `protractor_work_orders`, `protractor_invoices`, `protractor_invoice_cache`,
  `protractor_vehicles`, `protractor_service_items`;
- `protractor_canned_jobs`, `protractor_canned_jobs_cache`, `protractor_ro_cache`,
  `protractor_template_cache`;
- `protractor_callback_events`, `protractor_deferred_work`,
  `protractor_backfill_progress`, `protractor_webhook_subscriptions`;
- `protractor_normalization_retries`, `protractor_normalization_retry_health`.

`public.shops` was not returned by the scoped column discovery. This does not
authorize falling back to Mongo for a deployed PG-canonical identity path.

The separate `protractor_export` schema exposes `configs`, `states`, `hashes`,
`history`, and `health`. Bounded `doc->>'shopId'='499'` reads were unavailable
or timed out in all five. Export ownership is **unknown**. Do not treat missing
public-table samples as evidence about this restricted schema.

These are samples of known ownership keys, not a complete inventory. They do
not cover unassigned callbacks, differently associated records, archives,
partner mappings, alternate deployed targets, or every derived-data store.
They must never justify clearing a binding or resetting history.

## Follow-up bounded read-only review — 2026-10-30, approximately 19:03–19:06 UTC

The decision remains **HOLD**. Existing credentials were consumed only in isolated
runtime memory for Render control-plane GETs and direct Mongo/PostgreSQL drivers.
No application modules were initialized. No production mutation, provider request,
log scan, credential display, deployment, or repair occurred. PostgreSQL sessions
reported read-only mode; statements had 2-second budgets and 500ms lock timeouts.
Mongo used one connection, no read/write retries, 2-second operation budgets and
bounded indexed document reads. Errors were reduced to codes.

### Render evidence, including linked environment groups

- The production web service and dedicated callback worker both reported a live
  deploy at commit `ff1d065692ef83c6bee3809a1f1df600a3030366`. Their deploy finish
  times were 18:58:56Z and 18:50:31Z respectively. Both were not suspended.
- The backfill-drain, export, and legacy background worker services were
  suspended. This is service configuration evidence, not proof that every
  previously outstanding operation has settled.
- Service-local variables and linked environment groups were read. Web had two
  linked groups; callback worker had one. The web groups had no differing
  overlapping database/canonical/export configuration values.
- For web and callback worker, `IDENTITY_PG_CANONICAL`,
  `PROTRACTOR_OPS_PG_CANONICAL`, `PROTRACTOR_CACHE_PG_CANONICAL`,
  `WRITE_MONGO_PROTRACTOR_OPS`, `WRITE_MONGO_PROTRACTOR_CACHE`, and
  `CRON_LOCK_PG_CANONICAL` were unset in the observed combined configuration.
  Their repository defaults retain Mongo identity/Protractor ops/cache and
  Mongo scheduler-lock routing. Normalized ingestion is already PG canonical
  in code, independently of an imagined normalized-canonical flag;
  `WRITE_MONGO_NORMALIZED` was unset, which leaves its Mongo shadow enabled.
- Web and callback worker inherited Mongo credentials matching the read runtime
  and no Mongo database override. The selected ordinary PostgreSQL URL matched
  the prior external production target. These comparisons returned booleans
  only. Render configuration is not an attestation of every running replica's
  loaded environment or all process-local work.
- Web exports were disabled (`PROTRACTOR_EXPORTS_ENABLED=0`). The callback worker
  enable flag was true. A dedicated restricted export URL/role was inherited
  by web and the suspended export worker, even though it was absent from the
  workspace environment. Thus workspace-only secret availability did not
  establish the deployed export target.

### Corrected schema interpretation and retained-identity checks

- An indexed numeric/string shop lookup again found exactly one shop: numeric
  ID, configured false, retained generation, no usable stored credentials or
  account binding, and no checkpoint-write-token property. No target binding
  was derived. Indexed backfill sampling again found one incomplete record;
  the projected in-progress/owner/lease/activity fields were absent.
- **Correction to the earlier subscription interpretation:** the repository
  records token, callback URL, registration mode and first/last ensured
  timestamps. It does not write the previously projected connection ID,
  `active`, or `verifiedAt` fields. Their absence is not failed verification or
  historical identity evidence. The live Mongo subscription collection had
  only its `_id` index; no new shop-filter scan was attempted.
- Mongo admin audit is keyed logically by `targetShopId`, not `shopId`, but its
  live indexes lead with `_id`, creation time, or admin email. Legacy audit had
  only `_id`. Neither had an ownership-leading index, so no broad audit scan
  was attempted. External PG admin audit did have a target-shop-leading index;
  an exact target-shop read with limit 3 returned no rows.
- Scoped backup/archive collection-name metadata discovery returned no
  candidates. This was not a search of Atlas backup retention, external
  archives, or every possible audit store; those remain unknown.
- The live Mongo callback indexes lead with `_id`, object identity, received
  time, or method, not shop or historical account. No callback scan was
  repeated. Without trusted prior linkage, callback history remains unknown.

### Restricted exports and leases

- A direct read-only connection to the actual inherited export target
  succeeded. Schema usage was available, authenticated/session roles matched,
  and the role was neither superuser nor RLS-bypassing. This is not a complete
  revalidation of every runtime role restriction.
- **Correction to earlier export queries:** configs use enterprise ID and
  `shopIds` (plural); states use enterprise/revision/shop composite identity;
  hashes use state/entity keys; receipts use delivery IDs; health uses
  `id='worker'`. A uniform `doc->>'shopId'` query is not valid ownership
  discovery across these stores. Live primary and expression indexes matched
  those key shapes, including enterprise/revision-leading state ownership.
- The exact worker-health key returned no row. The shop projection had no
  enterprise linkage. No shop-specific config/state/pending/receipt assertion
  can therefore be made from these checks; no unrestricted config/history
  scan was attempted and no payload or encrypted secret was read out.
- Exact Mongo scheduler-lock keys for the eight repository Protractor jobs in
  database `mos` returned no rows. An exact PG provider drain-lease read also
  returned no row. One initial PG lease projection used a nonexistent column
  and failed; the corrected projection used the repository's `owner` column.
  Neither empty result proves process termination, callback admission
  settlement, absence of a legacy Mongo drain lease, or completion of an
  outstanding database operation. The callback worker remains enabled/live.

### Stop condition and smallest next evidence

No trusted historical shop-to-account proof was recovered. Do not repeat
unindexed callback/audit scans or infer identity from current credentials,
business name, or the guard screenshot. The smallest next step is for the
operator to identify **one pre-disconnect backup/audit evidence source and
timestamp** through a restricted channel, allowing an exact shop-record lookup
and independent account/location corroboration. Alternatively, securely
available original credentials may be compared against the retained generation
with only a match boolean returned. Any enterprise/export linkage must also
come from a trusted ownership source before keyed pending/receipt reads.
Worker settlement and fresh snapshot approval remain separate unmet gates.
The earlier pinned digests have not been refreshed or approved by this review.

## Canonical ownership gates still open

| Domain | Code path / expected store | Required proof before approval |
| --- | --- | --- |
| Connection metadata | `lib/integrations/protractor/shop-record.ts`; onboarding currently targets Mongo shops directly | Verify the deployed version and database target, unique shop representation, and any identity mirror/canonical routing. |
| History/cache | Cache repositories; `PROTRACTOR_CACHE_PG_CANONICAL`; normalized and job-index routing | Capture deployed flags and database targets for every relevant replica, plus shadow-write modes and legacy writers. Workspace flags are not production proof. |
| Progress/deferred/callbacks/subscriptions | `lib/data/repositories/protractor-*`; `PROTRACTOR_OPS_PG_CANONICAL` | Resolve Mongo/PG discrepancy, callback backlog and unassigned events using trusted historical linkage, without scanning the whole feed. |
| Callback routing | `app/api/callbacks/protractor/route.ts` resolves stored connection IDs | Prove historical registration ownership and unique account-to-shop mapping. A callback payload's claimed ID or a subscription's existence alone is insufficient. |
| Exports | `lib/protractor-exports/pg-connection.ts`, `pg-store.ts`, `store.ts` | Authorized restricted read of configuration, state, engine leases, pending delivery and receipts for this shop; confirm actual deployed export database. |
| Workers | Initial-sync fence, progress leases, provider drain, scheduler and legacy ingestion | Named process/replica owners and their stopped/drained status; no outstanding Mongo or PG checkpoint operations, retry work, callback work or exports. |

The scheduler can use Mongo database **`mos`** for cron bookkeeping, or PG when
its canonical flag is enabled. Application database reads do not inspect those
leases. No scheduler/process inventory or DB-operation settlement proof was
obtained here. Even a successful lease read would not establish process
termination. Do not clear a mutex or lease based on age, missing heartbeat,
empty samples, or the absence of a shop-level token.

## Specific identity proof required

Provide one of these through a restricted operator evidence channel, **not chat,
logs, source control, or this document**:

1. A trustworthy pre-disconnect backup/audit record linking this exact MOS shop
   record to its historical Protractor connection ID, with provenance, timestamp,
   and independent account/location corroboration; or
2. The original credential pair in an approved secure runtime, whose
   `connectionBinding(originalId, originalKey)` exactly matches the retained
   generation. Return only a match boolean and reviewed account fingerprint,
   never the credentials; or
3. A separately reviewed recovery record backed by retained provider/account
   evidence, explicitly binding shop 499 and its retained history to the
   historical connection ID, with reviewer and evidence references.

Reviewers must verify uniqueness against other shop bindings in both legacy ID
representations and relevant stores. A new working key, newly submitted ID,
matching business name, or verbal same-account confirmation is insufficient.
Do not reverse or guess the pair fingerprint. No new provider request is
authorized to obtain this proof.

Derive the candidate binding in the secure environment using the existing
`accountBinding(historicalConnectionId)` implementation in
`lib/integrations/protractor/connection-identity.ts` (SHA-256 of JSON
`["protractor-account-v1", trimmedLowercaseId]`). An independently reviewed
binding is not yet available; there is deliberately no target digest here.

## Snapshot-pinned, exact metadata proposal

These non-secret SHA-256 snapshot digests pin the observed documents:

| Mongo collection | Rows | Digest |
| --- | ---: | --- |
| shops | 1 | `cfd3ae18d256617cb21ddb873aedccb07f30575ac86274a92bdf8058d3f94789` |
| backfill_progress | 1 | `2782d67a94ab21440c3194f55257aaa68c86b3fe73e3ae1c9b8389f1c3ace9bf` |
| protractor_webhook_subscriptions | 1 | `cbdb93fc76cd668af6232f5731b073f77ca295513bb54b6b25c77aeb8680b9f8` |

Encoding: native Mongo driver `BSON.EJSON.stringify(rows,{relaxed:false})`,
rows from `{shopId:{$in:[499,"499"]}}`, sorted by `_id:1`, limit 3;
SHA-256 over the UTF-8 string. Preserve BSON types and document key order.
These are drift detectors, not account identity evidence or proof that the
three separate reads form an atomic snapshot.

After all gates close, the operator must review a final approval packet
containing the independently proven binding, exact fresh typed snapshots,
canonical-store manifest, worker settlement evidence, and reviewer approval.
Any changed digest invalidates this proposal's snapshot and requires a new
review; never automatically substitute the new values.

The exact permitted delta, **not an executable command**, is:

```text
Target: confirmed authoritative Mongo shops, unique numeric shopId 499
S: freshly re-read full BSON shop document matching approved snapshot digest
B: independently proven, explicitly approved accountBinding

Preconditions:
  no duplicate numeric/string shop record
  S.protractor is an object; configured is exactly false
  no usable top-level or nested credentials
  no accountBinding property; retained connectionGeneration and syncRevision
  no checkpointWriteToken property (null also blocks)
  canonical progress is not inProgress; no worker/DB write remains outstanding
  all cross-store ownership/identity gates and explicit write approval satisfied

Atomic predicate:
  _id = S._id
  shopId = 499 (number)
  $expr: { $eq: ["$$ROOT", { $literal: S }] }
  "protractor.checkpointWriteToken": { $exists: false }
  "protractor.accountBinding": { $exists: false }

Update:
  $set: { "protractor.accountBinding": B }
Options:
  upsert: false; acknowledged majority write; no bypass
Required result:
  matchedCount = 1 and modifiedCount = 1
```

Whole-document BSON equality intentionally fences every field, including
missing-vs-null, credential remnants, configuration, revision, disconnect
timestamps, and any new fields. Never replace this with `{shopId:499}` or a
partial fingerprint guard. If the deployed authoritative path is not this
Mongo record, stop and prepare a separately reviewed proposal for that path;
do not add an ad hoc second-store write.

Mongo CAS cannot atomically fence PG, callbacks, exports, or unfenced legacy
writers. Their externally verified quiescence must remain in effect throughout
the read/approval/write/verification window. No quiescence changes are authorized
by this document. A duplicate identity check also needs protection against
concurrent account assignment; without a controlled maintenance boundary,
do not execute.

Preserve byte-for-byte all other fields: generation, revision, configuration,
credentials, webhook token, locations, timestamps (including `updatedAt`),
initial-sync status, completion flags, history, cursors, retries, queues,
subscriptions and exports. No inserts, deletes, resets, mirror repair,
`$unset`, token regeneration, or callback registration.

If CAS matches zero, stop and re-review. If write acknowledgment is lost, do
not blindly retry: re-read and determine whether the only delta is the approved
binding. Any other difference is an incident requiring review, not permission
to widen the predicate. Rollback, if needed, is a separately approved exact-CAS
removal of only this newly added field while still quiescent; it is unsafe after
a reconnect or any other drift.

## Verification and subsequent approvals

After a separately approved application:

1. Re-read the full shop and confirm the sole change is the approved binding.
   Recheck numeric/string uniqueness and unchanged progress/subscription
   snapshots plus the approved PG/callback/export evidence.
2. Confirm the shop remains disconnected, credentials remain absent and no
   processing was activated. Metadata repair alone is not a successful
   reconnect and does not validate any key.
3. Only with separate permission, use the normal authenticated settings flow
   for credential validation/save. It makes provider requests. Confirm saved
   credential presence and binding/generation consistency through booleans,
   then reload settings. Preserve cursors; refuse active workers/mutexes.
4. Historical processing, callback registration/replay, exports, and deployment
   each remain separate decisions. Do not equate saving a connection with
   authorization to start them.

## Review outcome

The preparation is complete, but recovery is **not execution-ready**. Missing:
trusted historical account proof, deployed canonical ownership, callback/export
evidence, worker/DB-operation settlement, and an approved target binding and
fresh snapshot packet. No production correction has been performed.

References: `docs/protractor-same-account-reconnect.md`,
`lib/integrations/protractor/onboarding.ts`,
`lib/integrations/protractor/initial-sync-fence.ts`, and the onboarding safety
memory. This is a documentation-only proposal; no app/UI behavior changed.
