## Production generation replacement regression

A new timed generation was observed retaining the previous bounded generation's
terminal reason and timestamp, despite a new generation ID, new clock, and zero
admissions. Do not treat a successful activation response as proof of a live gate.

**Why:** Offline tests passed, but the first production timed activation inherited
the old budget-ended marker and admitted no outbound requests. The operator stop
was restored rather than altering that generation in place.

**How to apply:** Verify full replacement of nested state under actual Mongo
aggregation semantics, not only a fake collection's assignment behavior. Test
activation from a terminal bounded generation and inspect the returned current
generation for stale terminal fields before reporting a live trial.

---
name: Protractor canary accounting
description: Safety and audit tradeoffs for bounded fleet canaries
---

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

**How to apply:** Keep timed trials callback-only and workers/backfill off,
derive the replay floor from activation, and never silently extend or reopen a
terminal generation. Worker suspension is an operator attestation in the UI,
not an independently verified service-state check.