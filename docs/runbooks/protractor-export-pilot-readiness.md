# Protractor export pilot preparation

Assessment date: **2026-10-22 UTC**. Decision: **not cleared for live delivery**.
Preparation is not activation. No real destination or shop has been approved by
this assessment; no configuration, secret, index, worker schedule or flag was changed.
No customer payload was queried, no upstream provider was called, and no export
cron or application startup was invoked.

## Evidence and limits

| Check | Evidence / status |
| --- | --- |
| Task-workspace deployment | Read-only deployment metadata on 2026-10-22 reports success, `isDeployed:false`, `hasSuccessfulBuild:false`. This is only this workspace, **not** proof that the separate production Render services are absent or inactive. |
| Encryption key presence | Read-only secret-existence check for this workspace's production/shared scope on 2026-10-22 reports `PROTRACTOR_EXPORT_ENCRYPTION_KEY:false`. No value was requested or disclosed. Separate production web/worker installation remains **unverified**. |
| Feature flag | Read-only environment metadata for this workspace's production/shared scope on 2026-10-22 returns no `PROTRACTOR_EXPORTS_ENABLED` entry. Separate running production flag remains **unverified**, not “off.” |
| Production log access | On 2026-10-22 the connected read-only log service could not resolve the previously documented production source (record not found). No log records were returned. Production cron execution and worker health cannot be inferred from this result. |
| Named indexes | **Unverified** in production. No direct DB connection/helper was started: this environment's Mongo can be shared with production, and normal application initialization is not an acceptable metadata-only check. No approved metadata-only production database interface was established during this preparation. |
| Cron registration | **Verified in source only:** `lib/cron/jobs.cjs` registers `protractor-exports` every minute with a 30-second request timeout. Production loaded registration, fencing and recent execution remain **unverified**. Never invoke its route to test readiness: it can enqueue real work. |
| Worker | **Verified in source only:** `workers/worker.ts` builds a concurrency-one consumer only when the feature flag is `1`; heartbeat starts after consumer readiness. Repository admission requires a heartbeat newer than 90 seconds. Live consumer/Redis connection, heartbeat and retention execution remain **unverified**. |
| Schedule availability | **Unresolved input:** no pilot HH:mm or IANA zone selected. Source schedules historical-worker suspension at 05:00 and resume at 18:00 America/Chicago on weekdays. Live managed-service membership/overrides and which worker will consume exports must be verified; these source times are not proof of availability. |
| Real recipient | **Not supplied / not tested:** ownership, public IPv4 DNS, HTTPS/443 certificate, secret installation, durable inbox, retention and redistribution contract. Synthetic success is not recipient certification. |

Source audit on 2026-10-22: contract, transport, engine, authorization, export
repository, enterprise/cron routes, export settings page, worker registration
and processor, and existing isolated tests. Production code was not changed.
Destination restrictions remain HTTPS/443, public pinned IPv4 per attempt, no
credentials/query/fragment/IP literal/redirect; each send/retry rechecks explicit
shop authorization. Latest-observed snapshots exclude DVI and do not represent
every version, full history or deletions. A baseline without initial snapshot
sends only subsequent detected changes plus completion markers.

## Synthetic evidence

Verification on **2026-10-22, 13:06 UTC**: 13 engine/production-transport
tests passed with all network access denied; the synthetic receiver test passed
with loopback explicitly enabled. A focused strict TypeScript check of both new
test files and their transport/contract imports passed. No application/UI was
started: this task changes no UI and startup could touch shared production stores.
This is local contract evidence, not production or recipient certification.

Commands and fixture behavior are in
[the export runbook](protractor-organization-exports.md#synthetic-receiver-rehearsal-no-activation).
The fixture contains only this fictional record (the full envelope is generated
in `tests/protractor-export-synthetic.test.ts`):

```json
{
  "shopId": 999999,
  "entityType": "invoice",
  "providerId": "fictional-invoice",
  "observedAt": "2026-10-22T00:00:00Z",
  "source": "mongo.protractor_invoices",
  "payload": {
    "ID": "fictional-invoice",
    "InvoiceNumber": "SYNTHETIC-ONLY",
    "Total": 12.34
  }
}
```

The test generates random IDs/secret; signatures are never printed. HTTP headers
follow v1: `x-mos-delivery-id`, Unix-seconds `x-mos-timestamp`, and
`x-mos-signature: v1=<HMAC-SHA256(timestamp.deliveryId.exact-body)>`.
Only a 2xx with `x-mos-acknowledgment` equal to the sent delivery ID counts.

## One-shop handoff — all boxes required before a separately approved pilot

- [ ] Name the destination owner and accountable recipient operator; confirm
  their public HTTPS/443 URL, DNS/TLS and durable acceptance contract.
- [ ] Record the **one exact shop ID**, enterprise, current ownership, connected
  Protractor account, active maintenance entitlement, and authorized approver.
  Employee history access or sibling membership is not redistribution authority.
- [ ] Obtain explicit redistribution approval, receiving-party contract/DPA,
  dataset scope (work orders/invoices only), and receiver retention/deletion policy.
- [ ] Choose HH:mm and IANA timezone. Confirm actual consuming worker availability
  at that schedule and retention processing while paused; assess DST and outages.
- [ ] Choose initial available-data snapshot or baseline-only in writing. Confirm
  latest-only limitations, incomplete-coverage indicators, and that missed days
  cannot be reconstructed from overwritten cache snapshots.
- [ ] In a separately authorized read-only production session, verify deployed
  revision and effective feature flag on both web and worker; verify encryption-key
  presence/validity without revealing it. Do not decrypt signing material.
- [ ] Read index **metadata only**: match keys/options as well as names:
  `export_active`, `export_status`, `export_retention`, `export_history_ttl`
  (TTL 7776000 seconds); history enterprise/acceptedAt index; cache identity
  compound indexes and collation; applicable PG primary keys. See the primary
  runbook for exact keys. Missing indexes need separate mutation approval.
- [ ] Read deployed cron registration/recent metadata and only
  `protractor_export_health` worker `seenAt`; verify age under 90 seconds and
  dedicated queue readiness at the chosen schedule. Do not query pending bodies,
  customer caches or dispatch a cron to prove health.
- [ ] Approve any production installation, flag, key, index or schedule changes
  separately. No command in this preparation authorizes them.
- [ ] After those approvals, save exactly that shop/destination **paused**.
  Securely install the one-time receiver secret; do not paste it into chat/logs.
  Certify recipient deduplication and acknowledgment behavior before real data.
- [ ] Explicitly approve **resume** after checking the saved revision and scope.
  Name the pilot observer, first-window acceptance criteria and stop authority.
  Recheck coverage and terminal `window_complete`, not just HTTP success.
- [ ] Confirm pause/revoke response: pause prevents new sends but cannot recall
  in-flight requests; revocation removes pending bodies/signing material.
  Retry retains ID/body and rechecks authority. Reconfiguration cancels old
  pending work and resets baseline, so is not a retry shortcut.

Unknown checks are blockers, not assumptions. Live activation and any customer
delivery require a new explicit approval after this handoff.
