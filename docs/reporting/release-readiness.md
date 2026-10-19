# Reporting release acceptance

## Required outcome

A successful build or a clearer incomplete-data warning is not proof that the
requested fleet report is usable. Treat code-release readiness and evidence
readiness as separate gates. Do not overwrite financial values, hide uncertain
identities, or relax source checks to make an average appear.

## Verified locally

- Combined invoice-hour, owner, financial-evidence and authorization checks passed.
- The real reporting component passed offline browser checks for explicit runs,
  weighted totals, independent coverage, location selection, retained results,
  scope isolation, capped coverage and mobile layout.
- The browser runner now regenerates its population fixtures before execution;
  stale generated files previously omitted the capped case.
- Visual inspection used the offline fixture, not a signed-in production session.
- The isolated production-source candidate at commit
  `113a177e7ebc9e3edae784147bac1fbb8f78e6dd` passed the release checks and
  completed Next production compilation and all 299 static-page generations.
  The initial run stopped in the printing test because the sanitized environment
  lacked the native UUID library. After supplying only that verified library
  directory, execution resumed at that failed test, completed the remaining
  smoke checks, and completed `next build` with exit code 0.
  Credentials were excluded and external network access remained denied.
  The browser-fixture refresh change was separately verified after this candidate
  was captured; it changes the test runner, not production application code.

## Still required

**Fresh real-data validation is blocked:** the guarded query exceeds its 64 MB
temporary-file limit on the refreshed local snapshot, despite passing synthetic
fixtures. The 215,655-record capture is preserved for offline optimization.
Independent location calculations still cannot establish invoice averages for
the requested period. See stored-snapshot-refresh-2026-10-19.md. Production
permission alone is not sufficient to enable reporting.

**Production preflight found blockers after the initial local checks passed:**
the reporting role cannot set temp_file_limit, and the earlier SQL failed against
the production enum. The enum comparison is now fixed locally and the large
disposable fixture uses the application's real enum, reproducing the old failure
and validating the fix. The permission blocker remains. See
invoice-fleet-production-preflight.md and invoice-fleet-database-setup-proposal.md.
Do not enable the feature yet.

The enum follow-up passed nine disposable PostgreSQL tests (including the actual
enum and narrow grant/revoke behavior), the invoice service/summary/location
suite, and TypeScript. These were local checks; production access was not used.

1. Complete release validation and an approved production preflight for the new
   opt-in database aggregation. It is now integrated into the reporting service,
   with default-off activation, global admission, read-only transactions and
   resource limits. Local service/compiler and disposable PostgreSQL tests pass.
   No production setting has been enabled. See invoice-fleet-integration.md.
   The final updated production compilation passed (exit code 0), along with
   TypeScript, the reporting service/compiler suite, the eight-test disposable
   PostgreSQL suite, and offline desktop/mobile reporting browser checks.
   The signed-in production UI and real fleet results were not verified.
2. Establish the authoritative evidence and accounting rules still missing from
   the retained-source review. Nine financial conflicts remain held. See
   invoice-owner-financial-corroboration-approval.md; plan approval is not
   approval of any amount or a repair.
3. Validate the requested period against one consistent, local full-fleet
   snapshot after evidence issues are addressed. The previous snapshot's
   209,276 unknown identities is not a current live count, and its unavailable
   averages must not be described as verified results.
4. Obtain separate approval for any production repair and release. The ongoing
   backfill's independent runner rollout does not publish reporting changes.

No production schema change, provider call, accounting rewrite, or deployment is
authorized by this readiness check.
