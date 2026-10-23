# Protractor webhook export production setup package

Status: prepared locally; **not installed or approved for activation**.
Read alongside `protractor-organization-exports.md` for the receiver contract.

## Production evidence — 2026-10-23

Read-only Render service/deployment checks and direct Mongo metadata checks:

- Web and callback services serve commit
  `ad56fc491260de75415388a49893ece6c5791685`. That source contains export
  registration and the export cron. This is not proof of running cron execution.
- Both general background services are suspended, with last live commit
  `8d190f07b70c4f15affa1faba19f8e13041e41b8`, which lacks export registration.
- Service-level settings on these four services contain neither
  `PROTRACTOR_EXPORTS_ENABLED` nor `PROTRACTOR_EXPORT_ENCRYPTION_KEY`.
  Environment-group inheritance and effective runtime values remain unverified.
- Mongo `protractor_export_configs`, `protractor_export_states`, and
  `protractor_export_history` do not exist. Export heartbeat is absent.
- Work orders have `{shopId:1,workOrderId:1}`. The two invoice collections
  have only `_id` indexes.
- No configuration or payload documents were read; no cron was invoked.

## Isolated consumer — implemented locally, not deployed

Do not resume a suspended worker or run `scripts/start-worker.ts` for this pilot.
`workers/worker.ts` currently starts Tekmetric full-page, pre-pass and drain
consumers alongside exports, and may register Protractor drain work.
Use the new `npm run worker:protractor-exports` command for the dedicated
service after approval. It runs `workers/export-only.ts`, not the general worker.
The entry point exits without loading database/Redis clients when the export
flag is disabled. Enabled startup validates required configuration and database
prerequisites, with a 30-second startup deadline. Graceful shutdown stops the
heartbeat and drains the export consumer, with a 25-second forced-exit deadline.
Process exit closes remaining database handles; interrupted durable jobs retry.

The locally implemented consumer has these requirements:

1. Register only the export queue, at concurrency one. Import/start no backfill
   consumer or incremental loop.
2. Fail explicitly when required Redis/database/key configuration is missing.
3. Emit heartbeat only after queue readiness; stop heartbeat during shutdown.
4. Retain cleanup while destinations are paused, and drain safely on SIGTERM.
5. Pass an offline registration test proving no unrelated queues start.

Choose a separately approved service and availability schedule. Leave existing
web, callback and suspended-worker schedules unchanged. Availability must cover
delivery and retention, not only the initial test window.

## Index manifest — review only

Database: application Mongo database `mos-maintenance-mvp`. No index creation
belongs in application startup or deploy hooks.

| Collection | Keys (ordered) | Proposed name | Options |
|---|---|---|---|
| protractor_export_configs | paused:1, revoked:1, _id:1 | export_active | nonunique |
| protractor_export_states | enterpriseId:1, revision:1, shopId:1 | export_status | nonunique |
| protractor_export_states | pending.createdAt:1 | export_retention | nonunique |
| protractor_export_history | acceptedAt:1 | export_history_ttl | expireAfterSeconds:7776000 |
| protractor_export_history | enterpriseId:1, acceptedAt:-1 | export_history_enterprise_accepted | nonunique |
| protractor_invoices | shopId:1, invoiceId:1 | protractor_invoice_shop_invoice | nonunique |
| protractor_invoice_cache | shopId:1, invoiceId:1 | protractor_invoice_cache_shop_invoice | nonunique |

Preserve the existing work-order index; do not duplicate it by name. Confirm
collection default collation and query/index compatibility before installation.
Compare keys/options, not just names. Stop on conflicting existing definitions;
do not drop/rebuild or impose uniqueness automatically.

The startup preflight checks all five named export indexes against the exact
ordered keys above, requires nonunique definitions, and requires the TTL to be
exactly 7776000 seconds (no TTL on other indexes). It also requires the existing
work-order `{shopId:1,workOrderId:1}` index and both invoice cursor indexes.
Source indexes may retain any existing name and uniqueness setting, but must
have the exact ordered keys. Hidden, sparse, partial, or non-simple-collation
indexes do not satisfy these requirements. All six collections must exist with
simple (or absent) default collation: source queries inherit that default and
merge cursors using binary ordering. A simple index alone cannot compensate for
a non-simple collection default. Mongo sources remain required in PG canonical
mode because exports read both stores. Metadata read failures stop startup;
preflight never creates, drops, or modifies indexes.

Offline regression check (no credentials or database access):
`env -i PATH="$PATH" HOME="$HOME" NODE_OPTIONS='--require ./tests/helpers/deny-network-egress.cjs --require ./scripts/_stubs/server-only-stub.cjs' node --import tsx --test tests/protractor-export-prerequisites.test.ts`

Before the two populated-source index builds, refresh collection/index sizes,
capacity and health checks, agree stop thresholds and install sequentially.
The earlier reporting database checks do not establish Mongo index capacity.
Verify applicable PG source tables, primary keys and cursor query plans if
Protractor cache PG mode is enabled. Missing PG prerequisites require a separate
proposal; this package does not authorize migration.

## Configuration and credentials — no values in this document

- Through secure configuration, provision the same valid 32-byte hex
  `PROTRACTOR_EXPORT_ENCRYPTION_KEY` on web and the chosen export worker.
  Check inherited settings and runtime presence without printing values.
- Keep `PROTRACTOR_EXPORTS_ENABLED` disabled until the activation gate below.
  Do not set it globally on unrelated services.
- Verify Redis queue connectivity, database target, canonical-cache mode and
  source read permissions on the selected service.
- Render saved environment changes require a new deploy, not merely a restart.
  Verify the exact release and effective runtime configuration afterward.
- Do not change reporting build/read flags or Protractor traffic guards.

## One-shop enrollment inputs (required before customer delivery)

- Exact MOS shop ID, enterprise and authorized approver.
- Receiver owner and public HTTPS/443 URL; no query, credentials, fragment,
  IP literal or redirect. Public IPv4 DNS and TLS must pass.
- Explicit permission to redistribute work orders/invoices, recipient data
  handling agreement and retention/deletion policy. DVI remains excluded.
- Daily HH:mm and IANA timezone, with actual worker availability.
- Initial available-data snapshot OR baseline-only (subsequent changes).
- Named observer, first-window limits and stop authority.

Latest observed payloads are not complete historical replication, every version,
or deletion tracking. Missing/unsafe/oversized records remain coverage gaps.

## Installation and activation gates

1. Approve installation scope separately: indexes, secure configuration,
   isolated worker implementation/service and release. Refresh read-only
   prerequisites immediately before each production action.
2. Install approved indexes sequentially and verify definitions. No sends.
3. Deploy the isolated consumer with exports disabled. Do not resume unrelated
   workers. Verify exact commit/start command and absence of other consumers.
4. Certify the real receiver using approved fictional data: signature checks,
   exact-body matching, deduplication, durable storage, lost-response retry,
   and matching `x-mos-acknowledgment`. The loopback fixture alone is not
   recipient certification.
5. Inspect config status using an allowlisted metadata projection, excluding
   destination secrets and pending bodies. Ensure no unapproved active configs
   before enabling the feature. An existing destination could otherwise send.
6. Obtain explicit feature-enable approval, deploy effective web/worker
   settings, and verify a heartbeat younger than 90 seconds. This makes
   scheduling possible; it is distinct from approving a recipient.
7. Save exactly one approved destination/shop **paused** through the authorized
   interface. Securely install the one-time signing secret at the receiver.
   Never paste it into chat or logs.
8. Review saved revision/scope and obtain explicit **resume** approval.
   Observe the first window, accepted delivery IDs and coverage, and require
   acknowledged `window_complete`. HTTP 200 alone is insufficient.

Do not call the cron endpoint as a readiness probe; it queues real work.
Do not automatically enroll enterprise siblings.

## Stop/recovery

Pause the approved destination to prevent new sends; in-flight requests cannot
be recalled. Revoke only with explicit approval: it removes pending bodies and
signing material. Retry preserves delivery ID/body and rechecks authorization.
Do not reconfigure to bypass failed delivery; it resets approval/baseline.
Keep retention running for paused destinations. If the entire service must stop,
document the retention interruption and recovery before reactivation.

## Local validation

Local validation on 2026-10-23: engine/transport tests (13), dedicated lifecycle
tests (9), and synthetic durable receiver test (1) all pass. TypeScript checks
pass. Runtime dependency imports also passed with network denied and application
credentials stripped, without relying on the test server-only stub.
Re-run the commands in the primary runbook against the release candidate.
These tests do not certify production availability, receiver ownership or live
source-query performance. Export-only lifecycle tests live in
`tests/protractor-export-worker.test.ts`. Run them with the same deny-network
and server-only preloads as the engine suite. No production worker was started.

Lifecycle coverage includes disabled CLI/no clients, invalid enabled configuration,
export-only registration/concurrency, shutdown during preflight or readiness,
Redis readiness failure, serialized heartbeats, disconnection, transient heartbeat
errors and idempotent draining. Real Redis reconnect behavior, process deadlines
under production load and the deployed service's SIGTERM grace period still need
staging validation before activation.
