# Disposable invoice repair failover evidence

Run `bash tests/run-invoice-dual-store.sh`. Requires local `mongod`, PostgreSQL
tools, Node and installed project dependencies. No containers or live databases.

## Isolation

The runner re-execs with an empty environment, preserving only PATH/HOME and its
clean-run sentinel. It creates a random PostgreSQL Unix-socket directory and
three loopback MongoDB members, each with its own temporary data directory.
Mongo uses the `invoice_disposable` replica set and test commands only here.
The Node preload permits only that exact PostgreSQL socket and the three
allocated `127.0.0.1` ports. HTTP, HTTPS, fetch, TLS, DNS and UDP are denied.
Wrong ports, alternate loopback addresses, hostnames and other Unix sockets
are explicitly checked. Child crash tests inherit the same guard and clean
environment. No production app workflow is started. Exit cleanup stops every
member and PostgreSQL and removes temporary data, even on test failure/timeout.

## Controlled failures

Both apply and rollback use three invoice cases. Case zero completes, case one
is interrupted, and case two must remain unattempted. Driver retryable writes
are disabled in replica mode, so a transparent retry cannot hide an outcome.

* **Before shadow CAS:** MongoDB `failCommand` blocks an actual update command
  before execution. `waitForFailPoint` proves the command arrived before the
  harness SIGKILLs that primary. This is not a sleep-based guess.
* **After majority acknowledgment:** the actual CAS writes metadata and receipt
  together with `w: majority`. The driver confirms one changed document, then
  the harness SIGKILLs the primary and throws instead of delivering that result
  to the coordinator. This is an application-boundary lost acknowledgment,
  **not** a wire-level lost Mongo reply.

In each scenario a different member must become primary. Fresh store clients
inspect persisted state. The original member is restarted and all three
members must reach primary/secondary state with matching optimes before another
fault. Failpoints are single-use and disappear with the killed process.

## Observed guarantees in this harness

The four apply/rollback × before/after scenarios pass with MongoDB 7.0.16 and
PostgreSQL 16.10:

* Canonical changes persist while the durable unresolved-operation fence stays
  set. Shadow changes are absent for the blocked command and survive election
  for the majority-acknowledged command, including its exact receipt.
* Expired authorization rejects execution without changing inspected state;
  inspection remains available. Expiry never clears the fence.
* Matching metadata with a missing receipt, wrong operation ID or wrong binding
  cannot complete recovery or clear the fence.
* Intervening financial edits during interrupted rollback are preserved and
  cause recovery to reject. The test explicitly restores its fixture afterward
  to test successful recovery; restoration is not an operator recovery policy.
* The guarded report callback never runs while any case is unresolved, despite
  a completed prefix. Retrying validates that prefix, recovers the exact case,
  then processes the untouched suffix. Repeating the completed operation does
  not increment revisions again. Only then may the guarded callback run.

Existing real-store CAS, absent/null, process-exit, holds, alias, concurrent
execution and 100-case partial-plan regressions also run on this replica set.

## Limits — no distributed atomicity claim

PostgreSQL and MongoDB still do not share a transaction. Intermediate states
exist; safety depends on every reader and writer honoring the coordinator.
The report assertion covers that local guarded callback, not production routes,
exports, streaming responses, or noncooperating writers.

These tests do not establish behavior for a write applied locally but lost
before majority acknowledgment, rollback of uncommitted oplog entries, a
majority/network partition, simultaneous voter loss, disk/power failure,
journal corruption, or PostgreSQL failover. Nor do they inject the exact
wire-level interval between Mongo execution and its reply. Such outcomes must
remain unknown until inspected; matching values alone are not evidence of
receipt ownership. Local SIGKILL/election evidence does not authorize production
repair, deployment, credential access, or changes to live writer quiescence.
