# Automatic RO audit rollout

## Safety model

Automatic RO audits are **off by default**. The receipt hook only persists a
small, versioned audit snapshot and sends a BullMQ job; it never evaluates an
audit, fetches an SMS record, rebuilds VHI, or writes an estimate from a
webhook/API request. Historical/backfill ingestion is explicitly excluded.

This matters especially in this repository: development Mongo is the
production cluster. Do not run a script that creates these indexes or inserts
test state from a development shell.

Every provider receipt must supply the provider's stable RO id plus
`upstreamUpdatedAt` (the authoritative source update timestamp) whenever the
provider exposes it, and `upstreamRevision` when it has a stable revision/ETag.
The scheduler rejects older timestamps, so adapters must pass source metadata
rather than local ingestion time. A collection absent from a sparse event is
not an empty ticket; only a known complete explicit empty job collection may
clear an audit.

## Receipt coverage (actual code paths)

All rows below use the already-received/fetched raw ticket only. Receipt
handoff does not make a provider request. A feature gate runs before receipt
mapping, and a missing jobs/packages collection is rejected as partial; an
explicit empty collection is a complete zero-job ticket.

| Provider | Webhook receipt | Poll receipt | Live detail receipt | Stable id / source timestamp / complete collection |
| --- | --- | --- | --- | --- |
| Tekmetric | `app/api/webhooks/tekmetric/route.ts` | `lib/integrations/tekmetric/incremental-sync.ts#upsertWorkOrder` (also `app/api/cron/tekmetric-sync/route.ts` via normalized ingestion) | `lib/integrations/tekmetric/adapter.ts#getWorkOrder` | `id`; `updatedDate`; `jobs` |
| Protractor | `app/api/webhooks/protractor/[token]/route.ts` | `app/api/cron/protractor-sync/route.ts` | `lib/integrations/protractor/adapter.ts#getWorkOrder` | `ID`; `Header.LastModifiedTime`; `ServicePackages` or `DeferredServicePackages` (array or `ItemCollection`) |
| Shopmonkey | `app/api/webhooks/shopmonkey/route.ts` | `lib/integrations/shopmonkey/adapter.ts#runIncrementalSync` via normalized ingestion | `lib/integrations/shopmonkey/adapter.ts#getWorkOrder` | `id`; `updatedDate`; `services` or attached `serviceItems` |
| Shop-Ware | `app/api/webhooks/shopware/route.ts` | `app/api/cron/shopware-sync/route.ts` | `lib/integrations/shopware/adapter.ts#getWorkOrder` | `id`; `updated_at`; `services` plus each non-empty service's `labors` and `parts` associations |

The shared normalized hook lives in
`lib/integrations/core/normalized-ingestion.ts`. It only admits an explicit
`webhook`, `poll`, or `live` ingestion origin. Missing attribution, and
origins/run IDs containing backfill, historical/history, full-page, rebuild,
migration, catchup, or replay are excluded. Known historical callers also set
`ingestionVia: "backfill"` explicitly (`lib/integrations/protractor/sync.ts`
and `lib/integrations/tekmetric/full-page-backfill.ts`).

## Operator prerequisites

Before enabling any shop, an operator with production database access must
create these indexes during an approved maintenance window:

```javascript
db.estimate_audit_states.createIndex(
  { shopId: 1, provider: 1, workOrderId: 1 },
  { unique: true, name: "estimate_audit_states_shop_provider_ro_unique", background: true }
)
db.estimate_audit_states.createIndex(
  { status: 1, updatedAt: 1 },
  { name: "estimate_audit_states_status_updated", background: true }
)
db.estimate_audits.createIndex(
  { shopId: 1, provider: 1, workOrderId: 1, revision: 1 },
  { unique: true, partialFilterExpression: { automation: true },
    name: "estimate_audits_automatic_revision_unique", background: true }
)
```

Provision Redis and deploy **a separate, always-on** Render background worker
with start command
`NODE_OPTIONS=--conditions=react-server npx tsx workers/audit-worker.ts`. Set these variables on
both the web service and that worker:

```text
REDIS_URL=...
ESTIMATE_AUDIT_WORKER_ENABLED=true
ESTIMATE_AUDIT_AUTOMATION_SHOPS=123              # canary; do not use global first
ESTIMATE_AUDIT_WORKER_CONCURRENCY=1              # default and recommended initially
TEKMETRIC_WEBHOOK_SIGNING_SECRET=...             # required for Tekmetric webhook receipt admission
SHOPMONKEY_WEBHOOK_SIGNING_SECRET=...            # required for Shopmonkey webhook receipt admission
```

Tekmetric and Shopmonkey can continue their existing permissive webhook
delivery behavior while signing is rolled out, but an absent signing secret
means those webhook payloads **cannot schedule automatic audits**. Poll and
authenticated live-detail receipts remain independently eligible. Do not
enable automatic audits from either webhook provider until its signing secret
and matching signature header/algorithm configuration have been verified.

The durable fleet lease is currently a deliberate global concurrency cap of
one across all replicas; raising a process worker's local concurrency does not
raise that safety cap.

Status behavior is intentionally conservative: a missing Redis URL or disabled
worker flag returns `unavailable` immediately; a deployed worker outage leaves
the last receipt `pending` and becomes `stale` after five minutes (or as soon
as its running lease expires). The status read never attempts recovery.

The existing background workers are deliberately suspended on weekdays around
5am–6pm Central. Do **not** add this consumer to their power schedule or to
`workers/worker.ts`; doing so would make an expected daytime pause look like a
silent audit outage.

Eligible shops must retain `estimate_assist`; VHI comparison additionally
requires `maintenance`. The consumer checks both at execution time and applies
the existing per-shop AI budget before evaluation.

## Canary, monitoring, and rollback

1. Enable one shop with `ESTIMATE_AUDIT_AUTOMATION_SHOPS`, while leaving
   `ESTIMATE_AUDIT_AUTOMATION_ENABLED` unset.
2. Confirm receipt state transitions `pending → running → complete|partial`,
   queue age stays below five minutes, and history has at most one row for a
   `(shop, provider, workOrderId, revision)`. Automatic revision history is
   written into the existing `estimate_audits` collection (with
   `automation: true`) so the current history UI sees it.
3. Exercise a changed ticket, a duplicate delivery, a zero-job complete
   ticket, and a changed receipt arriving while the prior job runs. Only the
   newest revision may become current.
4. Watch queue failures, `lastError`, stale pending state, `historyPending`,
   and AI budget denials. `historyPending` means the completed state has an
   idempotent history repair outstanding and must not be silently discarded.
   These records contain report data but no raw webhook payload.

For immediate rollback set `ESTIMATE_AUDIT_AUTOMATION_DISABLED=true` on the
web service. New receipts stop writing/enqueuing and status returns
`unavailable`; no inline fallback exists. Stop the dedicated worker after its
in-flight jobs drain. Do not delete state/history during rollback.

## Read contract

`GET /api/estimate-assist/audit/status?provider=&workOrderId=` authenticates
the dashboard session or extension Bearer token and always scopes the lookup to
that principal's shop. It returns only:

```ts
{ ok: true, status: "pending" | "stale" | "unavailable" | "partial" | "complete",
  report?: AuditReport, reason?: string, updatedAt?: string }
```

The client derives severity exclusively from `report.summary.critical` and
`report.summary.warnings`. `complete` with zero findings is a clean audit;
`partial` must remain visibly distinct. This read does not enqueue or rerun an
audit.