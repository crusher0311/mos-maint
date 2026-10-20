# Local two-store invoice metadata repair adapter

## Delivered and deliberately excluded

`scripts/invoice-metadata-dual-store.ts` executes against **separate real
PostgreSQL and MongoDB servers**, not two tables in one SQL transaction.
It accepts only a guarded local PostgreSQL Unix-socket directory, a loopback
Mongo port and a random disposable marker checked in both databases.

Run `bash tests/run-invoice-dual-store.sh`. The runner clears credentials,
launches disposable databases, denies all network destinations except those
exact fixture endpoints, and destroys the databases afterward. Mongo uses a
three-member local replica set. The envelope suite exercises primary loss;
the native-schema suites connect to that same replica set but do not yet inject
native-adapter primary loss. No provider clients, live CLI, live migrations, secret
loading, feature activation or deployment is included.

The original adapter uses test envelopes. The native-schema preparation below
now exercises actual normalized row/document shapes and the same staged-commit
protocol. Both executable constructors remain disposable-only; neither is a
live production CLI.

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

The original envelope fixture is cooperative. The application's shared drivers
and relevant direct-client tools now have the separate mandatory boundary
described below. Its control schema is deliberately unapplied. The original
fixture alone is not evidence of production enforcement.

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

Separate installation/release approval, actual deployed/runtime writer
verification, reviewed complete hold coverage, fresh bounded preflight and
exact-plan execution approval remain live gates. No live gate is waived by
the disposable tests. Replica failover testing is a separate suite.

## Native schema preparation (not an executable production adapter)

`scripts/invoice-native-schema.ts` adds separately tested mapping/CAS primitives:

- Canonical rows use the real `normalized_work_orders` column names. Full-state
  comparison retains server-generated `to_jsonb(row)::text`, including columns
  added later. Financial numerics never round-trip through JavaScript numbers.
  Only `custom_fields.invoiceHours` changes; provider version, raw data,
  content hash, timestamps and all financial columns remain unchanged.
- Shadow documents retain native string/ObjectId `_id`, camel-case field names,
  BSON Date, Int32, Double, Long, Decimal128, Binary subtype and Timestamp.
  Reads must disable numeric promotion. Full-document equality is combined
  with recursive BSON type predicates because Mongo considers numerically
  equal Int32/Double/Long values equal. Added/missing/null fields remain distinct.
- Rollback primitives restore the metadata member's original presence, including
  explicit null. They do not authorize rollback, infer a distributed commit,
  install receipts or release a fence.
- Operation versions/receipts must live in the repair coordinator rather than
  altering provider-owned version/content hashes. Production execution throws
  unconditionally; no environment switch can enable it.

The disposable suite now derives its canonical table's columns, enum types,
defaults and nullability from `lib/db/schema/normalized.ts`. Mongo tests use the
real camel-case shape and native BSON values rather than an `owner` envelope.
These tests pass separately from the original distributed protocol tests.
`scripts/invoice-native-dual-store.ts` connects these mappings to a native
two-store protocol with SQL journal phases and a receipt in the Mongo metadata
CAS. The receipt does not turn the two commits into an atomic transaction.

### Integration boundary

The native mapping tests alone do not prove complete enforcement. A guarded
repository alone would miss these access paths:

- Reporting queries include `lib/reporting-kpi-service.ts`,
  `lib/invoice-fleet-stream.ts` and the JWT preview repository. Report runs and
  saved delivery results also need explicit handling of their snapshot/version
  boundaries; serving a previously saved report is not a new live read.
- Writes span `lib/integrations/core/normalized-ingestion.ts` (including
  ingestion bookkeeping), `lib/supabase-dual-writer.ts`, workers and scripts.
  Individual statements are not sufficient: a multi-store ingestion must drain
  before repair admission, not stop halfway between its ordinary writes.
- `lib/mongo.ts` exposes both a database and the raw client, and other tools
  construct their own clients. PostgreSQL also has direct clients outside
  `lib/db/drizzle.ts`. Merely wrapping one repository leaves bypasses.

A mandatory access boundary must cover the actual deployed service identities,
all relevant reader/writer sinks and already-in-flight work before native
execution can exist. It must persist unresolved fences without TTL release,
fail closed on coordinator failure, cover cursor continuations, and retain
fencing after process exit or approval expiry. An operator boolean, a signed
claim that fencing exists, or a list of cooperative fixture callers is not proof.

The native coordinator uses fresh native evidence reads, reviewed hold coverage,
persisted action-specific grants and deployed/runtime writer verification.
These replace the original envelope executor's supplied readiness/approval
objects. No production migration, write, deployment, worker resume or activation
has been performed.

### Shared driver boundary preparation

`lib/invoice-repair/fence.ts` and `guarded-drivers.ts` now have disposable
integration coverage for PostgreSQL queries/transactions and Mongo collection
reads/writes, raw commands and buffered cursor continuations. Admission is
persisted before work starts in another store. Failed/ambiguous operations keep
their access record, so losing the PostgreSQL coordinator connection cannot
make an in-flight Mongo command look drained. There is no automatic expiry.
Missing fence state after installation rejects access.

`docs/reporting/invoice-repair-control-schema.sql` is an **unapplied preparation
file**, not a migration authorized to run. Before the installation marker
exists, no repair admission is available. The installation itself needs a
verified, drained inventory and separate approval. The schema must not be
installed as part of a normal build or deployment.

The shared PostgreSQL/Mongo factories, relevant direct reporting/repair scripts,
and whole normalized-ingestion operations now use the boundary. Manual index
repair transactions use whole-operation exclusion too. A source-inventory
regression check rejects relevant direct native-driver constructors outside
restricted disposable tools. Unbounded streams/unscoped transactions are
refused; bounded DECLARE/FETCH reporting stays inside a fenced transaction.

Before installation, no native repair can be admitted. Once installed, both
stores must have the same installation key: a CLI pointing at the wrong
PostgreSQL database cannot silently admit Mongo work. Installation is a
separately approved, drained transition, not an environment boolean.

### Dedicated hold registry preparation

The user selected a dedicated registry whose coverage must be reviewed.
`lib/invoice-repair/hold-registry.ts` and the unapplied control schema now
separate shop/provider coverage reviews, individual or shop-wide holds, and
hold resolutions. There are no automatically approved empty scopes. Every
hold mutation increments the scope revision through a database trigger and
invalidates prior coverage reviews. Reviews also bind the inventory digest
and expire after five minutes. Resolved holds and hold identities cannot be
rewritten or deleted through the prepared schema.

`authenticated-registry.ts` derives the actor from the existing server session
and requires a platform administrator; test authentication, impersonation and
password-change-required sessions are rejected. These are server-side building
blocks, not an installed route or production connection factory. The low-level
registry accepts a trusted server actor for composition and disposable tests;
it must never be exposed directly to request-body actor fields.

The disposable suite verifies default-deny coverage, changed inventory,
registry revision invalidation, expiration, resolution, shop-wide holds and
database-enforced immutability. This does **not** establish real registry
coverage or approve any financial values.

### Native execution preparation

`DisposableNativeInvoiceStore` uses native rows/documents, complete bounded
evidence reads, the control schema, grants and hold reviews. Its constructor
retains the guarded Unix socket, loopback Mongo and random dual-marker checks.
The server-only production connection factory and authenticated execution entry
are now prepared in `lib/invoice-repair/production-store.ts` and
`production-entry.ts`. There is still no registered HTTP route or scheduled job.

The authenticated facade derives the actor from the existing platform-admin
session for hold operations, grant issuance and native execution. Every native
write phase rereads the persisted grant and checks actor, action, exact plan
and evidence digests, revocation and expiry. Fixture tests issue low-level
grants directly; that is not the production authentication entry point.

Native evidence reads cover both owners, both stores' provider caches, every
retained archive campaign for the shop, history bookkeeping and canonical
financial children. Checksums, ownership ambiguity, missing tables and
inventory/byte caps fail closed. Rollback preserves each store's own missing
versus null metadata preimage; it does not overwrite financial fields.

Writer verification compares a reviewed compatibility-evidence manifest with
read-only Render service/deployment records (including suspended services)
and fresh instance revision records. Repository-wide enumeration detects
services omitted from environment groups. Runtime evidence collection continues
while the data fence is closed; failures make evidence stale and reject repair
admission. Offline tests supply deployment responses; no live verification or
rollout was performed.

Native tests cover apply/retry/rollback, canonical/shadow lost responses,
read/write blocking, actor/action/digest rejection, hold coverage and evidence
drift. The original envelope suite retains the larger multi-entry/process-exit
tests; those are not claimed as native replica-failover tests.

### Prepared production entry (not activated)

The native engine is shared by disposable and production-shaped connections.
The production entry first requires explicit server-side activation and a
non-impersonated, non-test platform-administrator session. It accepts no actor
identity from the command. Configuration is trusted server input, not browser
JSON; importing the module opens no connections and reads no credentials.

Before accessing repair state, its dedicated maintenance clients verify the
expected PostgreSQL database/role and the same pre-approved 64-character
installation key in both PostgreSQL and Mongo. Mongo uses primary,
majority-consistent reads and disables retryable writes. These clients cannot
use ordinary access admission: they would block on their own repair fence.
Every native phase still requires the installed exclusion, drained admissions,
writer verification, evidence and hold coverage, and persisted approval.

Commands are prepare, approve, execute and inspect. Approval refreshes native
state, writer verification and hold coverage before creating an actor/action/
plan/evidence-bound grant. Execution rechecks these conditions at every phase;
changes between approval validation and grant insertion cannot authorize a stale
write. An unresolved repair cannot obtain a new ordinary approval by silently
extending its plan. Expired plans may be inspected. Apply and rollback require
separate grants. Driver errors are not forwarded as native-row or credential
details; an uncertain response directs the operator to persisted state.

The isolated test bundles the real server entry, substituting only the session
provider. It uses actual disposable PostgreSQL and a three-member Mongo replica
set; deployment-verification responses remain offline fixtures. Tests verify
disabled mode, denied staff/test/impersonation/password-reset sessions,
installation and database/role mismatch, missing/wrong-actor grants, native
apply/rollback and expired-plan inspection. Nothing connects this test to live
credentials or installs the control schema in production.

Before live use: complete release validation, deploy verified compatible readers
and writers, separately approve a drained installation with the same random key
in both stores, establish current writer and reviewed hold evidence, run a fresh
bounded preflight and obtain specific repair approval. No step is implicitly
authorized by the presence of this entry point.
