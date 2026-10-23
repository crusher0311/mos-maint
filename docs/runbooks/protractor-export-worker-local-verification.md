# Export-only worker: disposable PostgreSQL + Redis verification

Run `npm run test:export-worker-real-redis` with Node 20, installed project
dependencies, and `redis-server`, `initdb`, and `pg_ctl` on PATH.
Allow about 16 minutes. No running application or production configuration is
needed. Missing PostgreSQL or Redis is a failure, not a skipped test.

The wrapper creates an allowlisted child environment, without production
credentials, inherited NODE_OPTIONS, or provider/activation flags. Only the
isolated worker gets the export-enabled flag and dummy validation credentials.
A preload blocks external TCP at `Socket.connect`, DNS resolution, TLS, UDP,
and fetch before importing application modules. Only literal 127.0.0.1 TCP is
allowed, plus the exact disposable PostgreSQL Unix socket. PostgreSQL has no TCP
listener; its cluster and schema are created under `/tmp/export-pg.*`.
Redis binds that address on an ephemeral port with append-only
persistence in a disposable `/tmp/export-worker-real-*` directory. All children
and temporary data are cleaned up after the suite.

## What stays real

- `workers/export-only.ts`, its lifecycle and full 30-second startup and
  25-second drain timers, OS signals and process exits.
- BullMQ, ioredis, the export processor and export engine.
- Redis disconnection/reconnection and append-only queue persistence.
- Engine retry timestamps, 120-second leases, and BullMQ stalled-job recovery.
- PostgreSQL export adapter SQL, with per-statement committed transactions,
  Date hydration, hashes, retry state, receipts and final checkpoints.
- Cron route heartbeat admission, active configuration selection and persisted
  dispatcher cursor, issuing export-only BullMQ wake-ups.

## Synthetic boundaries

The test-only module preload injects the disposable PostgreSQL client into the
real export collection adapter, without loading the application's DB clients.
Gates block immediately before or after committed mutations; the parent then
SIGKILLs the actual worker. Ownership
checks accept only the fictional fixture context; source reads fail because
each scenario starts with a prepared synthetic pending batch. The transport
boundary sends fictional bytes to an in-process loopback HTTP receiver.
Production transport validation/signatures are **not** weakened: the production
transport is never imported by these worker fixtures. Its separate tests remain
the authority for signing, acknowledgment parsing and SSRF policy.
The cron fixture replaces the broad application queue producer with an
export-only BullMQ enqueue using the same job identity and removal options.
It does not start the production cron runner or unrelated queues.

## Assertions

- SIGTERM during gated preflight exits cleanly without registering a consumer or
  publishing a heartbeat.
- Hung preflight exits with code 1 at the real startup deadline.
- SIGTERM during delivery waits for acknowledgment and completes the checkpoint.
- A nonresponding receiver causes the real drain deadline to exit with code 1.
  The pending batch and active Redis job remain. A replacement worker recovers
   the stalled job; after the real engine lease expires, a real cron route
  wake-up delivers the identical ID and bytes and completes the checkpoint.
- A Redis restart retains queued work and the same worker reconnects to consume it.
- Receiver rejection persists attempts, retryAt and pending bytes. A new worker
  after SIGKILL cannot retry early; after the real retry delay it delivers the unchanged batch.
- SIGKILL before send, after receiver acceptance but before acceptance commit,
  and after acceptance, hash, receipt and final checkpoint commits preserves
  the exact PG state. Queue recovery cannot bypass the live lease.
- Uncommitted acceptance permits an identical-byte duplicate; committed
  acceptance prevents resending. Recovery produces exactly one receipt and
  preserves hash/cursor/window completion, including after repeated wake-ups.
- Redis worker/key inspection finds only the export queue.

The recovery test intentionally issues a new queue wake-up after lease expiry:
BullMQ is a wake-up mechanism, not the durable export-state authority. A stalled
job can complete while an old database lease still suppresses delivery.

## Limits and activation boundary

This suite does not validate real Mongo indexes/transactions, production PG grants,
provider access, destination authorization, signed public HTTPS delivery,
production Redis persistence configuration, or process-manager restart policy.
It does not enable a destination, create production services, resume suspended
workers, or authorize customer data delivery. Separate pilot approval and
production readiness checks remain required.

PostgreSQL 16 is used locally. These tests do not establish PostgreSQL 17
production readiness or authorize schema installation or delivery activation.
