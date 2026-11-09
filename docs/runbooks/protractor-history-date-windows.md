# Dedicated history worker: bounded date windows

## Authorization and state

Local investigation and testing only. No provider calls, deployment, production
writes, circuit resets or import resumption. Shop 635 remains paused following
the failed smaller-page trial.

## Evidence and unresolved contract

The retained June 5 list/detail probe reports 1,446 invoice records from a
90-day request. Its source sends `take=100&skip=0`. That contradicts treating the
record count as a reliable response-size bound. The older report's statement
that the endpoint paginates is not supported by an offset comparison.

This is retained evidence, not a fresh provider verification. A public
documentation search did not establish the endpoint's pagination or date
inclusivity contract. No credential-protected documentation or provider endpoint
was accessed. Smaller date windows are a conservative mitigation, not proof
that the integration now completes every shop's history.

## Local changes

- Only the approved dedicated-worker context gets a maximum seven-day date span.
  Other sync callers retain existing density and duration heuristics.
- Same-cursor failed/incomplete attempts shrink on a later admitted pass:
  seven days to three to one. Existing wider attempt markers are also bounded.
- Failed fleet list requests retain their checkpoint shrink marker, including
  oversized, malformed and overfull responses. Ingestion-only failures do not
  acquire this new behavior.
- One day is the minimum date span, not a promise of one business day's records:
  provider endpoint inclusivity is unverified. Adjacent requests share the
  boundary date, preferring possible idempotent overlap to skipping a date.
- Date subtraction uses UTC for this date-only request path, avoiding host
  daylight-saving arithmetic. Business-hours eligibility remains governed by
  the shop's existing America/Chicago schedule.
- Cursor advancement still requires a complete successful range; horizon
  clamping, request budgets, byte cap, circuit cooldown and physical admission
  remain unchanged. There is no retry inside a failed pass.

## Verification

Offline tests cover seven/three/one-day transitions, stale and invalid markers,
oversized and ignored-pagination responses, one-day repeated failure,
successful clearing, held cursors and adjacent ranges across DST dates, leap
day, month/year boundaries and the horizon. Canonical empty/nonempty sync
wiring is checked by source assertions; the window policy itself is executed.
This is not a full end-to-end provider ingestion simulation.

Paging/loader regressions, fleet suite (including disposable Mongo and admin
tests), resilience suite, onboarding suite (including Chromium settings tests),
TypeScript and database/route guards passed. No production build,
deployment or live trial is claimed for this change.

## Remaining limits

An oversized single-day response, or a provider response with more than the
requested 25 records, still fails closed. Do not silently ingest an overfull
response and advance the cursor until date filtering and completeness semantics
are independently established. Such a failure needs operator review, not a
larger cap or an infinite immediate retry.
