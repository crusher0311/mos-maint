# Signed MOS → Cosmos receiver (prepared locally, not activated)

`mos-cosmos-receiver.cjs` is a separate, MOS-only replacement for the uploaded generic
receiver. Keep `cosmos-test-receiver.cjs` for the previous empty, unsigned connectivity
test; do not run both on port 3000.

## What is verified and what remains

Offline tests exercise signature failures, scope restrictions, raw record preservation,
concurrent duplicates, conflicting delivery bodies, partial batches, lost storage
responses, receiver restarts, and HTTP acknowledgment. They use an in-memory
Cosmos-shaped adapter. They do **not** establish real Azure permissions, SDK behavior,
latency, or container configuration. No production exports, secrets, database setup,
customer deliveries or Cosmos writes were authorized or performed by this preparation.

Before activation, verify against an isolated Cosmos container using fictional signed
records, including a real restart and storage failure. Then separately approve one
bounded real delivery. Sender and receiver activation are separate controls.

## Required setup (not executed)

On the receiver computer, use Node 20+ and install `@azure/cosmos` in that local folder.
Provision a **dedicated** existing container with:

- Single partition key `/mosScope`.
- No TTL and no custom unique-key constraints.
- Read/create permissions for the receiver, with appropriately restricted credentials.

Do not reuse an `/id` container or change an existing container's partitioning.
The receiver reads and validates configuration at startup; it never creates databases
or containers, never falls back to validation-only mode and never disables TLS checks.

Configure these locally using secure environment/secret management, not chat:

| Setting | Purpose |
| --- | --- |
| `COSMOS_ENDPOINT`, `COSMOS_KEY` | Azure endpoint and restricted credential |
| `COSMOS_DATABASE`, `COSMOS_CONTAINER` | Existing dedicated destination |
| `MOS_WEBHOOK_SECRET` | Same exact signing-secret string as the MOS recipient configuration; at least 32 bytes |
| `MOS_ENTERPRISE_ID` | Explicitly authorized enterprise |
| `MOS_SHOP_IDS` | Comma-separated authorized **MOS** shop IDs (store number is not MOS ID) |
| `MOS_ALLOW_REAL_EXPORTS` | Leave unset: signed empty synthetic tests only. `1` requires separate approval |
| `PORT` | Default 3000 |

Run `node mos-cosmos-receiver.cjs`. It binds only to `127.0.0.1`; ngrok forwards
to that address. Only `POST /webhook` accepts data; `GET /health` is minimal.
There is no customer-data/history viewer. Never expose the old generic receiver
as a production customer endpoint.

The earlier ephemeral signing key is not reusable or configured here. A new shared
secret must be provisioned securely on both ends. The prior test sender also used
a fictional enterprise ID; a signed test must use the receiver's approved scope.

## Authentication and acknowledgment

HMAC-SHA256 covers `timestamp.deliveryId.` followed by the exact received bytes.
Headers are `X-MOS-Timestamp`, `X-MOS-Delivery-Id` and `X-MOS-Signature: v1=<hex>`.
Timestamp must be within five minutes of the receiver clock (keep its clock synced).
Invalid authentication is rejected **before storage**. Retries use a fresh timestamp
and signature, the same delivery ID and identical body bytes.

Only a completed durable receipt produces HTTP 200 plus
`X-MOS-Acknowledgment: <deliveryId>`. Storage failures produce no ACK; sender retry
can resume safely. A timeout remains ambiguous until such a retry completes.

## Stored representation and consuming it

All documents share a scope partition derived from enterprise and MOS shop:

1. Immutable delivery claim reserves a delivery ID for the exact raw-body hash.
2. Immutable snapshot documents preserve each full record (`payload`, `source`,
   `observedAt`, provider ID and entity type). A separate logical ID hashes enterprise,
   shop, entity type and provider ID, avoiding unsafe Cosmos ID characters.
3. Immutable completed receipt preserves envelope metadata and the record count.

**Only consume snapshot documents whose matching delivery receipt has `complete: true`.**
Claims/partial snapshots are not successful deliveries. This is not an atomic batch;
the final receipt is its publication boundary. Do not acknowledge from a claim alone.
Never manually delete claim/receipt documents independently of their records.

Snapshots are append-only per delivery, not a mutable latest-state table. This prevents
late deliveries from overwriting more recent observations and preserves retry evidence.
Consumers may derive latest views from completed deliveries using `observedAt`, with an
explicit tie policy; arrival order is not observation order. Plan retention separately.
Raw records are preserved as parsed JSON, not raw-byte files; the receipt retains the
exact transport-body hash for byte-level retry checks.
