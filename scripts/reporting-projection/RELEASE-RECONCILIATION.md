# Combined release reconciliation — October 22, 2026

Scope: local code, synthetic disposable PostgreSQL, credential-free release
checks. No production read/write, migration, grant, deployment or activation.

## Disposition

**Not yet approved for production installation or activation.** The two local
rollout blockers below are now corrected and tested. The documentation-only
proposal and runtime implementation are not interchangeable migrations. Do not
install the proposal's three-table prototype or run production-schema.sql as-is.

| Area | Original proposal | Merged runtime | Required disposition |
|---|---|---|---|
| Schema | invoice_reporting | reporting_invoice | Runtime name is the compatibility target for any future executable migration. |
| Tables | conceptual builds/facts/evidence | scopes, builds, sources, items, refs, reviews, change_cursors | Seven runtime tables, not the three prototype tables. |
| Operational writes | no operational triggers | statement triggers on ten existing source/hold tables | Explicitly unresolved design difference; do not install implicitly. |
| Permissions | separate least-privilege roles | restricted invalidator role; runtime role provisioning remains separate | Local test builder cannot write operational/financial/hold/review tables; production credentials and grants still require review. |
| Invalidation privilege | operational writers unchanged | Hardened SECURITY DEFINER with dedicated NOLOGIN owner | Fixed locally: owner has only scope revision/timestamp privileges; operational CRUD/TRUNCATE works without reporting grants. |
| Hold authority | existing reviewed registry | requires invoice_repair_hold_scopes, invoice_repair_holds, invoice_repair_hold_reviews | Prior read-only check found repair-control tables absent. Fresh approved prerequisite check needed; do not fabricate empty clearance. |
| Reviews | independent approved review authority | new reporting_invoice.reviews, no authoring workflow | Must establish trustworthy review population and expiry management; worker cannot approve itself. |
| Provenance | opaque references and restricted resolver | source channel/key stored in sources/refs | Restrict reads; implementation does not provide proposal's opaque-reference resolver. |
| Retention | bounded generations/pins/audit | no retention job | Estimate storage and define retention before expansion. |
| Activation | staged shadow population then read activation | independent BUILD_ENABLED and READ_ENABLED flags | Fixed locally; both default off and old combined flag activates neither. |
| Scheduling | bounded admitted operator | callable tick only | No production scheduler/service wiring is supplied. |

## Required implementation closure

1. Invalidation correction is local and tested: dedicated NOLOGIN, NOINHERIT,
   nonsuperuser owner; fixed pg_catalog/pg_temp search_path; fully qualified
   references; column-limited scope updates; PUBLIC execute revoked.
   No operational role membership or broad reporting grants are added.
   Trigger failures remain transactional: unexpected invalidation errors still
   abort the source transaction rather than silently serve stale evidence.
   Lock contention and high source-write frequency still need capacity review.
2. BUILD and READ switches are separate and tested in all four combinations.
   Shadow population keeps READ disabled. Stopping BUILD does not bypass reader
   freshness checks. First production pilot must be explicitly scoped to 227.
3. Reconcile all source/registry prerequisites and the trusted review workflow.
   Missing dependencies must block installation, not silently create empty
   substitutes. No production clearance follows from passing synthetic tests.
4. Prepare one transactional reviewed migration, separate grants, rollback and
   operator runner. Check storage, query plans, source-change frequency and
   freshness feasibility before an approved bounded source population.

## Checks

- Merged synthetic worker suite passed before reconciliation edits: disabled
  gate, actual KPI path, evidence/review expiry, holds, missing labor, fleet
  completeness, bounded source reads, concurrency, cancellation and invalidation.
- Existing ingestion evidence-preservation smoke passed.
- Replaced the failing-role diagnostic with acceptance checks: restricted
  operational INSERT/UPDATE/DELETE/TRUNCATE succeeds and increments revisions.
  The dedicated invalidator cannot mutate operational rows, reviews, holds or
  facts. Function owner and fixed search_path are asserted.
- Candidate migration is transactional with a two-second lock timeout and
  refuses pre-existing schema/role names rather than silently reusing them.
  Requires a reviewed installer allowed to create and assign this restricted
  role; production platform support has not been verified by these local tests.
- The original combined release completed its entire prebuild regression suite,
  TypeScript check and Next production build successfully. The corrected source
  also passed the updated synthetic reporting suite, TypeScript check and Next
  production build. A workspace disk-quota interruption was resolved by deleting
  only disposable release build output; the subsequent build exited zero.
- Full typecheck/build run targets a frozen isolated checkout of the merged
  application, with credentials removed and external egress denied. Its final
  corrected-source build exited zero. Documentation-only edits do not change
  the compiled application.
