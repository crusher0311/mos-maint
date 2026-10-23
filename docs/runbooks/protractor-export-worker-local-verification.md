# Export-only worker: disposable Redis verification

Run `npm run test:export-worker-real-redis` with Node 20, installed project
dependencies, and `redis-server` on PATH (the workspace Nix packages include it).
Allow about four minutes. No running application or production configuration is
needed. Missing Redis is a failure, not a skipped test.

The wrapper creates an allowlisted child environment, without production
credentials, inherited NODE_OPTIONS, or provider/activation flags. Only the
isolated worker gets the export-enabled flag and dummy validation credentials.
A preload blocks external TCP at `Socket.connect`, DNS resolution, TLS, UDP,
and fetch before importing application modules. Only literal 127.0.0.1 TCP is
allowed. Redis binds that address on an ephemeral port with append-only
persistence in a disposable `/tmp/export-worker-real-*` directory. All children
and temporary data are cleaned up after the suite.

## What stays real

- `workers/export-only.ts`, its lifecycle and full 30-second startup and
  25-second drain timers, OS signals and process exits.
- BullMQ, ioredis, the export processor and export engine.
- Redis disconnection/reconnection and append-only queue persistence.
- Engine retry timestamps, 120-second leases, and BullMQ stalled-job recovery.

## Synthetic boundaries

The test-only module preload replaces the database repository with atomic
JSON-file fixtures, preserving pending state across worker processes. Ownership
checks accept only the fictional fixture context; source reads fail because
each scenario starts with a prepared synthetic pending batch. The transport
boundary sends fictional bytes to an in-process loopback HTTP receiver.
Production transport validation/signatures are **not** weakened: the production
transport is never imported by these worker fixtures. Its separate tests remain
the authority for signing, acknowledgment parsing and SSRF policy.

## Assertions

- SIGTERM during gated preflight exits cleanly without registering a consumer or
  publishing a heartbeat.
- Hung preflight exits with code 1 at the real startup deadline.
- SIGTERM during delivery waits for acknowledgment and completes the checkpoint.
- A nonresponding receiver causes the real drain deadline to exit with code 1.
  The pending batch and active Redis job remain. A replacement worker recovers
  the stalled job; after the real engine lease expires, another scheduler-style
  wake-up delivers the identical ID and bytes and completes the checkpoint.
- A Redis restart retains queued work and the same worker reconnects to consume it.
- Receiver rejection persists attempts, retryAt and pending bytes. A new worker
  cannot retry early; after the real retry delay it delivers the unchanged batch.
- Redis worker/key inspection finds only the export queue.

The recovery test intentionally issues a new queue wake-up after lease expiry:
BullMQ is a wake-up mechanism, not the durable export-state authority. A stalled
job can complete while an old database lease still suppresses delivery.

## Limits and activation boundary

This suite does not validate real Mongo indexes/transactions, PostgreSQL,
provider access, destination authorization, signed public HTTPS delivery,
production Redis persistence configuration, or process-manager restart policy.
It does not enable a destination, create production services, resume suspended
workers, or authorize customer data delivery. Separate pilot approval and
production readiness checks remain required.

## Recorded local result (2026-10-23)

Node 20.20.0 / Redis 7.2.10: all six integration scenarios passed (seven
node:test results including the parent), with no skips. Measured startup exit:
30,207 ms; forced drain exit: 25,013 ms. Interrupted delivery recovered after
the unmodified 120-second lease with identical ID/body. Total suite duration
was about 186 seconds. The nine existing lifecycle tests and thirteen existing
engine/transport tests also passed. Targeted TypeScript checking of the new
fixture and integration test passed.
