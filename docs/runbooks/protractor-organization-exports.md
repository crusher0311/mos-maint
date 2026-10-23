# Daily Protractor organization exports

## Current storage direction

Export control state now targets PostgreSQL locally: configuration, pending
deliveries/checkpoints, hashes, receipts and worker/dispatcher health. Raw-source
reads remain in the existing Mongo/PG caches. See
[the PG installation proposal](../../scripts/protractor-export-pg/README.md).
Production PG installation and coordinated release remain unapproved. The Mongo
control-state installation instructions below describe the previous release,
not a fallback or an instruction to initialize new destinations there.

## Deployment is not activation
Production installation and activation gates are collected in
[the local setup package](protractor-export-production-setup.md).

This feature is OFF unless `PROTRACTOR_EXPORTS_ENABLED=1`. Do not set it as part
of deployment. No backfill, customer delivery, index creation or database cutover
is authorized by this implementation. Development Mongo is production: tests must
use fixtures and deny network egress.

## Receiver contract v1
POST HTTPS/443 with JSON `schemaVersion: mos.protractor.snapshots.v1`.
Each immutable batch has `deliveryId`, enterprise/shop identity, local-date window,
coverage and records. Records contain source shop, `entityType` (`work_order` or
`invoice`), provider ID, observedAt, storage source and provider payload. Additional
entity types require a new explicit grant/contract; no DVI is collected here.
Inspection/DVI subdocuments are omitted. Payloads containing credential-like or
internal underscore fields are rejected and reported missing, not exported.

Authenticate `x-mos-signature: v1=<hex HMAC-SHA256>` using the one-time destination
secret over `timestamp.deliveryId.<exact UTF-8 body>`. Timestamp comes from
`x-mos-timestamp`, delivery ID from `x-mos-delivery-id`. Check timestamp freshness
(recommended five minutes), HMAC with constant-time comparison and body ID.
**Durably deduplicate before acknowledging.** Return 2xx and
`x-mos-acknowledgment: <deliveryId>` only after committing the batch. Return the
same acknowledgment on duplicates. A 200 without that header is a failure.
Retries preserve ID and body; timestamp/signature refresh on every attempt.
Redirects are never followed. DNS resolves and pins public IPv4 per attempt;
IPv6-only hosts, IP literals, credentials, query strings and non-443 ports are
unsupported. Receiver response bodies are never retained.

## Coverage and storage audit
This is **MOS-observed latest snapshots**, not replication, full historical
coverage, every intermediate change, or deletion detection.

* `lib/integrations/protractor/client.ts` writes work-order `rawPayload`,
  invoice `rawPayload`, and invoice-cache `invoice` directly to Mongo.
* Repository work-order writes route to PG when Protractor cache canonical mode
  is enabled. PG stores the Mongo-shaped wrapper in `payload`.
* Invoice snapshot/cache repositories and jobs prewarm still write Mongo.
  Backfill and sync consume those client paths. Terminal callback/drain and
  standalone sync updates can alter wrapper status without changing raw payload.
  Such MOS-only wrapper updates are deliberately not provider changes.
* Export reads Mongo in Mongo mode; in PG mode it reads both stores, resolving
  duplicate provider identities by newest observation time, then lexical source.
  PG misses alone never mean absent. No normalized table is used.
* Raw list/detail payloads differ in available fields. They are exported as
  observed, not enriched/merged. Existing metadata does not reliably identify
  list versus detail, so this feed does not assert detail completeness.
* Missing ID, missing raw payload, invalid observation time, unsafe payload, or
  >504 KiB record means unavailable coverage, never normalized substitution.
  Rows without a usable cache identity cannot be enumerated by the keyset sweep.
* Every daily window scans local identity keys, **not invoice dates**. This sees
  corrections to old invoices. Canonically sorted payload hashing ignores cache
  timestamps; unchanged refetches do not repeat.

The optional initial available-data snapshot exports what exists during the first
sweep. Without it, the first sweep establishes a baseline and only later detected
changes are exported. Baseline completion can take multiple worker passes.
Sweeps are not point-in-time database snapshots. Updates behind the current cursor
are seen on the next sweep; intermediate overwritten versions cannot be recovered.

Windows start on the first worker pass at/after HH:mm in the selected IANA zone.
Spring-forward missing times run at the first later tick; repeated fall times
share one date. Pending windows resume across restarts; after an outage the next
window uses the current due local date, with `previousCompletedDate` exposing gaps.
Missed historical days cannot be reconstructed from latest-only caches.
`window_complete` is an acknowledged terminal marker, including for zero-change
windows. Missing/oversized counts make incomplete collection explicit. Source
query failure blocks the window with `collection_unavailable`, not empty success.

## Operations and prerequisites
The existing worker registers a dedicated concurrency-one consumer; the fenced
cron only queues IDs. It refuses admission without a recent worker heartbeat.
No fallback to web-tier processing. Night/weekend worker suspension delays
delivery: the pilot must provide worker availability at the confirmed schedule.
Each pass reads at most 25 identities; requests cap at 512 KiB and ten seconds.
Retries use exponential backoff (30 seconds to six hours), stopping after eight
failures. Manual retry rechecks grants. Pause stops new sends; revocation removes
pending bodies and signing material. An already-dispatched HTTP request cannot be
recalled. Reconfiguration creates a new approval revision, cancels old pending
work and establishes a new baseline; do not use it as a substitute for retry.

Operator prerequisites, **apply only with separate production approval**:
* Set a fresh 32-byte hex `PROTRACTOR_EXPORT_ENCRYPTION_KEY` through the secrets
  flow on web and worker. AES-256-GCM binds signing secrets to enterprise/revision.
  Back it up securely; replacement requires reconfiguration of receivers.
* In the application's Mongo database, create the following named indexes:
  `protractor_export_configs`: `{paused:1,revoked:1,_id:1}`, name `export_active`.
  `protractor_export_states`: `{enterpriseId:1,revision:1,shopId:1}`,
  name `export_status`; `{"pending.createdAt":1}`, name `export_retention`.
  `protractor_export_history`: `{acceptedAt:1}`, name `export_history_ttl`,
  expireAfterSeconds `7776000`; also `{enterpriseId:1,acceptedAt:-1}`.
* Verify local-cache `{shopId:1,workOrderId:1}` / `{shopId:1,invoiceId:1}`
  indexes and PG primary keys exist. Verify ID sort collation compatibility.
  No schema migrations or indexes run automatically.
* State and hash IDs include enterprise, approval revision and shop. Immutable
  pending bodies live in state; accepted receipts contain metadata only.
  Worker retention removes unacknowledged bodies after 30 days and blocks them
  as `payload_retention_expired`, requiring explicit reconfiguration/baseline.
  Accepted bodies are scrubbed after 30 days; hashes remain for deduplication.
  Receipts expire after 90 days. Retention worker must remain available even
  while destinations are paused.

Pilot checklist: confirm recipient contract/idempotency, destination ownership,
explicit shop IDs and redistribution authority, timezone/schedule, initial
snapshot decision, data-processing agreement and retention. Inspect per-shop raw
coverage using synthetic fixtures first. Approve indexes and secret setup
separately; verify consumer heartbeat and schedule capacity. Save paused, securely
install the one-time receiver secret, and explicitly confirm resume. Never enroll
sibling shops automatically. Recheck current ownership, provider connectivity and
maintenance entitlement before every send/retry. No DVI or upstream API polling.

Offline check:
`NODE_OPTIONS='--require ./tests/helpers/deny-network-egress.cjs --require ./scripts/_stubs/server-only-stub.cjs' node --import tsx --test tests/protractor-exports.test.ts`

## Synthetic receiver rehearsal (no activation)

See [the preparation report and one-shop handoff](protractor-export-pilot-readiness.md).
Run from the repository root with the already-installed dependencies:

```sh
# Real sender logic and engine tests: all network access denied.
NODE_OPTIONS='--require ./tests/helpers/deny-network-egress.cjs --require ./scripts/_stubs/server-only-stub.cjs' \
  node --import tsx --test tests/protractor-exports.test.ts tests/protractor-export-transport.test.ts

# Real local HTTP receiver: only this command explicitly allows loopback.
PROTRACTOR_OFFLINE_ALLOW_LOOPBACK=true \
NODE_OPTIONS='--require ./tests/helpers/deny-network-egress.cjs' \
  node --import tsx --test tests/protractor-export-synthetic.test.ts
```

The second command is the operator-facing synthetic sender harness. It generates
a random, in-memory secret, starts `scripts/protractor-export-synthetic/receiver.mjs`
on an ephemeral port bound to **127.0.0.1 only**, and sends fictional invoice
`SYNTHETIC-ONLY` for fictional shop `999999` / `synthetic-enterprise`. It accepts no
destination, shop, input payload or credential arguments. No `.env` is loaded,
no application starts, and no database or provider client is imported by the
sender/receiver. The receiver child receives only its temporary directory and
ephemeral secret over private IPC, not inherited application secrets.

Expected: a PASS summary and zero failures. Nonzero exit means do not proceed.
The sender verifies 202 acceptance, 200 duplicate acceptance, 401 bad signatures
and past/future stale timestamps, changed exact bytes, mismatched body identity,
409 changed-body reuse of a delivery ID, missing/mismatched acknowledgments,
and connection loss **after** durable acceptance. It kills the receiver process,
starts a new process with the same inbox, and retries the unchanged batch with
a refreshed timestamp/signature. It asserts exactly two saved batches and reads
the saved bytes back before cleanup. Temporary receipts are removed after the
test; no customer records or persistent credentials are involved.

Reference durability: write the entire body plus digest/ID to a private file,
fsync it, atomically hard-link to the delivery-ID path without overwrite, then
fsync the directory before acknowledgment. Duplicate IDs must match both digest
and exact body. Storage failures return 503 without acknowledgment. This requires
a local POSIX filesystem with hard-link/directory-fsync support; it is not a
multi-host inbox or a public receiver deployment. A production recipient must
implement equivalent transactional inbox/idempotency guarantees on its own
durable storage, enforce its approved tenant/shop scope, and handle retention
and downstream processing separately. Do not copy the controlled failure paths
(`/missing`, `/mismatch`, `/lost`) into a public service.

The loopback fixture does not call `deliver()` and does not weaken its public
HTTPS rules. The separate transport test exercises the actual production sender
with mocked HTTPS/DNS, including matching ACK, missing/wrong ACK, redirect refusal,
429, stable retry body/ID, refreshed signature and pinned DNS address. This
rehearsal does **not** certify a real destination's DNS, TLS, ownership or storage.
