# Metadata-only repair proposal: 100 sampled invoices

## Status

**Prepared and locally validated. Not applied, not executable and not
authorized for production writes.**

The proposal covers exactly the 100 sampled native identities across MOS shops
227–236, ten per shop. Each has complete supplied-source invoice evidence in
the requested September 18–October 17, 2026 period.

## Proposed change

Set only `normalized_work_orders.custom_fields.invoiceHours` to the exact
source-derived version, native identity, invoice date, sold hours and presented
hours in the private plan.

The plan does not change native invoice numbers/dates, job or line-item amounts,
payments, labor totals, other reporting metadata, raw payloads or financial
records. The invoice date in this reporting metadata is a derived copy of
verified native evidence, not a correction of the provider's invoice date.

All 100 identities resolve to exactly one target owner in the retained local
fleet snapshot:

- 99 targets have an absent `invoiceHours` key.
- One target has an explicit null `invoiceHours`.
- Zero are held by the local target-matching checks.

This does not establish that the live database still has those same targets,
values or ownership relationships.

## Exact bindings

Each proposed entry contains:

- Shop, provider and native source identity.
- The snapshot's hashed target-row reference.
- SHA-256 of the target's captured reporting projection.
- Whether the previous invoice field was absent or explicitly null.
- Digests of every supplied source copy and of the complete source case.
- The exact proposed single-field patch.
- Explicit `repairAuthorized: false` and `livePreflightRequired: true`.

The complete plan's canonical-JSON digest is:

`e9bdcc87b9eeca067e65eddb2ca66575886f56bb0de2ba0de6f567fe8dd0db1a`

This uses the stable canonical-JSON algorithm in the planning module, not the
byte hash of the pretty-printed file.

Private plan:
`generated-artifacts/reporting-snapshots/repair-plan100.2lE6dk/plan.json`

Source references:

- Original current-copy sample: `sample100.2EVyvd`
- Reconciled archived sources: `archive96.wn5KHB`
- Retained target snapshot: `capture.G6Umcl`

These directories are private, ignored and not deployable. Do not attach raw
source payloads or the identity-bearing plan as a public report.

## Local validation

Restored the retained database into a disposable Unix-socket-only PostgreSQL
instance. Production credentials were removed and network egress denied.
Target lookup used a read-only transaction with the existing resource guards.
No source database was contacted.

For each of 100 proposals, simulation changed only a cloned local object's
`custom_fields.invoiceHours`. Assertions verified:

- Unique same-shop/same-provider target with no competing native alias.
- Active, non-deleted closed target.
- Existing reporting evidence absent/null, never overwritten.
- Exact binding to supplied sources and target snapshot.
- All unrelated custom fields and all other captured target fields unchanged.
- No mutation of the original object.

Tests reject ambiguous/missing targets, wrong shops, deleted targets, existing
evidence, altered source copies, altered proposed hours and changed target
metadata. Absent and null previous values remain distinguishable.

Tests and TypeScript checking passed.

The source-derived local sample report reproduced:

| Sample metric | Result |
|---|---:|
| Verified eligible invoices | 100 |
| Unknown sample identities | 0 |
| Complete sold/presented coverage | 100 / 100 each |
| Sold hours | 84.36 |
| Presented hours | 264.07 |
| Average sold hours | 0.8436 |
| Average presented hours | 2.6407 |

These are **sample-only results**, not an enterprise report or proof of fleet
coverage. The simulation did not modify even the disposable database rows.

## Remaining gates before any execution

1. Read-only live preflight for precisely these identities: resolve actual target
   primary keys and all relevant aliases/owners; compare the captured reporting
   projection and retained evidence with current state. The offline snapshot
   does not contain live revision tokens or the full live row.
2. Check current ownership/financial holds and source conflicts. Zero overlap
   with the prior saved 26-parent review is not general financial clearance.
3. Confirm preservation and raw-retention fixes are deployed before repairing
   metadata, so later ingestion does not immediately undo the recovery.
4. Review canonical-store/shadow-store behavior. A PostgreSQL metadata patch
   alone is not evidence that every ingesting store will retain it.
5. Build/test an explicitly approved executor using unique target IDs,
   compare-and-set checks, bounded transactions, idempotent retry handling,
   audit outcomes and conditional rollback. No executor is included here.
6. Obtain separate execution approval bound to the finalized plan. Any changed
   target or source must be held/reviewed, not silently rebased.
7. Revalidate the pilot report after execution. The larger fleet query's
   production permissions and target-PostgreSQL-version preflight remain
   separate deployment/enablement gates.

No deployment, live read, repair, permission change or feature activation was
performed while preparing this plan.
