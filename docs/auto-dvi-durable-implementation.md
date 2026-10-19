# Durable legacy Protractor push implementation

## Release boundary

The durable path is **not active**. `DURABLE_DVI_ENROLLMENTS` is empty. The
operator-approved storage provisioning described in the
[pilot evidence record](auto-dvi-protractor-pilot-evidence.md) has run, followed by
an approved synthetic Car Experts pilot. The pilot did not establish the required
safety contract; no capability activation or enrollment has occurred.
Non-enrolled shops
retain the existing legacy behavior and warnings; Tekmetric is unchanged.

Enrollment is permanent routing ownership, separate from the admissions switch.
Rollback sets `admissions: false`; it must never remove enrollment and route a
durable target back to the legacy writer. Existing status/read-only reconciliation
and local outbox repair remain available. Persist enrollment in the reviewed
release configuration across rollback builds.

## Modules and storage

- `lib/auto-dvi/durable/model.ts`: strict canonical request, immutable plan
  identity, versioned strict full-projection comparison and public pending status.
- `compose.ts`: new server-only package/line IDs, repeated recommendation
  occurrences preserved, prices/notes/result labels frozen before admission.
- `repository.ts`: transactional request reservation, permanent target ownership,
  lease-token fencing, stage admission tokens, authoritative receipt and outbox.
- `service.ts`: shared initial orchestration and **read-only** reconciliation.
  Repeated pushes only return status; they never resume a prepared second stage.
- `lib/data/repositories/auto-dvi-durable.ts`: one authoritative Mongo transaction
  adapter, majority+journal commits, primary majority reads, deterministic `_id`
  keys for uniqueness. No TTL. No lazy collection/index installation.

Before enrollment, an operator must provision `auto_dvi_durable_v1` and
`auto_dvi_applications` on the same transaction-capable database. The mandatory
Mongo `_id` constraint provides request, target, operation, receipt and outbox
uniqueness using separate hashed key namespaces; no secondary index is needed
for admission. The readiness check rejects missing storage, TTL indexes, or a
non-transactional topology. Activity uses an operation-derived `_id` and commits
with outbox delivery in the same transaction. Optional analytics is not a
completion prerequisite.

No runtime code reconstructs historical ownership from a title. Historical MOS
packages block initial composition pending operator adoption. An intentional
changed inspection after completion is blocked pending a separately authorized
ownership revision. The operator recovery/adoption flow is separate work; these
staff endpoints never accept grants or `recover: true`.

## Provider capability boundary

`ProtractorDurableProvider` requires a reviewed `VerifiedProtractorCapabilities`
implementation before admission. This is deliberately not inferred from a GET
200. A separately approved synthetic pilot must establish complete nested
collections, identity/VIN, open status, configured labels, revisions, normalized
projection and a real exclusive editing window (or equivalent conditional-write
contract). Until then it fails closed. Strict v1 comparison does not normalize
decimal formats or interpret omitted fields/deletions as success.

The exclusive window must survive a local timeout until the actual upstream
request terminates. A local lease or pre-write GET is not sufficient. The adapter
sends one REST attempt with `maxRetries: 0`; there is no SOAP fallback.

## HTTP contract

Both existing POST push handlers retain their own authentication/feature guards
and call the shared service before legacy pricing or composition. Enabled
Protractor requests require `clientRequestId`, verified exact `workOrderGuid`,
VIN, items and optional recommendations. They reject malformed/unknown fields.
The extension's external `shopId` is resolved by its existing guard and excluded
from request content. Both channels share the canonical MOS shop namespace.

Same key/content returns persisted status/receipt. Changed keyed content returns
409 without target lookup or pricing. A new key cannot bypass an unresolved
target. An identical completed request returns the existing verified receipt,
including after admissions are disabled. Other actors cannot retrieve payloads
by guessing a key; their blocking errors contain no request content.

Authenticated `GET /api/auto-dvi/push/status?operationId=...` returns persisted
status; POST to the same URL performs read-only reconciliation. The extension
equivalent additionally accepts external `shopId` in the query, resolved through
the normal guard. Both recheck access and connection identity. `recoveryAllowed`
is always false. Pending responses include the legacy `outcome: uncertain`
and “Do not resend” warning so older clients do not treat HTTP 202 as success.

Client release is part of activation approval: callers must pin a request key
before sending and provide a verified exact work-order GUID. Old clients missing
either field are rejected on enrolled shops, never silently sent to legacy code.
No UI retry/recovery button is introduced.

## Offline verification

Run `npm run test:auto-dvi-durable`. Requires `mongod` on PATH. The suite starts
an ephemeral replica set bound to 127.0.0.1:27791 with a fresh temporary data
directory, uses literal local connection strings, and denies non-loopback
network access before loading any code. It never imports the application Mongo
connection. It removes the temporary server/data on completion.

Tests use actual transactions and unique `_id` constraints, independent OS
processes, process termination after simulated upstream commits, fresh clients
after restart, lost commit responses, stale fencing tokens, edited/missing
priced extras, same-key conflicts, idempotent receipts/activity and the actual
dashboard/extension route handlers with mocked authentication/provider transport.
Legacy outcome tests remain separate regression coverage, not proof of recovery.
