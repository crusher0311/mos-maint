---
name: Protractor relay breaker ownership
description: Durable concurrency and emergency-stop requirements for safely reopening relayed provider traffic.
---

Breaker feedback for a completed physical provider request must be persisted
before another request can claim a recovery probe. Keep the provider-wide
transport lease through feedback and renew it while work is active, or carry an
opaque probe claim and mutate recovery state only when that claim still owns it.
Never rely on an unowned `probeUntil` marker.

**Why:** A response can return before its breaker update finishes. If the
physical lease is released first, another request can claim the probe and the
older response can consume, clear, or renew the newer request's recovery state.
A fixed-duration lease has the same race when a slow transport plus persistence
outlives the lease.

**How to apply:** Serialize every REST and SOAP outcome, including synthetic
transport classes, under one renewable fleet lease through breaker persistence.
Race-test stale success and failure feedback, delayed persistence, lease
renewal, and release ordering.

A bounded production canary also needs a verified stop path independent of a
configuration deployment. If that path suspends the shared web service, obtain
explicit rollout-owner acceptance of the possible full-site outage and prohibit
resume until the disabling deployment is live and zero provider traffic is
verified.

**Why:** A configuration rollback can take a full deployment window, while the
relay host may be unreachable for direct containment.

**How to apply:** Keep workers and historical backfill off, begin the disabling
deployment immediately after enabling traffic, confirm emergency suspension
actually took effect, and resume only after all dark-mode gates are verified.

Do not treat a monitoring/control-plane timeout as evidence that provider
containment failed. Full-service suspension must require an observed provider
safety violation, such as continued physical admissions after a stop signal.

**Why:** A canary controller's Render log request timed out and its generic
error handler suspended the shared web service. Suspension canceled the dark
deployment, and each resume temporarily reactivated the enabled process while a
replacement deployment built.

**How to apply:** Keep telemetry failures fail-safe for the canary decision but
separate from the full-service emergency action. If the service is already
suspended, use a production-context one-off job to open the actual provider
breaker, disable autodeploy, resume, and activate the built image with
`deployMode: "deploy_only"`. Verify zero new physical admissions before trusting
the recovery. Local Mongo credentials may target a different cluster or
environment-group context than the Render service.

An operator stop and the final physical admission must serialize on the same
fleet lease document. Lease claim and final dispatch confirmation both reject
an active stop; activation updates that document, while ordinary breaker
feedback remains in separate state. Clearing requires the current stop
generation so a stale operator action cannot remove a newer stop.

**Why:** A separate stop document or a final read before dispatch leaves a
time-of-check/time-of-use window where another replica can activate the stop
after the read but before the provider call starts. Reusing a new lease key
during rollout also splits old and new replicas into independent pacers.

**How to apply:** Preserve the established fleet lease key across deployments.
Make dispatch confirmation the atomic admission point, keep stop activation on
that exact record, and treat an admission that linearized first as already in
flight. Never let response telemetry, breaker cooldowns, or recovery probes
write operator-stop fields.