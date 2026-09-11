---
name: Protractor canary accounting
description: Safety and audit tradeoffs for fleet canaries and timed trials
---

## Production generation replacement regression

A new timed generation was observed retaining the previous bounded generation's
terminal reason and timestamp, despite a new generation ID, new clock, and zero
admissions. Do not treat a successful activation response as proof of a live gate.

**Why:** Offline tests passed, but the first production timed activation inherited
the old budget-ended marker and admitted no outbound requests. The operator stop
was restored rather than altering that generation in place.

**How to apply:** Mongo aggregation `$set` with an object-shaped assignment
merges nested fields rather than fully replacing that object. Archive before
removing old nested state, and replace within the same atomic update. Keep a
real isolated Mongo regression as well as the fake collection tests; never use
the app's Mongo connection for this test. Inspect returned activation state
before reporting a live trial.

Count physical admission at the Mongo confirmation, never from runtime logs. Do not refund an admission after a lost confirmation response or a subsequent local cancellation.

**Why:** Once confirmation commits, the caller may have dispatched even if the coordinator never receives its result. Refunding would permit more real requests than the agreed budget. Render build smoke tests also emit mocked transport telemetry.

**How to apply:** Preserve conservative accounting across retries and failures. Keep terminal causes immutable, use Mongo time at the write boundary, and keep the physical safety record outside rate-limit TTL deletion. Legacy traffic without a canary remains compatible; a completed canary never silently becomes unrestricted traffic.

Treat a timed live trial as distinct from a small request-budget canary. Its
observation clock starts at the operator's activation, not at build/deploy time,
and it deliberately tests sustained organic callbacks without a request cap.
Production pacing, breakers, and the permanent operator stop still apply.

**Why:** A three-request cap proves admission accounting, not sustained
production readiness. Build-time deadlines consumed much of the intended
observation window. Combining worker/backfill load with callback traffic would
make the result harder to interpret.

**How to apply:** Default timed trials to callback-only. The broader all-shop
scope may add authenticated foreground staff activity, but workers, backfill,
unattended sync, and enrichment remain excluded. Derive the callback replay
floor from activation and never extend or reopen a terminal generation.
Worker suspension is an operator attestation in the UI, not an independently
verified service-state check.

Foreground admission must be bound to the authenticated target shop and close
when the awaited request ends. Priority/retry flags are not proof of foreground
activity; helpers using them may also be invoked by cron jobs.

**Why:** Canned-job cache helpers can launch detached or large enrichment jobs
inside what appears to be a normal staff lookup. Merely wrapping their caller
can accidentally grant background work the staff request's permission.

**How to apply:** Audit transitive work inside every scoped helper. During a
foreground trial, serve cache or perform a bounded list fetch without enrichment
or partial-cache writes. Test real handler auth branches and detached-work
exclusion, not just source-text presence of auth and scope helpers.

Mocked provider tests must block network egress independently of mock hooks and
retain those hooks until all detached work finishes or the subprocess exits.

**Why:** A canned-cache test restored live transport after observing a detail
request start, not finish; its detached continuation then reached the real
provider with fake credentials despite the test assertions passing.

**How to apply:** Await the actual completion effect, keep mocks in place on
failure paths too, and install a transport-level network-denial guard for tests
that promise no provider requests.

Fleet trial reconciliation must include the Replit preview, not just production
web logs. A shared Mongo trial is also visible to development processes.

**Why:** Two apparent missing admissions were real dashboard-plan requests from
the preview, which used the shared production counter but defaulted to direct
transport. Production-only relay logs therefore could not account for them.

**How to apply:** Keep development Protractor traffic blocked unless explicitly
approved and configured for the required relay. Enforce relay-only trial policy
at the common admission/transport boundary, not solely with production-local
environment flags; include environment provenance in future admission audits.