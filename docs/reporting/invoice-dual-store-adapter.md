# Local two-store invoice metadata repair adapter

## Delivered and deliberately excluded

`scripts/invoice-metadata-dual-store.ts` executes against **separate real
PostgreSQL and MongoDB servers**, not two tables in one SQL transaction.
It accepts only a guarded local PostgreSQL Unix-socket directory, a loopback
Mongo port and a random disposable marker checked in both databases.

Run `bash tests/run-invoice-dual-store.sh`. The runner clears credentials,
launches disposable databases, denies all network destinations except those
exact fixture endpoints, and destroys the databases afterward. Mongo uses a
single local WiredTiger server; majority acknowledgment here is not a replicated
cluster failover test. No provider clients, live CLI, live migrations, secret
loading, feature activation or deployment is included.

The physical schemas remain **test schemas**: canonical owner envelopes in SQL,
shadow owner envelopes in Mongo, and a SQL evidence context. This is a tested
distributed adapter/protocol, NOT a drop-in adapter for the current production
normalized tables/collections. Mapping native row IDs, BSON values, revisions,
complete retained evidence and hold registries remains required.

## Protocol

1. Validate the original proposal, full preflight bindings, all exact owners,
   financial/ownership holds, writer compatibility, deadline and separate
   action-bound approval using the shared offline contract. The distinct
   disposable-pg-mongo topology cannot use the old atomic executor.
2. Under a shared PostgreSQL advisory lock, persist the operation's durable
   fence and prepared journal. No metadata has changed at this point.
3. Commit the canonical metadata-only CAS and canonical receipt phase together
   in PostgreSQL. Full previous owner equality is required.
4. While holding the same coordinator lock, CAS the exact shadow owner and
   embed its operation receipt atomically in the Mongo document. Only invoice
   metadata, revision and adapter receipt fields change.
5. Read back both owners and the Mongo receipt. Commit completion and release
   the fence only when both stores match the exact intended after-state.

Successful phases are audited transactionally in SQL. A failed operation gets
a separate `rejected_or_unknown` audit; it is never described as rolled back
just because a response was lost. A matching field without its receipt is not
proof that the operation committed. Failure to write an audit also fails the
call; durable receipts remain the outcome authority.

## Fencing and recovery

The fixture's guarded read/write API takes the coordinator lock and rejects
while a repair fence exists. Fences have no timeout that silently reopens
access. Expired approval permits read-only inspection, not another write or
automatic unfencing. Source, hold, ownership or full-row drift stops recovery.

A retry verifies earlier committed entries, then resumes the exact fenced
entry. It does not apply later entries after a failure, refresh the plan or
infer success from current values. Receipts survive new clients and process
exit. A separate rollback approval restores only the invoice field, including
absent versus explicit null, while increasing revisions. Post-repair financial
or other row changes veto rollback.

**Production readers and writers do not yet use this fence.** The guarded
fixture proves behavior only for cooperative users of its API. Direct database
writes can bypass it. Deployment without complete enforcement at every actual
reader/writer would be unsafe; a boolean operator assertion is not sufficient.
The global fixture fence prioritizes safety over throughput.

## Verification

Passed on local real PostgreSQL and MongoDB:

- Apply, exact receipt retry, conditional rollback and repeat rollback.
- Unchanged native/financial fields and unrelated custom fields.
- Lost canonical, shadow and final acknowledgments for apply and rollback.
- New client recovery and actual child-process exit after the shadow commit.
- Expired approval leaves an unresolved pair fenced; inspection remains possible.
- Intervening financial changes, hold changes, competing aliases and missing
  shadow receipts reject rather than overwrite or claim success.
- Concurrent attempts converge without advancing revisions twice.
- 100 identities: second-entry failure preserves the first committed entry,
  does not touch the third, and retry completes all 100.
- External network/credentials excluded; original atomic executor regressions
  and project typecheck still pass.

## Remaining production gates

Production schema mapping and full-evidence/hold reads; authenticated operator
authorization; fail-closed fencing at every read/write sink; deployed writer
revision verification; realistic replica failover/durability tests; and a
fresh bounded preflight. None of these is waived by these local tests.
