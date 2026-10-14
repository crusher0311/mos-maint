# Performance report run failure — 2026-10-14

## Read-only evidence

A bounded `report_runs` lookup matched **Hours Presented** exactly:

- September 15–October 14, 2026, previous-period comparison.
- Enterprise scope, ten authorized shop IDs (227–236).
- Metrics: billed revenue, sold opportunity conversion, declined/deferred dollars,
  sold labor hours, presented labor hours, recorded labor/parts mix.
- Summary dimension (`none`), scorecard presentation.
- The stored run contained its definition but no saved-report ID/version.
- Three attempts, terminal failure at 10:40:00 UTC; stored failed stage `business`.
- Stored error: reporting database could not complete the request.

The synced PostgreSQL log feed returned no matching rows in the bounded window.
Live Better Stack logs, restricted to `mos-maintenance-mvp-main`, contained all
three worker attempts. The final business stage failed in **5 ms** with PostgreSQL's
“column dimension_facts.shop_id must appear in the GROUP BY clause or be used in
an aggregate function.” Queue acquisition took 2 ms, with almost the entire
300-second overall budget remaining. This is a deterministic SQL grouping error,
not an infrastructure timeout or the browser extension message-channel error.

## Correction and boundaries

Summary and date-only business queries now project a typed NULL shop ID.
Location/advisor queries retain the grouped shop ID. Adding shop ID to the
summary grouping would incorrectly split enterprise totals and is not the fix.
The existing per-statement and overall deadlines remain unchanged. No indexes,
schema migration, provider imports, production report reruns or production writes
were performed as part of verification.

Failures retain safe category, failed stage, retryability and a unique attempt
reference. Worker/query logs correlate the reference with allowlisted SQLSTATE
and driver routine fields; raw messages, SQL, parameters and driver detail are
not logged or returned. Deterministic query/schema/access failures stop
immediately; recognized transient failures retain the three-attempt limit.
Legacy failure records get conservative support guidance, not an invented cause.

## Verification

- `npm run test:report-runs:execution`: starts and destroys a local PostgreSQL
  cluster; executes the original failing projection to confirm SQLSTATE 42803,
  then executes the corrected real SQL with synthetic single-location and
  enterprise data. Checks totals, prior periods, summary/date/location grouping,
  refunds, scope exclusion, labor-only parity, unknown hours and coverage.
  Exercises the real worker, repository transitions and HTTP handlers with an
  in-memory persistence adapter: deterministic failure, deadlines, retry cap,
  explicit successful rerun, authorization changes and pinned-version reopening.
- Existing report-run, compiler, KPI, labor and delivery smoke suites.
- `tests/shop-dispatch-browser/reporting.html`: actual report builder with
  exclusively fictional in-browser API responses, using the existing offline
  fixture server. `reporting.cjs` checks pinned reopening, visible failure detail,
  refresh and report-selection isolation.
- TypeScript check.

The exact production report was **not rerun**. Production labor-stage performance
and totals for that run therefore remain unverified; the demonstrated business
query failure is reproduced and corrected in isolation. An authorized operator
may rerun after the fix is merged and released, keeping the support reference if
any later stage fails. No database rollout is required by this fix.
