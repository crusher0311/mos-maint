# Invoice repair release preparation — read-only findings

## Frozen source, not an approved deployment

Local reference: `release/invoice-repair-validated-20261020`

Validated source: `b03d97e4` (full commit available from the local reference).
This excludes the subsequently merged Protractor confirmation research.
The reference was created locally only: no branch push, deployment, settings
change, worker resume, control-schema installation or repair was performed.

The prior validation covered the local native repair/entry tests, replica
failure fixtures, typecheck, regression checks (including the corrected
slow-query check), and successful Next production compilation. These results
apply to the frozen source, not to a future selective backport.

**This is not yet a deployable narrow release.** Relative to the live web image
it contains 165 commits and 433 changed files, including unrelated DVI and
export functionality. Do not promote the entire reference as a reporting-only
release. The next packaging operation must isolate the reporting/preservation/
fencing dependency closure against the appropriate pinned service baseline and
validate that assembled result. Copying only the new entry-point files would
omit mandatory reader/writer protection.

## Live service metadata observed

| Service | Branch | Deployed revision | State |
| --- | --- | --- | --- |
| mos-tools | main | 77310a41 | Active |
| mos-protractor-callback-worker | main | 77310a41 | Active |
| mos-maint-background-v2 | release/invoice-background-20261019 | 8d190f07 | Suspended |
| backfill-drain-worker | release/invoice-background-20261019 | 8d190f07 | Suspended |
| MOS Tools QA | qa | 3e3bc506 | Active |
| mos-tools-east | main | 5547b4ff | Suspended |
| daily-grace-check | main | 5547b4ff | Suspended |

All seven report auto-deploy enabled. Repository enumeration therefore finds
more services than the four primary production processes. The current writer
verifier considers same-repository web/worker/cron services: QA and legacy
services must be explicitly accounted for before a reviewed writer manifest
can be accepted. Do not reactivate or deploy retired services merely to satisfy
that inventory. Their actual data-target scope and resume policy remain
unverified here.

Render metadata establishes the deployed image, not fresh runtime attestation.
Neither that attestation nor complete financial-hold coverage was established.

## Catalog-only database checks

The PostgreSQL endpoint was resolved from the web service's shared settings and
service overrides, then matched against the known production endpoint.
Queries ran with transaction-read-only enforced, one connection and bounded
statement/lock timeouts. Mongo target checks used only collection metadata.
No invoice payload was fetched and no Protractor request was made.

- All **11** prepared repair-control tables are absent.
- Mongo's `invoice_repair_installation` collection is absent.
- There is no paired installation binding.
- The application role reports public-schema CREATE and canonical-table
  SELECT/UPDATE privileges. Privilege availability is not installation consent.
- Both `INVOICE_FLEET_STREAM_ENABLED` and
  `INVOICE_FLEET_AGGREGATION_ENABLED` are off.
- The old 100-invoice evidence plan was **not** revalidated or reapproved.

A sanitized evidence snapshot is retained privately under
`generated-artifacts/reporting-snapshots/release-readiness.Que97A`.
It contains no connection strings, passwords, installation keys or raw invoices.

## Required order before any repair

1. Assemble and validate the narrow service-compatible release. Preserve
   suspended worker branches and older-release policy boundaries.
2. Obtain deployment approval and verify the exact deployed/runtime revisions;
   code deployment must not itself install the control schema.
3. Review all relevant service/data-target bindings and safely drain admissions.
4. Obtain separate approval for the control schema and paired installation.
   The prepared SQL file must never run automatically during build/deploy.
5. Establish reviewed hold coverage and fresh complete evidence, including
   archives and financial children. Retain all holds and conflicts.
6. Obtain action/plan/evidence-bound approval for a bounded repair, then verify
   its durable outcomes before enabling the reporting mode.

No production execution approval is implied by this document.
