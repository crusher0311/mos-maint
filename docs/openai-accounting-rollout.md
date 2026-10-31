# OpenAI safeguards and accounting rollout

Prepared for review only. No live settings, disks, keys, budgets, models or
services were changed during implementation. No historical bill is reconstructed.

## Changes after a separately approved deployment

- Analyzer routes accept only GPT-4.1, GPT-4.1-mini, GPT-4o and GPT-4o-mini.
  Existing defaults are preserved. Invalid supplied values return 400, before
  upstream lookups or AI inference. URL-initialized models are validated too.
  The unsupported GPT-4.1 Turbo dropdown entry is replaced with real mini choices;
  existing requests for that unsupported name are rejected, not silently upgraded.
- Each physical SDK retry gets its own UUID. A metadata-only receipt records its
  requested/returned model, source, shop, actual tokens, vendor request ID,
  process role/instance, release SHA, status and estimated cost where known.
  Receipts contain no prompts, response text, VIN, user identity or credentials.
- Canonical Mongo/PG delivery is idempotent by attempt UUID. A completed record
  cannot be replaced by a pending record arriving later. PG extra fields are
  retained. Current canonical/shadow flags are honored; no new schema is needed.
- DB capacity, ACK timeout and write failures have separate log events. Default
  mode retries metadata writes up to three times within the bounded writer; it
  does **not** promise survival of process death. Structured receipts provide an
  independent diagnostic trail, not a guaranteed billing ledger.
- Legacy helpers are suppressed after automatic capture even on ambiguous ACK
  failures: a legacy insert has a different identity and could double-count a
  late successful write. Retry ownership stays with accounting, never inference.

## Durable mode requires separate operational approval

Set `OPENAI_USAGE_SPOOL_DIR` **only after provisioning persistent storage** for
each AI-making service/process. Use an absolute dedicated directory accessible
only to that service, preferably a distinct directory for each process role.
Do not use `/tmp`, the application checkout, or an ephemeral deployment disk.
Do not put a journal in Git, the artifact library, or a public static directory.
Verify the platform's disk persistence/replacement behavior before enabling.

With the variable absent, no disk journal or background drain is started.
With it present:

1. A bounded metadata-only pending entry is fsynced before any provider request.
   If preparation fails or the journal is full, no provider request is sent.
2. Completed metadata is atomically renamed/fsynced to a ready entry. Delivery
   retries only database writes. A DB outage does not cause paid calls to replay.
3. A 30-second, unreferenced timer drains retained entries, including after
   process restart. A bounded DB writer prevents hung calls from creating
   unlimited concurrent database operations.
4. An orphan pending entry becomes an explicit unconfirmed attempt in reporting.
   It may represent a crash before dispatch or after provider acceptance. It is
   **not** a successful request, zero spend, or an instruction to replay inference.
5. Journal capacity is bounded at 10,000 retained metadata files (live attempts
   also reserve capacity conservatively). Corrupt or undeliverable files remain
   visible through retry errors and consume capacity rather than disappearing.

The admin panel shows unconfirmed journal attempts separately; existing unknown
usage/pricing warnings remain. Missing cached-token details follow the existing
pricing behavior; totals remain estimates, never an invoice.

## Failure limits and operator checks

- Persistent-disk destruction loses its undelivered journal. Sharing an
  ephemeral path across a redeploy does not make it durable.
- A crash between receiving an upstream outcome and journaling it can leave
  unknown usage, not recoverable token values. Receipts may help correlation but
  are not a substitute for persistent storage or vendor evidence.
- A disk failure after provider completion must not turn a successful inference
  into an automatic SDK retry; the caller keeps the provider result and the
  pending record/receipt indicates incomplete accounting.
- Keep log access restricted and give receipts a suitable retention policy.
  Logs and DB records share the attempt ID; never sum both as separate usage.
- Test full disk/capacity, database outage, restart recovery, malformed journal
  files, and simultaneous late ACK/retries in a non-production canary first.
- Monitor `capacity_denied`, `acknowledgment_timeout`, `database_write_failed`,
  `persistence_unconfirmed`, `spool_prepare_failed`, `spool_capacity_denied`,
  `spool_unavailable`, and `delivery_retry_pending`. Alert setup is separate.
- No model allowance/key rotation/budget activation is implied by this document.

## Offline verification

Run with secrets removed and network egress denied:

```
env -i PATH="$PATH" HOME="$HOME" NODE_OPTIONS='--require ./tests/helpers/deny-network-egress.cjs' node --import tsx --test tests/openai-usage.test.ts tests/openai-safeguards.test.ts tests/openai-model-routes.test.ts tests/openai-usage-route.test.ts
```

These tests use fake provider responses and temporary local files, not paid AI,
production Mongo, or production Postgres.
