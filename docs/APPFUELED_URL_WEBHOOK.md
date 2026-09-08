# AppFueled Vehicle URL webhook handoff

> **Implementation status (task #1257):** the receiver, platform-admin setup
> and inspection surface, daily retention job, startup log protection, and
> additive migration `drizzle/0036_task1257_appfueled_url_events.sql` are
> implemented in source. The approved rollout is **QA application code only**.
> QA and production share PostgreSQL and Mongo; the four additive PostgreSQL
> tables have been separately approved and applied. This is not approval to
> deploy the receiver to production or register a real AppFueled feed.
> A live receiver still needs an explicitly configured connection and secure
> callback handoff before AppFueled can deliver its Vehicle URL events.

## Scope and invariants

AppFueled will push the latest customer-facing Vehicle Health Indicator URL to
MOS. This is a new inbound integration; it does not replace or alter existing
QR links, outgoing VHI/CARFAX behavior, the AppFueled partner API, or shop API
authentication.

The callback is:

```http
POST /api/webhooks/appfueled/<secret>
Content-Type: application/json
```

The `<secret>` is a random, high-entropy, revocable token for exactly one
connection. It is shown once when provisioned. It is not an AppFueled partner
API key, shop API key, or reusable credential for another connection. Store
only its lowercase SHA-256 hash; the implementation creates a 32-byte random
base64url token and persists the 64-character hash. Disable or rotate it without
changing independent partner keys.

There is no event ID, source timestamp, or signature in the initial contract.
Do not require one and do not imply ordering or replay protection that the
sender cannot provide.

## Exact initial POST contract

AppFueled sends JSON with these fields:

```json
{
  "data": {
    "event_name": "vhi_url",
    "connection_id": "APPFUELED-ASSIGNED-EXACT-VALUE",
    "mos_shop_id": 50,
    "vin": "1GYS4MKJ4GR434503",
    "vhi_url": "https://customer.example/vehicle/1GYS4MKJ4GR434503"
  }
}
```

| Field | Required validation |
| --- | --- |
| `data` | Required nested JSON object containing the documented event. Top-level event fields are not accepted. |
| `event_name` | Required string, exactly `vhi_url`. |
| `connection_id` | Required string, matched byte-for-byte to the connection provisioned for the URL token. Do not trim, case-fold, parse, or coerce it. |
| `mos_shop_id` | Required JSON number representing a positive safe integer. Do not accept a numeric string. Despite its supplied name, it must exactly equal the connection's configured `incomingShopId`; it is not necessarily the MOS shop ID. |
| `vin` | Required string. The implementation trims, uppercases, and then requires 17 VIN characters excluding I, O, and Q. It never substitutes a VIN from another source. |
| `vhi_url` | Required absolute HTTPS URL passing every check in [URL safety](#url-safety). It is stored as the latest observed candidate; it is not fetched or verified live. |

Cap the raw request body at **16 KiB** before JSON parsing. Reject malformed
JSON, wrong types, unsupported events, unknown/revoked tokens, connection
mismatches, shop mismatches, and unsafe URLs. Do not silently repair or route a
payload to a different connection or shop.

Receipt payloads are an allowlist projection, not a raw request archive.
Unexpected top-level or nested fields and their values are omitted; the URL and
connection value are masked, malformed values are marked invalid, and every
receipt states that source ordering is unknown.

### Shop namespace must be settled before provisioning

The parties must separately confirm, in writing, what AppFueled's incoming shop
identifier represents:

- **`mos` namespace:** configured `incomingShopId` is the MOS shop's own numeric
  ID and must equal the separately configured `mosShopId`; or
- **`provider` namespace:** configured `incomingShopId` is the provider-issued
  shop ID. Provisioning is allowed only after the operator has written evidence
  of the exact canonical provider-ID-to-MOS-shop association.

The field name alone is not evidence that the namespace is `mos`. Preserve the
written answer in the connection's `shopIdNamespace` and
`namespaceConfirmation` binding. Provisioning verifies that the exact
configured `mosShopId` exists by calling `getShopById`; it does **not**
automatically query or prove provider ownership. Provider-mode ownership
evidence is a manual operator prerequisite recorded in the confirmation text.
At runtime the receiver compares the supplied number only with the bound
`incomingShopId`. It never guesses, translates, or invokes a legacy/provider
compatibility mapping. Do not reuse the outgoing `live_api` convention.

## URL safety

Treat `vhi_url` as untrusted stored data.

1. Parse it as an absolute URL and require `https:`.
2. Reject embedded credentials, every explicit port, fragments, malformed
   hosts, and local or private destinations.
3. Match the normalized hostname against the connection's allowlist of bare DNS
   names (for example `customer.example.com`, never
   `https://customer.example.com`). Matching is lowercase and exact; there is no
   substring, suffix, IP-literal, single-label, or wildcard acceptance. Up to 10
   names may be bound. Provision only names an operator separately established
   are public and controlled for this customer.
4. Reject `localhost`, loopback, link-local, private, reserved, multicast, and
   internal-only names or address literals (IPv4 and IPv6). The implementation
   accepts only syntactically valid multi-label DNS names and relies on the
   operator's public-host attestation; it does not resolve DNS.
5. Do **not** make a network request, resolve the page, follow redirects, or
   claim the candidate is live. Validation establishes only that the submitted
   URL is syntactically acceptable and names an allowed public host.

Store and display the candidate only in the intended authenticated product
surface. URL values are sensitive even though their hosts are public.

## Receiver transaction and response behavior

A **2xx response means the durable database transaction committed**. The
implemented success status is HTTP `202`. The handler first authenticates the
SHA-256 token hash and validates the bound `connection_id`, `incomingShopId`,
VIN, and URL. Its capture transaction then:

1. locks the connection and rechecks the current token hash, enabled state, and
   per-connection admission limit;
2. inserts a receipt with the validation outcome/provenance needed for
   operations; and
3. for an accepted event, upserts the VIN/shop association so it contains the
   latest observed accepted
   URL and minimal provenance.

Do not return 2xx after merely queueing an in-memory task. Because the initial
payload has no event ID, timestamp, or signature, repeated valid samples are
separate receipts. The current association is selected by server receipt time
and receipt UUID only; sanitized receipt metadata explicitly says source order
is unknown. Do not advertise source-time ordering or sender deduplication.

A non-2xx is **not** a guarantee that no commit occurred: a delayed response or
deadline boundary can be ambiguous to the sender. Before any manual resend,
filter the restricted receipts by connection/shop/time and compare the response
correlation ID shown in the receipt evidence. Replaying
without checking creates another arrival because AppFueled supplies no stable
event ID.

Target **7 seconds total receiver time**, leaving margin inside AppFueled's
**10-second sender timeout**. AppFueled documents **no automatic retries** and
may **auto-disable repeatedly failing hook URLs**. These are sender behaviors,
not settings implemented by MOS. After fixing a failure, ask AppFueled to
confirm the hook is still enabled before sending a supervised sample.

Every implemented response carries an opaque correlation ID and structured
reason:

```json
{
  "ok": false,
  "reason": "connection_mismatch",
  "correlationId": "opaque-correlation-value"
}
```

Accepted deliveries return `202` with `ok: true` and reason `accepted`.
Authenticated rejections are durably receipted and normally return `400`;
rotation, disabled-connection, and rate-limit races return `401`, `403`, and
`429` respectively. Pre-authentication invalid/unknown tokens return `401` and
the process-local flood gate returns `429` without a receipt. Unsupported media
or encoding returns `415`, oversized input `413`, body timeout `408`, and
storage/deadline failure `503`. Do not use credential-specific response detail
to distinguish an unknown token.

AppFueled support reports should
contain only the correlation ID, structured reason, environment, and
connection/shop aliases approved for support. **Never put callback tokens,
partner keys, request bodies, VIN-linked URLs, or `vhi_url` values in
application logs, metrics labels, alerts, email, chat, or tickets.**

Supported startup commands preload stdout/stderr redaction before Next starts,
including its router and child processes. Instrumentation also redacts console
arguments. Starting Next directly without the preload bypasses that startup
protection and is not a supported deployment command for this receiver.
Neither guard can sanitize access logs emitted by an ingress proxy,
hosting platform, CDN, load balancer, or another process. Before QA or
production registration, operators must verify those upstream access logs
either omit request paths or apply equivalent redaction for
`/api/webhooks/appfueled/<secret>` (including query strings). This is a rollout
prerequisite, not protection the application process can provide.

Receipts have finite **30-day** retention. The implemented
`appfueled-url-retention` job runs daily at `03:09` UTC, deletes receipts whose
`received_at` is older than 30 days, and removes expired rate buckets. It does
not delete the current URL association. The raw accepted URL is retained for
the shop/VIN association and exposed only by the authenticated platform-admin
inspection surface; receipt payload display remains masked. Migration `0036`
creates connection, receipt, current-association, and rate-bucket tables plus
their checks and inspection indexes. The current association key is internal
connection + MOS shop + VIN and retains URL, server receipt time, source
receipt UUID, and update time.

## Callback URL construction and provisioning

Application code must build the callback base with the shared
`getAppBaseUrl()` helper in `lib/app-host.ts`, not a duplicated environment
constant. At provision time an operator must explicitly verify that the
resolved host belongs to the intended environment before revealing or
registering the URL. Reject a local, Replit development, raw infrastructure,
cross-environment, or otherwise unexpected host.

The QA host has been verified. Tokens remain placeholders, not reusable
credentials or claims that a real AppFueled feed has been registered:

```text
QA_TEMPLATE:   https://www.qa.mos.tools/api/webhooks/appfueled/<ONE_TIME_QA_TOKEN>
PROD_TEMPLATE: https://<PROD_HOST_PENDING_ROLLOUT_VERIFICATION>/api/webhooks/appfueled/<ONE_TIME_PROD_TOKEN>
```

Do not copy a QA token to production. Record connection metadata and a token
fingerprint, but reveal the full callback exactly once over the approved secret
handoff channel. Redact it thereafter.

### Shared-storage production gate

QA and production currently use the same effective PostgreSQL connection,
including inherited Render environment-group settings. A service-local
environment-variable listing alone does not establish database isolation.

The connection/token records do not currently contain an environment binding.
The issuance-host allowlist controls which callback URL is generated; it does
not restrict which deployment can authenticate the token. Before this receiver
is deployed to production, either isolate its QA storage or implement and test
environment-bound authentication and administration. Do not treat the QA-only
code release or additive-table approval as production activation approval.

## Provisioning and QA checklist

### Written decisions and implementation review

- [ ] Obtain written AppFueled confirmation of the incoming shop namespace:
      exactly `mos` or `provider`.
- [ ] Obtain the exact, case-sensitive `connection_id` and document who owns it.
- [ ] Verify the target MOS shop and canonical provider independently; retain
      written evidence linking the confirmed incoming ID to that MOS shop.
- [ ] Agree on the exact allowed public customer hostname(s), with no wildcard.
- [ ] Confirm AppFueled will send the nested `data` object with the five event
      fields and that
      no event ID, timestamp, or signature is expected.
- [ ] Review implemented migration
      `drizzle/0036_task1257_appfueled_url_events.sql`, token
      hashing/revocation, constraints, transaction boundaries, latest-update
      semantics, URL parser/allowlist, body limit, timeout, redaction, and
      authorization of every URL reader before approving rollout.
- [ ] Verify the 30-day receipt cleanup schedule, monitoring, and retention of
      only minimal current-association provenance.
- [ ] Confirm no existing QR, outgoing VHI/CARFAX, partner API, or shop API path
      changed.

### QA provisioning and delivery

- [ ] Apply the separately approved schema migration in QA; this document does
      not apply one.
- [ ] Deploy the reviewed receiver and cleanup job to QA.
- [ ] Resolve the base host through `lib/app-host.ts`; have an operator verify
      the exact QA host and HTTPS URL before proceeding.
- [ ] Generate a random per-connection token through the setup surface, persist
      only its SHA-256 hash, and reveal the complete QA callback once through
      the approved secret channel.
- [ ] Bind the token to the exact `connection_id`, verified MOS shop, confirmed
      namespace/mapping, environment, and hostname allowlist.
- [ ] Register that callback with AppFueled.
- [ ] Ask AppFueled to enable its **Vehicle URL** task. Confirm awareness of
      its documented 10-second timeout, no retries, and possible automatic
      disabling of repeatedly failing hook URLs.
- [ ] Have AppFueled create a sample and verify a 2xx receipt committed and the
      association stores the latest observed URL.
- [ ] Have AppFueled update the same sample and verify a new receipt and that
      the stored latest observed URL changes as designed.
- [ ] Repeat create/update sample deliveries to exercise repeat-arrival
      behavior without assuming event-ID deduplication or source ordering.
- [ ] Exercise safe failure cases (wrong connection/shop, revoked token,
      disallowed host, oversized/malformed body) and verify structured reasons,
      correlation IDs, redaction, and AppFueled auto-disable behavior. For each
      non-2xx, inspect by correlation before considering a resend; do not assume
      rollback from the HTTP status alone.
- [ ] Practice recovery: diagnose by correlation ID without exposing the URL or
      token, rotate/re-register if needed, then deliberately re-enable the task
      and repeat a live QA sample.

### Production rollout approval gate

Migration, deployment, registration, and a live sample each require explicit
rollout approval. Approval should identify the reviewed commit/migration, QA
evidence, confirmed namespace evidence, verified shop/connection/host binding,
rollback owner, and support owner.

- [ ] Approve and apply the production migration.
- [ ] Approve and deploy the production receiver and scheduled cleanup.
- [ ] Resolve and independently verify the production host.
- [ ] Generate a new production-only token and reveal the callback once.
- [ ] Register the production callback and verify AppFueled's task settings.
- [ ] Approve and send one controlled live sample; verify durable receipt and
      latest observed URL without copying URL/token data into the rollout log.
- [ ] Confirm failure reporting, auto-disable, revocation/rotation, rollback,
      and re-enable ownership before expanding beyond the first connection.

## Future MOS recovery client (not implemented)

AppFueled documents these existing lookup APIs for later gap recovery:

```http
GET /vehicle_url?vin=<vin>
GET /vehicle_url_list

X-Connection-Id: <connection-id>
X-Api-Key: <separately-provisioned-api-key>
X-Api-Secret: <separately-provisioned-api-secret>
```

The list is paginated at **100 records per page** and supports inserted/updated
date ranges. A future recovery operation can look up one VIN or page through
an agreed date window after a hook outage. Confirm exact pagination and range
parameter names, timezone/boundary semantics, and response shapes against the
then-current AppFueled documentation before implementing that client.
The headers above are separate backend credentials, not the MOS bearer URL
token or existing MOS partner key. Obtain them through the approved secrets
flow only when that future work is authorized. MOS has no client or scheduled
reconciliation implementation and makes no lookup/list calls in this receiver.

Future source event IDs and source timestamps could provide deterministic
deduplication and ordering. A future signature with a defined canonicalization,
algorithm, timestamp tolerance, and key-rotation procedure could add replay and
integrity protection. None may be enforced until AppFueled explicitly adds it
to the versioned contract.

## Offline implementation verification

- Contract, HTTP/body limits, authentication, admin authorization, transaction
  fakes, cron authorization, and redaction: `npm run test:appfueled-url-events`.
- Real PostgreSQL constraints, concurrent deliveries, rollback, rotation races,
  retention/provenance, no-policy RLS, and idempotent migration:
  `npm run test:appfueled-url-events:postgres`. Requires local PostgreSQL binaries;
  the test creates and destroys a private socket-only temporary cluster. It
  does not read project database credentials or apply the migration externally.
- Browser setup/inspection interactions:
  `node tests/appfueled-url-events.browser.cjs` against an isolated development
  preview. The feature API is intercepted with synthetic fixtures.
- These checks passed, as did typecheck, auth-route lint, related AppFueled
  partner checks, and notification compatibility checks. An actual isolated
  Next request with a synthetic token confirmed its access-log path is redacted.
- Full release prebuild was attempted but stopped in the existing native
  print-queue/canvas smoke at missing `libuuid.so.1`; a full production build
  is not claimed. Resolve that environment dependency and rerun release gates
  before deployment.
- No external schema application, real connection credentials, registered hook,
  QA/production deployment, or live sample is claimed by these offline checks.