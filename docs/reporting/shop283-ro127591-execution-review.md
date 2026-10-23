# Shop 283 / RO 127591 — operator execution review

## Decision and authorization boundary

**Prepared for review, NOT approved or ready for production execution.**
No production writes, deployment, provider calls, webhook replay, export-flag
changes, or export sends are part of this package. Operator sign-off has not
been obtained. The preparation tool is deliberately offline and cannot apply
the repair. Do not run a generic force-update script as a substitute.

The retained Invoice source is newer than the PostgreSQL
`inspection_in_progress` snapshot. Callback receipt/indexing is not evidence
of successful canonical normalization. Replaying the DVI-filtered webhook
would discard source information and repeat unrelated side effects.

### Original review evidence (not a fresh observation)

Saved plan: `generated-artifacts/reporting-snapshots/shop283-ro127591-repair.plan.json`,
prepared at `2026-10-23T16:50:51.797Z`.

| Binding | Expected |
| --- | --- |
| MOS shop / RO | 283 / 127591 |
| Canonical work-order ID | `6ada5b24eaa5818c8a3b265a` |
| Provider ID (case-insensitive comparison only) | `303b1f3b-46da-4936-b616-e84e7e96d714` |
| Target version | 3 |
| Target updated_at | `2026-10-22T21:15:39.325Z` |
| Target provider modified | `2026-10-22T15:46:41.223-04:00` |
| Source provider modified | `2026-10-22T16:49:58.31-04:00` |
| Source InvoiceTime | `2026-10-22T16:49:58.463-04:00` |
| Invoice instant in UTC | `2026-10-22T20:49:58.463Z` |
| Grand total | **536.39** |
| Source JSON SHA256 | `b29e8d809e090ad353ef128024dc6759bcce3ed4f1d5f04c8db56a700f1bdc49` |
| Target projection SHA256 | `ca1b80cdd25fe2ef9e2c5f1d2e936704325d959a8605aa5c157c2533d833dbaa` |

Any changed binding stops this plan. A newer current row is not permission
to overwrite it; prepare and review a new plan instead.

## Reproducible offline review

The saved plan exists locally but contains no full source. This task did not
substitute the nearby `*.requests.json` or Azure delivery bodies for retained
Mongo data, and did not freshly certify the production graph.

For an approved read-only evidence collection, export the **complete**
`protractor_work_orders` document for shop 283 and the provider identity above,
using numeric/string shop compatibility and case-normalized identity discovery.
Require exactly one match, including mixed-case IDs; an exact lowercase or
uppercase lookup alone cannot establish uniqueness. Use `rawPayload ?? data`.
Preserve JSON serialization order for the legacy SHA256 comparison. Never
fetch Protractor to fill gaps. If the original plan/preparer is missing,
recreate its ordered projection below in a transaction with `SET TRANSACTION
READ ONLY`, bounded statement/lock timeouts, and one connection. Mongo reads
must be bounded and must not create indexes or mutate receipts.

The exact original target projection order is:
`id, version, updated_at, provenance, raw_data, status, closed_date, completed_date`.
Query by shop and RO, requiring exactly one match and the canonical ID and
Protractor provenance above. Reproduce the original preparer's `JSON.stringify`
SHA256; do not treat this lossy projection as a native CAS token.

Keep inputs/outputs under ignored `generated-artifacts/reporting-snapshots/`,
permissions 0600 (directory 0700); do not commit customer/source data.

```sh
NODE_OPTIONS='--require ./tests/helpers/deny-network-egress.cjs' \
node --import tsx scripts/prepare-retained-invoice-review.ts \
  generated-artifacts/reporting-snapshots/shop283-ro127591-repair.plan.json \
  generated-artifacts/reporting-snapshots/shop283-ro127591.retained.json \
  generated-artifacts/reporting-snapshots/shop283-ro127591.target-projection.json \
  generated-artifacts/reporting-snapshots/shop283-ro127591.review.json
```

This rejects changed source digest/target version/evidence, wrong identities,
non-newer source, sparse package payload, dates and total mismatch. It uses the
real Protractor normalized adapter to propose parent fields and enumerate jobs,
lines, payments, inspections, recommendations, customer and vehicle.
It always reports `executionReady: false`. It does not establish that arbitrary
input files were collected from production. The operator must attest provenance.
Zero extracted entities is not proof that the database should contain zero.
Inspect collection presence and retained deferred packages explicitly.

## Required native graph review

Before approval, archive full native before-state (including `to_jsonb(row)::text`
for PostgreSQL numeric fidelity and BSON-preserving Mongo documents), not just
the small target projection. Include:

* Parent and all rows reached by canonical work_order_id; natural-key and
  provider-identity candidates even if they have another parent.
* Vehicle/customer native IDs, shop ownership and referenced snapshots.
* Service jobs, their lines, payments, inspections and recommendations, plus
  relevant normalized Mongo mirrors and any embedded parent collections.
* Existing financial holds/corrections, invoice identity/hours/labor evidence,
  audit provenance and soft-delete state.

Build a reviewed identity table from every provider child ID to the existing
canonical ID. Preserve existing IDs/created_at/provenance, reject ambiguous
natural-key matches and cross-shop references. Review genuinely missing
entities separately; never delete unexpected children to make counts match.
Compare actual content and ownership, not just counts. Map the complete source
using the real adapter; any mismatch between embedded and standalone jobs,
totals, payments or FK graph is a stop condition.

## Fenced execution protocol for the separately approved release

**Neither the normal ingestion service nor the existing metadata-only repair
executor is currently a drop-in atomic executor for this full normalization.**
The existing executor repairs invoice metadata; do not broaden its approved
financial write scope by passing this plan to it.

Choose and review one of the following before execution:

1. A dedicated maintenance normalization runner integrated with the durable
   invoice repair fence, paired-store binding, approval/hold checks, and receipts.
   It must use privileged maintenance clients only inside verified exclusion;
   ordinary guarded ingestion clients will refuse access while the fence is
   closed. This requires a separately reviewed implementation/release.
2. An explicitly approved infrastructure maintenance window that excludes
   **all** writers/readers of the affected graph for the entire operation,
   including retained-source writers and tools, and keeps them disabled across
   coordinator failure. Stopping one cron, holding a PostgreSQL row lock alone,
   or checking a version before normal ingestion is insufficient.

In either case:

1. Bind approval to source digest, native graph before/after digest, exact
   revision, data targets, actor, expiration and this one shop/RO. Establish
   reviewed hold coverage; absence of a hold table is not no-holds evidence.
2. Persist an operation receipt and unresolved maintenance state; drain durable
   admissions **before** reading final evidence. Never expire ambiguous
   admissions just because a worker died or a lease elapsed.
3. Under exclusion re-read full retained source and native target/child graph;
   require original target version, projection and source digests plus reviewed
   native equality. Stop on any drift. Maintain exclusion through verification.
4. Normalize only this source, preserving the canonical graph. Use one
   PostgreSQL transaction for its graph replacement with native before-state
   predicates (or retain verified whole-operation maintenance exclusion).
   Never put the ordinary ingestion call on a second connection while assuming
   a coordinator transaction makes it atomic.
5. No provider lookup/enrichment, callback handling, job-index rebuild, repair
   pattern update, automatic audit receipt, export or background scheduling.
   If reusing ingestion internals, explicitly disable `dualWriteToJobIndex`,
   `dualWriteToRepairPatterns`, `createAuditLog`, and
   `suppressAutomaticAuditReceipt: true`; keep canonical PostgreSQL writes
   enabled. These options alone are **not** sufficient fencing or identity
   protection. Review Mongo shadow behavior rather than changing global flags.
6. Inspect **every** result including vehicle/customer writes and each child,
   not only the parent `success`. Normal ingestion can swallow shadow failures,
   return child errors, and commit parent before children. Such an outcome is
   unresolved, not completed.
7. Persist verification receipt under the same exclusion. Release only after
   the complete post-state is proven. Lost responses/partial writes retain the
   fence; inspect receipts and archived state, never blindly retry.
8. Rollback requires separate approval bound to exact post-state and original
   native snapshots, with the same fence. Do not decrement a version or restore
   an old parent while leaving new children in place.

## Guard interaction and writer inventory

Repository inspection (not deployed-runtime proof):

| Path | Guard/behavior | Required release verification |
| --- | --- | --- |
| Callback normalization/drain | `NormalizedIngestionService` wraps ingest/replay in `databaseFence().run` | Inspect actual callback worker revision and pending deliveries; preserve queue state |
| Poll / incremental cron | same ingestion service; PG and Mongo driver guards | Stop/drain active cron and web workers, not just scheduler triggers |
| History/backfill/weekend/standalone tools | service plus guarded driver imports; see inventory test | Account for suspended workers and tools that can resume |
| Direct canonical writers/readers | `lib/db/drizzle.ts`, `lib/mongo.ts` use guarded drivers | Verify runtime target and paired installation; raw/admin clients remain operational scope |
| Source cache writers | guarded Mongo client, not merely canonical-table locking | Drain retained-source writes too; source digest must remain fixed |
| Maintenance metadata executor | dedicated native clients under its own fence | Not a full-normalization executor; no reuse by bypassing its scope checks |

`InvoiceFence.run` records durable admissions when installed; unresolved errors
remain admissions and veto maintenance. With no control schema it permits
normal work, so code presence alone proves no exclusion. The guard is
driver-wide, not just a work-order hook. A closed fence blocks ordinary reads
as well as writes. A bypass environment switch must not be added.

`tests/invoice-repair-access-inventory.test.ts` statically checks raw driver
imports across app/lib/scripts. This is useful regression coverage, not proof
that QA, legacy services, old deployed binaries or ad hoc native clients use
the same protocol. Reconcile all production writer inventory, actual deployed
and runtime revisions, same-database scope, suspended-service resume policy and
separate approval. Do not deploy/resume unrelated services to satisfy inventory.

## Post-write acceptance, while still fenced

* Exactly one shop 283 / RO 127591 parent and same canonical/provider identities.
* Terminal mapped invoice stage; closed/completed dates equal
  `2026-10-22T20:49:58.463Z`; source invoice date preserved, not callback time.
* Grand total 536.39; subtotal/tax/discount/labor/parts/sublet/fees/balance
  independently equal reviewed adapter results. Do not infer total from DVI jobs.
* Full retained source survives in `raw_data.rawPayload`; its digest matches
  the reviewed source. Source `Header.LastModifiedTime` is the newer stamp.
* Native version/provenance/content hash changes match approved after-state;
  original creation/identity/hold evidence remains intact. Recompute reporting
  evidence using the release-compatible mapper, never copy stale custom fields.
* All child identity/content/FK checks above pass, with no unexpected insert,
  deletion, orphan, duplicate, cross-shop write or change to another RO.
* Mongo source unchanged; any approved mirrors verified; exports, callbacks,
  queues and flags unchanged. Confirm no provider traffic.
* Persist before/after digests, per-entity outcomes and an authoritative receipt.
  A report showing the invoice or a 200 response alone is not completion.

## Release checklist / sign-off

- [ ] Read-only collection provenance and full graph reviewed; drift rejected.
- [ ] Narrow release built/tested against each actual service baseline.
- [ ] Explicit deployment approval (separate from repair approval).
- [ ] Actual runtime writer inventory and source-store exclusion verified.
- [ ] Control schema / paired installation separately approved if using the
      durable fence; do not install automatically.
- [ ] Full-normalization maintenance runner or infrastructure maintenance
      procedure reviewed and rehearsed with partial/unknown outcome recovery.
- [ ] Financial holds and canonical child identities reviewed.
- [ ] Exact action/evidence-bound production repair approval recorded.
- [ ] Complete post-state and receipt verified before reopening access.

Until these are satisfied, the correct operational result is **do not execute**.

## Local validation evidence

The offline review tests cover positive adapter mapping, nonempty associated
entity enumeration, canonical parent references, source/target drift, wrong
shop/provider/collection, sparse packages, non-newer timestamps and date/total
checks. `npm run typecheck` passed.

`bash tests/run-invoice-dual-store.sh` passed using disposable PostgreSQL and
Mongo replica-set instances, clean environment and a network allowlist. This
covered the existing native metadata protocol, hold coverage, drift vetoes,
lost-response recovery, approval binding and mandatory driver fencing.
It **does not** prove this full-normalization repair is atomic or approved.
No application UI or production database was started for these checks.
