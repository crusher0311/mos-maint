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

1. Implement exact large-fleet processing with a justified total resource budget.
   The current merged code reports capped coverage honestly; it does not solve
   exact aggregation above the existing limit.
   An offline database-side prototype now passes the 210,000-record fixture;
   see invoice-fleet-sql-prototype.md for its tested budget and remaining
   integration, concurrency and evidence-shape requirements. It is not live code.
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
