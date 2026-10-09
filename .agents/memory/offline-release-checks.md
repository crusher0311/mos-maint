---
name: Offline release checks
description: Interpreting elapsed-time failures and non-exiting smoke tests during release verification.
---

Managed standalone artifact previews can fail after an otherwise successful
root post-merge setup because their dependency graphs are independent. Verify
each artifact's installation and build separately from the main application.

**Why:** Root setup reported success while both managed previews lacked Vite.
A working development preview also did not establish that its standalone
production bundle could complete.

**How to apply:** Keep setup scoped to locked artifact dependencies, wait for
Next cache cleanup before typechecking, and report an unfinished artifact build
separately rather than conflating it with the production application's tests.

A smoke test's success message is not proof that its process exits cleanly. Keep an outer timeout and verify the process exit, especially for tests importing provider clients with timers.

**Why:** A JWT admission test finished its assertions but remained alive until the release command timed out, preventing later checks from running.

Short real-time deadlines in local relay tests can expire before the intended dispatch stage on a busy workspace. Distinguish a scheduling-dependent assertion failure from a changed production deadline policy.

**Why:** Under workspace load, a queued-expiry test received an ingress-expiry response instead, and an active-response test expired before its upstream saw a request.

**How to apply:** Inspect the failing stage and test timing. Keep network isolation and credentials removed. Repair test coordination/cleanup rather than relaxing production admission or deadline enforcement; never report an assertion banner alone as a completed suite.

Extension DOM tests with mocked successful background replies do not validate the
real message handler.

**Why:** The floating-launcher regression passed mocked UI coverage while the
shared settings handler rejected successful responses. Its separate handler
test also had a stale extraction delimiter.

**How to apply:** Exercise both the real handler and browser lifecycle before
packaging. Assert source-extraction boundaries explicitly; don't weaken hidden
preferences to compensate for a broken settings transport.

Isolated release worktrees sharing workspace node_modules can fail native canvas
loading on missing Nix libraries even when Render's build environment passes.

**Why:** The full smoke suite stopped on missing libuuid.so.1 locally; Render
subsequently completed the full build with the same release source.

**How to apply:** Separate environment failures from assertion failures. Preserve
network isolation, do not weaken tests, and require Render's successful build and
live commit verification before reporting a release as deployed.
