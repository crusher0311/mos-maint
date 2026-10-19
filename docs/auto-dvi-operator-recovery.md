# Durable DVI operator recovery (disabled by default)

This implementation is not authorization to provision storage, enroll shops,
activate writes, or release visit DVI. Provider capability verification remains a
separate gate. The application Mongo connection is shared with production; run
only the isolated, egress-denied test suite.

## Access and API

Both channels retain their authentication and feature checks. Status and recovery
also reread current user shop assignments and entitlements (no platform-admin
bypass). Shop colleagues may read redacted status and reconcile; request-key
replay remains restricted to the initiating actor. Responses have `private,
no-store` caching. No plan, request, notes, VIN, or pricing payload is returned.

- `GET /api/auto-dvi/push/status?operationId=<uuid>` returns status/receipt.
- With `workOrderGuid=<uuid>` instead, it discovers the current/last operation
  through the authenticated connection's target gate. No tracked operation means
  manual verification, **not permission to resend**.
- `POST /api/auto-dvi/push/status?operationId=<uuid>` reconciles exact saved IDs;
  it never invokes a provider mutation. Already-desired work repairs its receipt
  and activity locally.
- `POST /api/auto-dvi/push/recover` with `action: "authorize"`, `operationId`,
  and `stage: "packages" | "findings"` reconciles and returns a sanitized review
  and two-minute grant ID (or the completed receipt).
- A separate POST with `action: "consume"` and the same identity/stage plus
  `grantId` consumes that grant and admits exactly one saved stage transactionally.
- Extension equivalents use `/api/extension/auto-dvi/push/...` and the extension
  guard's resolved shop ID. Dashboard recovery requires a same-origin request.

The operator page is `/dashboard/auto-dvi-recovery`. Explicit, reviewed, expiring
operator assignments in `RECOVERY_OPERATORS` are required in addition to shop
membership. A browser role, `recover: true`, or possessing a grant is insufficient.
The list is empty. Enrollment `recovery` must separately be true and a verified
provider concurrency adapter installed. None has been enabled by this change.

## Safety and restart behavior

Grants bind operator, shop, operation, stage, frozen plan digest, operation/stage
revision, provider revision/hash, action and expiry. Consumption and stage
admission share one transaction. Issuing another grant or reconciling invalidates
the previous revision-bound grant. A lost admission commit response never permits
a speculative send. Lost grant responses can be replaced by fresh authorization;
lost consumption responses require status/reconciliation, never resubmission.

Provider edits, partial results, missing concurrency protection, closed orders,
changed connections and unresolved earlier transport attempts block recovery.
The first verified package revision is retained separately from later observations
so a new reconciliation cannot erase change-and-change-back evidence.

An affirmative transport acknowledgment records termination. Otherwise an earlier
attempt requires independent, server-verified quiescence evidence. The recovery
service supports an injected proof capability for offline/approved adapters;
the production runtime intentionally installs none. Timeouts and expired leases
are not proof, and no client-supplied proof or force override is accepted.

Browser draft/request persistence is being implemented separately in the existing
client task. It should use target discovery above after reload or a lost response,
retain request keys before sending, and never treat a missing operation as proof
that a historical push failed. This change does not edit those shared push panels.

## Verification

`npm run test:auto-dvi-durable` uses an isolated Mongo replica set and denies
non-loopback network egress. Tests cover real dashboard/extension route guards,
stage-only saved-ID recovery, two-device races, cross-channel duplicate grants,
revocation, wrong shop/operator/stage, expiry, changed revisions/digests,
provider edits, unresolved attempts, lost admission/provider/browser responses,
receipt repair and the existing durable push regressions.
