# Protractor webhook export production setup package

Status: **approved database preparation installed and verified on 2026-10-23**.
Worker/service setup, secrets, enablement and customer delivery remain unapproved.
Read alongside `protractor-organization-exports.md` for the receiver contract.

## Database installation receipt — 2026-10-23

After explicit database-only approval, bounded Mongo checks confirmed a writable
primary, approximately 69 GiB free filesystem capacity, no lock queues or active
index builds, and simple/default collection collations. The initial dbStats
request with freeStorage timed out at three seconds; ordinary dbStats returned
filesystem capacity in 53 ms without the expensive internal free-storage scan.

The operator created the three empty export collections and all seven missing
manifest indexes sequentially. The existing work-order compound index was reused.
No conflicting indexes were changed or dropped, no source records were changed,
and no destination was configured. Health was checked before each build and
periodically while the invoice-cache index built. Stop thresholds were free
space under 20% or 20 GiB, lock queue at least five, connection utilization at
least 80%, dirty cache at least 20%, failed primary status, concurrent index
build before admission, or failed/slow health probes. All gates passed.

Final health at 11:14:46 UTC: 74,048,372,736 bytes free, zero queued requests,
zero index builds, 205 current / 2,795 available connections, 1.92% dirty cache.
Independent strict application preflight at 11:15:00 UTC passed against actual
metadata. Export configuration, state and history collections all remained empty;
worker heartbeat was absent. No feature flags, secrets, services, cron schedules,
reporting jobs or provider calls were changed/started.

Sanitized operator receipts are in the ignored snapshot directory:
`export-index-install-20261023.json` and `export-index-verification-20261023.json`.
Database preparation does not certify PG source query plans or live worker/receiver
behavior; these remain gated before commissioning and delivery.

## Ordered production execution proposal

Prepared after the two export follow-ups merged. The locally tested candidate is
`459f31b05de4cb6c38ce0fef0d2c41c94babbe57`. Record any successor commit and
repeat affected checks before release; do not deploy a moving branch implicitly.
Combined verification passed: prerequisite/lifecycle/engine/transport tests,
synthetic receiver, real Redis lifecycle/recovery suite, and TypeScript.

### Stage A — refresh prerequisites (read-only)

1. Resolve current Render services by name. Confirm their live revisions,
   suspended states, effective/inherited export settings, start commands and
   selected database targets. Do not resume or restart any service.
2. Read Mongo collection options and index definitions for the six collections
   in the manifest. Check export configuration status using metadata only:
   whether active/unpaused destinations exist, never secrets or pending bodies.
3. Check current Mongo storage headroom, source collection sizes, active index
   builds and health. Agree a monitored build window and quantitative stop
   thresholds from those measurements. If capacity/health cannot be established,
   **stop before installation**; PostgreSQL capacity is not a substitute.
4. If PG source/identity canonical flags are effective, verify the appropriate
   connection, source table/index metadata and bounded query plans read-only.
   Any missing PG index or schema needs a separate reviewed change.

### Stage B — index installation (requires explicit approval)

1. Reuse all compatible definitions, including the existing work-order index.
   Reject conflicting names/options and incompatible collection collation;
   never silently replace, drop or rebuild them.
2. Create only the three missing export collections, with simple default
   collation, if still absent. Create the five export metadata indexes from the
   manifest, one at a time.
3. Build the invoice and invoice-cache compound indexes sequentially, monitoring
   the approved health/capacity thresholds. Do not start the next build until the
   previous build is complete and verified. If a build becomes unhealthy, stop
   further admissions and report it; do not assume terminating the client cancels
   a server-side Mongo index build.
4. Run the strict read-only prerequisites check against actual definitions.
   Record created/reused names, options, timestamps and health evidence.

Scope: seven manifest indexes at most, three empty export collections at most.
No operational invoice writes, source deletions, payload collection, TTL on source
data, signing-secret creation, configuration enrollment, worker resume or sends.
The 90-day TTL applies only to export delivery-history receipts.

### Stage C — dedicated service and secrets (separate approval)

1. Present the proposed Render background-service plan, region, ongoing cost,
   availability and Redis connectivity for approval **before creating a paid
   service**. Do not repurpose either suspended general worker.
2. Prepare the exact tested revision with start command
   `npm run worker:protractor-exports`. Use the established repository build and
   dependency setup, ensuring `tsx` is present. No index/schema setup in build
   hooks. Confirm termination grace exceeds the worker's 25-second drain bound.
3. Install the approved Mongo/Redis and, where needed, PG configuration through
   secure configuration. Provision one 32-byte hex encryption key shared by web
   and the export service, without printing or storing it in this document.
4. Explicitly keep `PROTRACTOR_EXPORTS_ENABLED=0` on web and the new service.
   Keep the new service suspended. With this flag disabled, the command exits
   cleanly without connecting: **a healthy persistent consumer or heartbeat is
   not expected and cannot be certified in disabled mode**.
5. Record the pinned release/configuration and keep all unrelated service
   schedules, Protractor traffic guards and reporting flags unchanged.

### Stage D — controlled worker commissioning (separate enable approval)

Before enabling a consumer, inspect allowlisted config/queue metadata and ensure
no unapproved active destination or queued delivery can execute. Do not delete or
replay existing queue jobs as a readiness shortcut.

With explicit approval, deploy the enabled setting to the isolated service while
the web scheduler remains disabled. Verify Redis consumer readiness, exclusive
export-queue registration, heartbeat age under 90 seconds, retention operation
and platform restart behavior. This step may write heartbeat/retention metadata;
it is not part of the read-only checks or disabled installation approval.

Then approve and deploy web enablement only after the same destination/queue
checks. Do not invoke the cron route manually as a probe. Verify normal scheduler
operation without enrolling or resuming an unapproved recipient.

### Stage E — one-shop recipient pilot (separate delivery approval)

Collect the receiver URL/owner, exact shop/enterprise authority, schedule/timezone,
retention agreement and initial-snapshot choice below. Certify fictional delivery
against the real recipient. Save the real configuration paused, transfer the
one-time receiver secret securely, and review its revision before explicit resume.
Success requires durable acknowledgment and terminal window completion with
coverage reviewed—not merely a queue completion or HTTP 200.

At every stage, stop on failed checks and report rather than broadening scope.
The reporting inventory process remains paused throughout this installation.

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
