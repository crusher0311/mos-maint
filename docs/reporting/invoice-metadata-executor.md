# Invoice metadata executor: offline contract and live stop gates

## Delivered boundary

This is an **offline-only executable protocol**, not permission or tooling to
repair production. There is no live CLI, database URL option, environment
credential loader, provider client, deployment, migration or automatic ingest
hook. The only physical adapter accepts a guarded disposable Unix-socket
PostgreSQL database, verifies its disposable marker and rejects TCP targets.

Run:

```sh
npm run test:invoice-metadata-executor
npm run test:invoice-metadata-plan
npm run test:invoice-evidence-local
npm run typecheck
```

The executor suite launches a new database with no TCP listener, starts Node
with an empty environment apart from runtime paths and its fixture socket, and
denies TCP (including loopback), HTTP, TLS, DNS and UDP. It destroys the database
on exit. Fixtures are invented; the private 100-invoice plan and payloads are
not copied into tests. Do not start the application to run these tests.

## Original proposal and finalized authorization

`finalizeOfflinePlan` takes the **entire original proposal object**, its expected
canonical-JSON digest, and separately supplied writer verification. It does not
hash just the proposals array. The retained proposal's expected digest remains:

`e9bdcc87b9eeca067e65eddb2ca66575886f56bb0de2ba0de6f567fe8dd0db1a`

Its existing `repairAuthorized:false` and `livePreflightRequired:true` flags
remain unchanged. The executor rejects held entries, repeated identities,
repeated targets, more than 100 entries, missing/competing owners, and any source
or target mismatch. It recomputes the existing proposal with the shared planning
module and the shared invoice-evidence generator. Source copy/case hashes,
explicit null versus absent, aliases, status, deletion and the original
reporting projection are therefore still bound. The resolved canonical primary
key must hash to the original snapshot reference using SHA-256 of `shop:id`.

The read-only repeatable-read preflight adds full canonical and shadow row
states, monotonic revision tokens, keys, complete retained-evidence inventory,
hold evidence, and writer verification. Adapters must include **every relevant
alias owner**, not just the record returned first. The fixture adapter also
discovers same-shop native aliases placed under a different grouping key.

The finalized plan digest covers all of that state plus the original proposal
and five-minute validity window. Separate `Approval` input must name:

- The finalized plan digest and preflight digest.
- The action (`apply` or `rollback`).
- Operator and approval reference.
- Approval time after preflight and an unexpired deadline.

The module does not manufacture approval. Fixture operator strings are only
synthetic test inputs, not cryptographic operator authentication. It cannot be
used as a live authorization service.

## Mutation, receipts and recovery

One canonical/shadow owner pair is processed per bounded transaction. The
disposable adapter sets a three-second statement limit, one-second lock limit
and five-second idle-in-transaction limit. It locks fixture ownership, sources,
holds and receipts against concurrent changes, including phantom owner inserts.
This is deliberately stronger than locking only the chosen row.

The SQL mutation addresses only `custom_fields.invoiceHours`; the fixture's
revision token also advances. No native number/date, payload, financial field,
job, line or payment is assigned by repair SQL. A full-state comparison precedes
the update, SQL CAS compares both full rows and revisions, and readback verifies
the exact expected pair. Unrelated custom fields must remain identical.

Both rows, the deterministic `planDigest:index` receipt and success audit commit
together. Concurrent retries find the same receipt. A lost COMMIT acknowledgment
is **not** assumed to mean rollback: retry verifies the receipt and exact
post-state before returning `already_applied`. A matching field without a
receipt is never treated as proof that this executor wrote it.

An injected failure after the canonical update rolls back both stores and the
receipt. If entry N fails, previously committed entries remain committed and
N+1 is not attempted. Retry acknowledges earlier receipts and proceeds only
where exact original bindings still hold. It never rereads new state into an
old approval.

Success audits and receipts are durable and atomic. Failures are separately
audited as `rejected_or_unknown`, not falsely labeled rolled back. Audit events
contain plan digest, entry index, action, approval reference and outcome, not
payloads or raw exception messages. A failure to persist an audit also rejects
the call; receipts remain the authority.

`inspectOfflineOutcomes` is read-only and works after approval expiry. It reports
committed state and whether the current pair still matches, allowing ambiguous
responses to be inspected without extending write permission. Expired approval
does not permit replay.

## Conditional rollback

Rollback needs its own action-bound approval and a committed apply receipt.
Both entire rows, source inventory, aliases, holds and revisions must still
match the committed post-state. Only then does the executor restore the original
field (including **absent versus explicit JSON null**), with increasing revision
tokens. Intervening ingest or financial changes block rollback, even if the
invoiceHours value happens to be unchanged. Rollback has the same atomic audit,
lost-response recovery and retry behavior. A rolled-back plan cannot be applied
again. Outside the short plan validity window, stop and obtain a separately
reviewed recovery procedure; do not edit timestamps on the saved plan.

## Canonical/shadow guarantee — do not generalize the fixture

The supported adapter models both logical stores in **one disposable
PostgreSQL transaction**. This proves the protocol and failure paths under that
topology, not distributed atomicity between production PostgreSQL and MongoDB.
Other topologies are rejected by this atomic executor. A separate local
PostgreSQL/Mongo adapter now tests durable cross-store recovery; see
`invoice-dual-store-adapter.md`. It uses disposable schemas and is not yet
mapped to production stores or enforced by production readers/writers.

Before a future live adapter is admitted it must implement and test a durable
cross-store recovery protocol under actual writer fencing, with authoritative
per-store receipts and conditional CAS. A sequential PostgreSQL/Mongo update
without those guarantees is not an acceptable substitution. The application
must not serve or overwrite an unresolved half-applied pair. A flag or operator
assertion alone cannot turn the disposable adapter into that implementation.

## Required gates before any live use

1. Separately approved release of preservation, raw-retention and compatible
   invoice-evidence generation on **all** writers: web, callbacks, background
   workers, replays/backfills and any direct writer. Inventory actual running
   and suspended services; verify both deployed and runtime revisions, and
   record verification evidence. The fixture's three writer names are not a
   production inventory.
2. Verify semantics, not just module presence. Current identity preservation
   deliberately retains identity/date but clears stale sold/presented hours
   when the next native snapshot is incomplete. Do not change that policy to
   keep repaired hours indefinitely. Revalidate reporting after ingestion.
3. Implement and independently verify the real canonical/shadow consistency
   boundary described above. Confirm every writer is drained/fenced across
   both stores for the repair and recovery window.
4. Fresh, explicitly approved **read-only** preflight of all 100 exact identities
   using actual target keys, full state/revisions, all aliases and owners,
   current copies **and complete retained/archive inventory**, and current
   ownership/financial holds. The old preflight did not reread all archives or
   certify a complete hold registry; it is insufficient.
5. Separate operator execution approval bound to the finalized digest, target
   environment, fresh preflight and writer/hold evidence through an authenticated
   operator workflow. Reject changes; never silently rebase or broaden the pilot.
6. After a separately authorized repair, validate the pilot report and retained
   financial invariants. Fleet-report enablement and database grants remain
   independent approvals.

None of these live gates was performed or waived by this implementation.
