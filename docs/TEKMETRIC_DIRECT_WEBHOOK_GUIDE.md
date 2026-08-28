# Tekmetric Direct Webhook Receiver Guide

This guide is for a separate program that will receive Tekmetric webhooks
directly. It describes a safe receiver design and records what this repository
can prove from its current receiver.

> **Important:** This repository is not authoritative Tekmetric documentation.
> Its subscription endpoint, event list, signature header, algorithm, encoding,
> delivery ID, timestamp, retry behavior, and ordering assumptions are
> configurable scaffolding. Confirm those details with Tekmetric Partner
> Engineering before enabling production traffic or signature enforcement.

## 1. Evidence and confidence levels

Claims in this guide use these labels:

| Label | Meaning |
| --- | --- |
| **Confirmed locally** | Implemented and exercised by this repository's receiver, adapter, or tests. This confirms what this application accepts, not what Tekmetric guarantees. |
| **Inferred** | A defensive behavior derived from observed application needs or repository comments. Build for it, but do not present it as Tekmetric's contract. |
| **Confirm with Tekmetric** | Partner-specific behavior that this repository does not establish authoritatively. |

Repository evidence reviewed:

- `app/api/webhooks/tekmetric/route.ts`
- `app/api/webhooks/tekmetric/verify-signature.ts`
- `lib/integrations/tekmetric/webhook-subscribe.ts`
- `tests/tekmetric-webhook-subscribe-retry.smoke.ts`
- `tests/tekmetric-webhook-signature.smoke.ts`
- `lib/integrations/tekmetric/normalized-adapter.ts`
- `lib/integrations/tekmetric/webhook-coverage.ts`

## 2. Recommended receiver endpoint

Expose a dedicated HTTPS endpoint, for example:

```http
POST https://receiver.example.com/webhooks/tekmetric
Content-Type: application/json
```

Operational requirements:

- Require TLS and a publicly trusted certificate.
- Accept `POST` only for delivery. A separate unauthenticated health endpoint
  may report process health, but it must not reveal secrets or event data.
- Preserve the exact request bytes before parsing JSON. Signature verification
  must run against those bytes, not re-serialized JSON.
- Set a request body limit appropriate to the largest payload Tekmetric
  confirms. Reject oversized requests before buffering them indefinitely.
- Authenticate the sender using Tekmetric's confirmed signing contract. If
  Tekmetric does not sign deliveries, agree on another partner-supported
  control such as mTLS or an unguessable per-integration credential; an IP
  allowlist alone is not sufficient.
- Persist a durable inbox record, then acknowledge quickly. Perform API
  enrichment and business processing asynchronously.

### Response behavior

Recommended responses:

| Condition | Response | Notes |
| --- | --- | --- |
| Valid, durably recorded delivery | `200` or `204` | **Confirm with Tekmetric** which success codes are accepted. Return only after the inbox write commits. |
| Valid duplicate already recorded | Same success code | Duplicate delivery is a successful no-op. |
| Invalid JSON | `400` | Locally confirmed receiver behavior. |
| Missing or invalid signature | `401` | Locally confirmed receiver behavior when verification is enabled. |
| Oversized payload | `413` | Defensive recommendation. |
| Temporary inability to durably record | `500` or `503` | Use only if Tekmetric confirms these responses are retried. |

The current local receiver returns JSON `{ "success": true }` with HTTP 200
after inline processing. It returns 400 for invalid JSON, 401 for an invalid
signature, and 500 for an unhandled processing failure. A new receiver should
improve on this by durably recording first and moving all nonessential work off
the response path.

**Confirm with Tekmetric:** acknowledgement deadline, accepted 2xx codes,
timeout behavior, retryable status codes, retry schedule, maximum attempts, and
whether redirects are followed.

## 3. Inbound envelope

### Envelope shapes accepted by this repository

**Confirmed locally:** the receiver extracts the event name from the first
available field:

```text
event | eventType | type
```

It extracts event data from:

```text
data | payload | the root object
```

It accepts a repair order in any of these locations:

```text
data.repairOrder
root.repairOrder
data itself, when it has id + repairOrderNumber + shopId
```

These variants are compatibility behavior, not proof that Tekmetric officially
sends every shape. Preserve the original envelope in the inbox, then normalize
it internally.

### Sanitized representative payloads

The following examples demonstrate shapes accepted by this application. They
are **not official Tekmetric samples**.

Nested repair-order envelope:

```json
{
  "event": "RepairOrder.Updated",
  "data": {
    "repairOrder": {
      "id": 987654,
      "repairOrderNumber": 4321,
      "shopId": 123,
      "vehicleId": 456,
      "customerId": 789,
      "repairOrderStatus": {
        "name": "In Progress",
        "code": "IN_PROGRESS"
      },
      "milesIn": 81234,
      "createdDate": "2026-08-28T14:20:00Z",
      "updatedDate": "2026-08-28T14:35:00Z"
    }
  }
}
```

Flat repair-order envelope:

```json
{
  "eventType": "RepairOrder.Posted",
  "payload": {
    "id": 987654,
    "repairOrderNumber": 4321,
    "shopId": 123,
    "vehicleId": 456,
    "customerId": 789,
    "repairOrderStatus": {
      "name": "Posted",
      "code": "POSTED"
    },
    "milesOut": 81247,
    "completedDate": "2026-08-28T18:05:00Z",
    "postedDate": "2026-08-28T18:10:00Z",
    "jobs": [
      {
        "id": 111,
        "name": "Oil and filter service",
        "authorized": true,
        "labor": [],
        "parts": []
      }
    ]
  }
}
```

Inspection-complete envelope:

```json
{
  "type": "Inspection.Complete",
  "data": {
    "repairOrderId": 987654,
    "shopId": 123,
    "inspectionId": 2468,
    "completedDate": "2026-08-28T16:00:00Z"
  }
}
```

The local receiver also recognizes `repair_order_id` and `roId` in inspection
and customer-viewed payloads.

## 4. Event support matrix

Event matching in the current receiver is intentionally broad and
case-insensitive. The exact names in the first column are therefore
**partner-confirmation items**, even when the local code lists them.

| Candidate event | Local handling | Confidence and caveats |
| --- | --- | --- |
| `RepairOrder.Created` | Upserts an RO and defers vehicle/customer enrichment and normalized ingestion. | Event name: **confirm with Tekmetric**. Lifecycle handling: **confirmed locally**. |
| `RepairOrder.Updated` | Same nonterminal upsert path. | Event name: **confirm with Tekmetric**. |
| `RepairOrder.StatusChanged` | Processes the RO; terminal status names/codes trigger close/post behavior. | Event name: **confirm with Tekmetric**. |
| `RepairOrder.Posted` | Terminal processing, job indexing, cache invalidation, deferred normalized ingestion. | Listed by local endpoint; exact Tekmetric event: **confirm**. |
| `RepairOrder.Invoiced` | Treated as terminal/invoiced. | Listed by local endpoint; exact Tekmetric event: **confirm**. |
| `Inspection.Complete` / `InspectionComplete` / wording containing inspection plus complete or marked complete | Marks the DVI complete and attempts to fetch the full inspection task list. | Matching behavior: **confirmed locally**. Official spelling and payload: **confirm**. |
| `CustomerViewedInspection` or an event name containing customer plus viewed | Marks a customer-viewed timestamp when an RO ID is present. | Matching behavior: **confirmed locally**. Official availability/name: **confirm**. |
| Standalone vehicle update | No dedicated local handler. Vehicle data is enriched from an RO's `vehicleId`. | **Confirmed local gap**; ask whether Tekmetric offers this event. |
| Standalone customer update | No dedicated local handler. Customer data is enriched from an RO's `customerId`. | **Confirmed local gap**; ask whether Tekmetric offers this event. |
| Unknown event | May be logged and acknowledged without domain processing. | Defensive forward-compatibility recommendation. |

The local auto-subscription scaffold proposes only
`RepairOrder.Created`, `RepairOrder.Updated`, `RepairOrder.StatusChanged`, and
`Inspection.Complete`. Its source explicitly says the event catalog is not
authoritative.

## 5. Repair-order fields

### Minimum routing identity

For useful RO processing, require:

| Field | Need | Reason |
| --- | --- | --- |
| `id` | Required | Stable Tekmetric repair-order identifier and preferred entity key. |
| `shopId` | Required | Tenant routing and isolation. Never look up an RO by `id` alone across shops. |
| `repairOrderNumber` | Strongly recommended | Human-readable reference and the local flat-payload discriminator. It is not a substitute for `id`. |

The pair `(shopId, id)` should be the receiver's repair-order identity.

### Optional but valuable fields

The local receiver and adapter can use:

- Lifecycle: `repairOrderStatus.name`, `repairOrderStatus.code`,
  `createdDate`, `updatedDate`, `completedDate`, `postedDate`,
  `promisedDate`
- Relations: `vehicleId`, `customerId`
- Vehicle snapshot: `vehicle.vin`, `vehicle.year`, `vehicle.make`,
  `vehicle.model`, `vehicle.subModel`, `vehicle.engineDescription`,
  `vehicle.licensePlate`
- Customer snapshot: `customer.firstName`, `customer.lastName`,
  `customer.companyName`, or `customerName`
- Mileage: `milesIn`, `milesOut` (the adapter also tolerates
  `mileageIn`/`mileageOut`)
- RO details: `jobs`, `payments`, `inspections`, `customerConcern`,
  `technicianNotes`, `notes`, `serviceWriter`
- Totals: `laborSubtotal`, `partsSubtotal`, `subletSubtotal`, `taxTotal`,
  `discountTotal`, `total`, `balanceDue`, `feeSubtotal`,
  `shopSuppliesTotal`, `totalLaborHours`, `billedLaborHours`
- Labels: `repairOrderCustomLabel.name`, `repairOrderLabel.name`, `color`

Do not reject a valid lifecycle event solely because optional rich fields are
missing. Store it, mark enrichment needs, and fetch the current RO/vehicle/
customer state asynchronously.

### Money and line-item warning

**Confirmed locally:** in the adapter's currently observed job detail shape,
labor `rate` and part `cost`/`retail` are treated as cents and divided by 100.
Do not generalize that rule to every webhook total. Confirm units for every
money field with Tekmetric and retain the original integer/value alongside the
normalized amount until the contract is proven.

## 6. Normalized internal event

Normalize compatibility variants into one internal structure while retaining
the raw event:

```ts
type TekmetricWebhookEvent = {
  eventName: string;
  shopId?: number;
  repairOrderId?: number;
  repairOrderNumber?: string;
  occurredAt?: string;       // only if Tekmetric supplies a trusted event time
  deliveryId?: string;       // only if Tekmetric supplies one
  repairOrder?: unknown;
  payload: unknown;
  receivedAt: string;
};

function normalizeEnvelope(body: any): TekmetricWebhookEvent {
  const eventName = String(body?.event ?? body?.eventType ?? body?.type ?? "");
  const payload = body?.data ?? body?.payload ?? body;
  const repairOrder =
    payload?.repairOrder ??
    body?.repairOrder ??
    (payload?.id && payload?.repairOrderNumber && payload?.shopId
      ? payload
      : undefined);

  return {
    eventName,
    shopId: Number(repairOrder?.shopId ?? payload?.shopId) || undefined,
    repairOrderId:
      Number(repairOrder?.id ?? payload?.repairOrderId ??
        payload?.repair_order_id ?? payload?.roId) || undefined,
    repairOrderNumber:
      repairOrder?.repairOrderNumber != null
        ? String(repairOrder.repairOrderNumber)
        : undefined,
    repairOrder,
    payload,
    receivedAt: new Date().toISOString(),
  };
}
```

Do not discard unknown fields. Version the normalizer independently from the
raw inbox schema.

## 7. Secure receiver behavior

### Raw-body signature verification

The local repository has configurable HMAC scaffolding with defaults of
`x-tekmetric-signature`, HMAC-SHA256, and hex encoding, optionally stripping a
prefix such as `sha256=`. **None of those defaults is an official Tekmetric
guarantee.**

Confirm all of the following before implementing or enabling enforcement:

1. Whether Tekmetric signs webhook deliveries.
2. Exact signature header name and whether more than one signature is sent
   during secret rotation.
3. Algorithm and key interpretation.
4. Hex, Base64, Base64URL, or another encoding.
5. Signed bytes: raw body only, or a canonical string including timestamp,
   method, path, delivery ID, or other fields.
6. Prefix and multi-value syntax.
7. Timestamp header, allowed clock skew, and replay-verification procedure.
8. Secret issuance, rotation, overlap, revocation, and whether secrets are
   per partner, per shop, or per subscription.

Framework-neutral TypeScript pattern, to adapt only after confirmation:

```ts
import crypto from "node:crypto";

function verifyHmac(params: {
  rawBody: Buffer;
  provided: string;
  secret: string;
  encoding: "hex" | "base64";
}): boolean {
  const expected = crypto
    .createHmac("sha256", params.secret) // confirm algorithm
    .update(params.rawBody)              // confirm signed content
    .digest();

  let actual: Buffer;
  try {
    actual = Buffer.from(params.provided, params.encoding);
  } catch {
    return false;
  }

  // Check length before timingSafeEqual; it throws for unequal lengths.
  return actual.length === expected.length &&
    actual.length > 0 &&
    crypto.timingSafeEqual(actual, expected);
}
```

Read the raw bytes once:

```ts
async function receive(req: Request): Promise<Response> {
  const rawBody = Buffer.from(await req.arrayBuffer());
  // Verify rawBody before JSON.parse. Never verify JSON.stringify(parsedBody).
  // Apply the partner-confirmed signature/timestamp rules here.

  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  // Validate, durably enqueue, then acknowledge.
  return Response.json({ success: true }, { status: 200 });
}
```

### Replay protection

An HMAC over only the body proves integrity/authenticity but does not by itself
prevent replay. Prefer a Tekmetric-provided unique delivery ID plus signed
timestamp:

- Reject timestamps outside a partner-agreed window after accounting for
  clock skew.
- Atomically insert the delivery ID into a unique inbox key; a conflict is a
  successful duplicate.
- Retain deduplication records at least as long as Tekmetric's maximum retry
  and manual-redelivery window.
- If no delivery ID exists, derive a fallback content key as described below.
  This reduces duplicate processing but is not cryptographic replay prevention.

### Secrets and logs

- Store signing secrets in a managed secret store, never source control,
  payload tables, logs, metrics, exception text, or client-side code.
- Support current and previous secrets during a bounded rotation overlap.
- Redact authorization, cookie, signature, and API-key headers.
- Treat payloads as sensitive customer/vehicle data. Log event name, shop ID,
  RO ID, delivery ID, outcome, latency, and error class—not full payloads.
- Encrypt durable payload storage and apply access controls, retention, and
  deletion policies appropriate to the receiving program.

## 8. Reliable ingestion and processing

### Durable inbox and idempotency

Use an inbox table/queue with a unique idempotency key and these conceptual
states:

```text
received -> processing -> processed
                      \-> retryable_failed -> processing
                      \-> dead_letter
```

Choose the key in this order:

1. Partner-confirmed Tekmetric delivery ID, ideally scoped by subscription.
2. A partner-confirmed immutable event ID.
3. Fallback hash of stable fields, for example:

```text
SHA-256(shopId | eventName | repairOrderId | upstreamUpdatedDate | rawBody)
```

The fallback must include the raw-body hash so two legitimate updates to the
same RO are not collapsed. Do not use only `(shopId, repairOrderId, eventName)`.

Atomically insert the inbox row before returning success. If the key already
exists, return success without re-running side effects. Make downstream writes
idempotent as well: upsert current entity state, and protect non-idempotent
effects such as notifications with their own unique effect keys.

### Fast acknowledgement and asynchronous work

The request path should only:

1. Enforce transport/body limits.
2. Capture raw bytes.
3. Verify sender authenticity and replay fields.
4. Parse and minimally validate JSON.
5. Durably insert the inbox record.
6. Return the agreed success response.

Move REST calls, full schema validation, enrichment, normalization, analytics,
notifications, and fan-out to workers. The local receiver defers several
enrichment paths because a live vehicle lookup can exceed the sender's webhook
deadline and cause duplicate delivery.

### Duplicates, retries, and dead letters

- Expect at-least-once delivery unless Tekmetric explicitly guarantees
  otherwise.
- Retry worker failures with exponential backoff and jitter.
- Classify errors: retry network failures, 429s, and most 5xx responses;
  dead-letter malformed or permanently unauthorized work after bounded
  attempts.
- Honor `Retry-After` where supplied.
- Keep the original payload, attempt count, first/last error class, and next
  retry time.
- Provide controlled replay from dead letter without changing the idempotency
  identity.

The repository's *outbound subscription scaffold* retries network failures,
429s, and 5xx responses, while failing fast on other 4xx responses. That is a
reasonable client pattern, but it does not prove Tekmetric's delivery policy.

### Ordering and stale-event protection

Assume events may be delayed or out of order until Tekmetric confirms ordering
scope and guarantees.

- Partition work by `(shopId, repairOrderId)` when practical.
- Prefer fetching and upserting current Tekmetric state over applying an
  irreversible transition from a thin event.
- If the payload has a trustworthy upstream `updatedDate` or sequence, retain
  the highest applied version and prevent older events from overwriting newer
  snapshots.
- Never order solely by local receipt time.
- Do not discard an older event if it represents a distinct immutable fact;
  deduplicate facts separately from the mutable RO snapshot.

### Enrichment and polling reconciliation

Webhook payloads may be incomplete. **Confirmed locally:** an RO event may have
`vehicleId` but no VIN. The local system cannot complete VIN-keyed normalized
ingestion until it enriches the vehicle. Inspection-complete handling also
fetches the full inspection list because the event itself may be only a signal.

Worker strategy:

1. Store the raw event and any rich RO snapshot immediately.
2. If `vehicleId` is present but VIN/vehicle fields are absent, fetch the
   vehicle.
3. If `customerId` is present but customer fields are absent, fetch the
   customer when needed.
4. For inspection completion, fetch the full inspection/task state if the
   webhook lacks it and the relevant Tekmetric endpoint/credentials are
   available.
5. For terminal ROs with absent `jobs`, fetch current RO/job detail before
   declaring processing complete.
6. Mark unresolved fields explicitly and retry with bounded backoff.
7. Run periodic incremental polling as a safety net for missed events,
   incomplete enrichment, standalone vehicle/customer changes, and webhook
   outages.

Poll using a cursor with overlap, then idempotently upsert. Do not permanently
disable polling merely because subscription registration returned success.
Require evidence of recent deliveries, monitor freshness, and automatically
fall back to faster polling when the webhook becomes stale. This repository
uses a 20-minute safety-net default and 24-hour liveness default; those are
local operational choices, not Tekmetric requirements.

### Observability

Track at minimum:

- Request count by HTTP status and event name
- Signature failures, timestamp failures, replay rejections, invalid JSON,
  oversized requests, and unknown events
- Acknowledgement latency percentiles and timeout count
- Inbox insert failures and queue depth/oldest age
- Processing success/failure/retry/dead-letter counts
- End-to-end lag from upstream event time and from local receipt time
- Duplicate rate by idempotency source
- Per-shop last successful delivery and last successful reconciliation
- Enrichment misses (no VIN, vehicle, customer, jobs, or inspections)
- Subscription state separately from actual delivery liveness

Use correlation fields such as delivery ID, shop ID, RO ID, event name, and
worker attempt. Alert on stale shops, growing queue age, sustained signature
failures, dead letters, polling drift, and a success response generated without
a committed inbox record.

## 9. Subscription and onboarding

This repository contains a default-off subscription scaffold that models:

```http
POST {configurable-template-with-shopId}
Authorization: Bearer <partner token>
Content-Type: application/json

{
  "url": "https://receiver.example.com/webhooks/tekmetric",
  "events": [
    "RepairOrder.Created",
    "RepairOrder.Updated",
    "RepairOrder.StatusChanged",
    "Inspection.Complete"
  ]
}
```

It contains an example template resembling:

```text
https://shop.tekmetric.com/api/v1/shop/{shopId}/webhooks
```

**Do not use that endpoint, request body, event list, token, or response shape
without written Tekmetric confirmation.** The source explicitly labels the
endpoint as unverified and configurable. It tentatively reads a returned
subscription identifier from either `id` or `subscriptionId`; that is also not
an established contract.

Ask Tekmetric whether registration is API-driven, portal-driven, or performed
by Partner Engineering. Also confirm create/list/update/delete operations so
the receiving team can rotate URLs, audit configuration, and remove stale
subscriptions safely.

## 10. Questions for Tekmetric Partner Engineering

Obtain written answers and representative signed test deliveries for:

### Delivery transport

- Official callback registration process and endpoint, if any
- Authentication and authorization needed to manage subscriptions
- Whether subscriptions are per shop, partner, environment, or account
- Test/sandbox support and source separation from production
- Callback URL validation/challenge behavior
- Supported TLS versions, ports, DNS restrictions, and payload size limit

### Event contract

- Complete event catalog and exact case-sensitive names
- Which RO lifecycle transitions emit events
- Availability of inspection-complete and customer-viewed events
- Availability of standalone vehicle/customer events
- Canonical envelope and schema/version field
- Required fields for each event and nullability rules
- Field units, especially all money and odometer fields
- Meaning and uniqueness scope of RO, event, delivery, shop, vehicle, customer,
  inspection, job, labor, and part IDs

### Security

- Whether deliveries are signed
- Header names, signature algorithm/encoding/prefix, and exact signed content
- Timestamp and delivery-ID headers and whether they are covered by signature
- Replay window and expected clock tolerance
- Secret scope, issuance, storage expectations, rotation, overlap, revocation
- Whether mTLS or source ranges are available as defense in depth

### Reliability

- Acknowledgement deadline and accepted status codes
- Which responses/timeouts trigger retry
- Retry schedule, jitter, maximum attempts, and manual redelivery window
- At-least-once or other delivery semantics
- Ordering guarantees and their scope
- Maximum event delay and maintenance/outage behavior
- Whether the same delivery ID remains stable across retries
- Recommended reconciliation endpoints, cursor semantics, rate limits,
  pagination, and `Retry-After` behavior

## 11. Test plan before production

Run these tests with Tekmetric-generated deliveries rather than only local
fixtures:

1. **Connectivity:** Tekmetric can reach the HTTPS endpoint and accepts its
   success response.
2. **Canonical payload:** capture a sanitized example of every subscribed event
   and compare it with the written schema.
3. **Signature:** verify an untouched raw body; reject a changed byte, missing
   signature, malformed encoding, wrong secret, and stale timestamp.
4. **Secret rotation:** accept both secrets only during the agreed overlap,
   then reject the old one.
5. **Duplicate:** redeliver the same delivery and prove one inbox row and one
   set of side effects.
6. **Distinct updates:** send two updates for the same RO and prove neither is
   collapsed by the fallback key.
7. **Out of order:** deliver a newer update before an older update and prove
   current state does not regress.
8. **Thin RO:** omit VIN/customer/jobs where allowed and prove enrichment or
   reconciliation completes the record.
9. **Inspection signal:** prove the receiver can retrieve the full inspection
   after completion, or records a recoverable gap.
10. **Transient worker failure:** simulate 429, timeout, and 5xx responses;
    verify backoff, recovery, and no duplicate effects.
11. **Permanent failure:** prove bounded attempts, dead-letter visibility, and
    safe operator replay.
12. **Receiver outage:** let Tekmetric time out or receive the confirmed
    retryable response, then verify its actual retry cadence and delivery ID.
13. **Acknowledgement durability:** terminate the process immediately after a
    success response and prove the committed inbox event is still processed.
14. **Polling recovery:** suppress an event and prove reconciliation repairs
    the missed state.
15. **Tenant isolation:** use identical-looking IDs from different shops and
    prove all keys and queries remain shop-scoped.
16. **Load:** test burst size, body limits, acknowledgement p95/p99, queue age,
    and downstream Tekmetric API rate-limit behavior.

## 12. Production launch checklist

### Partner contract

- [ ] Callback registration process and production URL approved by Tekmetric
- [ ] Exact event names and payload schemas documented from partner responses
- [ ] Required events subscribed for every intended shop
- [ ] Signing header, algorithm, encoding, signed content, timestamp, delivery
      ID, and rotation process confirmed
- [ ] Acknowledgement deadline, retries, ordering, and delivery semantics
      confirmed
- [ ] REST enrichment/reconciliation endpoints and rate limits confirmed

### Receiver

- [ ] HTTPS, request size limit, and raw-body capture configured
- [ ] Signature and timestamp verification enabled and fail-closed
- [ ] Constant-time decoded-byte comparison tested
- [ ] Secrets stored and rotated through a managed secret store
- [ ] Durable inbox commit occurs before success response
- [ ] Unique delivery/event key and fallback hash tested
- [ ] Asynchronous workers, bounded retries, jitter, and dead letter operating
- [ ] Entity upserts and downstream side effects are idempotent
- [ ] Out-of-order events cannot regress current state
- [ ] Sensitive headers and payload fields are redacted from logs

### Completeness and operations

- [ ] Missing VIN/customer/jobs/inspection paths reconcile successfully
- [ ] Polling safety net runs with overlap and shop-scoped cursors
- [ ] Subscription success and recent delivery liveness are monitored separately
- [ ] Dashboards show acknowledgement latency, queue age, duplicates, retries,
      dead letters, enrichment gaps, and per-shop freshness
- [ ] Alerts and runbooks exist for stale delivery, queue backlog, signature
      failures, dead letters, and reconciliation drift
- [ ] Tekmetric-generated sandbox/test deliveries passed all launch tests
- [ ] Limited-shop production canary completed before broad rollout
- [ ] Rollback plan restores faster polling without losing inbox events

## 13. Final implementation rule

Be liberal only in what is stored, not in what is trusted. Preserve unknown
payloads for forward compatibility, but authenticate first, isolate by shop,
acknowledge only durable writes, apply effects idempotently, and reconcile from
current Tekmetric state. Treat every Tekmetric-specific value in this guide
that is marked for confirmation as unresolved until Partner Engineering
documents or demonstrates it.