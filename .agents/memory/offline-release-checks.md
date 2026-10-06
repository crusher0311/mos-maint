---
name: Offline release checks
description: Interpreting elapsed-time failures and non-exiting smoke tests during release verification.
---

A smoke test's success message is not proof that its process exits cleanly. Keep an outer timeout and verify the process exit, especially for tests importing provider clients with timers.

**Why:** A JWT admission test finished its assertions but remained alive until the release command timed out, preventing later checks from running.

Short real-time deadlines in local relay tests can expire before the intended dispatch stage on a busy workspace. Distinguish a scheduling-dependent assertion failure from a changed production deadline policy.

**Why:** Under workspace load, a queued-expiry test received an ingress-expiry response instead, and an active-response test expired before its upstream saw a request.

**How to apply:** Inspect the failing stage and test timing. Keep network isolation and credentials removed. Repair test coordination/cleanup rather than relaxing production admission or deadline enforcement; never report an assertion banner alone as a completed suite.
