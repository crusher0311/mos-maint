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