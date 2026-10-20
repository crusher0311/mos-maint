# Guided check-in handoff: client/server contract

This describes the implemented local client/server contract, not deployment status.
The frontend never calls the new endpoint unless the existing authenticated
`GET /api/dashboard/protractor/dvi-handoff` advertises `sharedDrafts: {version: 1}`.
Do not advertise that capability until **all** the protections below exist.

## Scope and auth

`/api/dashboard/protractor/check-in-drafts`, private/no-store, Node runtime.
Use the actual current dashboard session cookie, active user and current shop
membership; derive the same actorKey as dvi-handoff. **All new functionality is
DVI-gated:** server draft text reads/writes, capability advertisement, device
takeover, the signed-in mobile handoff route, photo access/attachment and OCR
must require current DVI entitlement and permission server-side. There is no
text-only entitlement bypass. Non-DVI shops retain the existing local normal RO
flow, with no shared-draft calls or new handoff/OCR controls. Never accept a
browser-supplied actor/shop as authority.
No bearer token, public media URL, or cross-user draft access. All writes require
same-origin JSON with the existing bounded requestBody helper.

## Responses and operations

All successful reads/writes except discard return `{draft: SharedDraft}` using
`components/ro-shared-draft-client.ts` types. GET with no id returns the actor's
one active draft or `{draft:null}`; with `?id=UUID` returns only that exact owned
draft (404 for another actor/shop). Reads are bounded, indexed exact-key queries.
`?id=UUID&photo=UUID` serves authenticated binary, private/no-store/nosniff.

POST actions:

* `create`: `{id,revision:0,deviceId,session,photos}`. Actor/shop slot uniqueness;
  existing different active draft is 409, never silently replaced. Same-id retry
  must be exact/recoverable after a lost acknowledgement.
* `save`: `{id,revision,deviceId,session,photos}`. Atomic revision+owner CAS.
* `claim`: `{id,revision,deviceId}`. Explicit takeover, CAS against the displayed
  revision; increments revision and replaces owner. Never issues native writes.
* `photo`: `{id,revision,deviceId,requestId,mime,base64}`. Stable exact image id
  and digest, maximum 4 MiB each / 12 per draft; validate magic bytes. Binary
  saved privately in bounded separate Mongo documents, not filesystem (Render
  disk is ephemeral), not a >16 MiB combined draft. Retry must recover a previous
  exact acknowledgement, not create a new photo. CAS must protect removal/upload
  races. `saved:true` only after durable bytes commit. Metadata includes size,
  mime, name, and optional confirmed arrival evidence receipt.
* `discard`: `{id,revision,deviceId}`. Reject any unresolved native operation;
  clear a completed draft only when receipt and all arrival photos are confirmed.

Text snapshot max 256 KiB, schemas strict/bounded, query/write timeouts and majority
write acknowledgement. Seven-day text/media retention must not delete an
unresolved native operation, its frozen snapshot, or pending photo attachment.
No unrestricted TTL deletion of pending operations.

## Native send fencing: required before capability enablement

Creation bodies gain `_guidedDraft:{id,revision,deviceId}`. Every native contact,
vehicle and RO mutation must check real session/membership and atomically reserve
the exact immutable operation **inside the draft's revision/ownership fence**
before provider I/O. Persist kind, request id, canonical payload digest and
frozen payload. Stale device/revision fails closed before send. A repeated
reservation never sends again: return a durable confirmed receipt, or report
pending verification. Preserve exact-id recoverability and late success capture.
The `_guidedDraft` envelope is transport metadata, not part of the native payload
or guided-ro-operations canonical payload digest.

Reservation may advance the draft revision. The client rereads the exact draft
after native responses, confirms ownership is unchanged, then CAS-saves the
selection/result. Do not allow saves to replace/change pending payloads or remove
pending markers without a server-confirmed corresponding identity. A completed
contact/vehicle selection must match its operation receipt. Never let the browser
invent a confirmed RO receipt. Existing guided RO operation admission/confirmation
and recovery-only behavior remain authoritative. Existing legacy pending local
requests are **not migrated**; finish their existing recovery first.

Photo attachment after confirmed creation uses the original requestId and
existing arrival-photos service, not a second provider create. Server must bind
arrival uploads to the confirmed same-shop/actor draft and return/recover exact-id
receipts. Client-upload retry is permitted; never recreate customer/vehicle/RO.

## Client migration and testing

The local IndexedDB copy is preserved before server I/O. Local-only migration is
an explicit action and may not overwrite an active server draft. A different
local recovery slot must be explicitly discarded/resolved before opening the
server draft; no automatic IndexedDB replacement. Shared draft resume is also
explicit (including same-device reload), and QR URLs contain only opaque id.

The frontend advertises “server saved” only after response receipt and photo-byte
acknowledgements. Offline edits are device-only; a stale conflict locks edits until
explicit fresh resume. Handoff remains opt-in even for DVI-enabled shops: normal
local creation and retained local uncertain recovery do not require a shared
draft. Once opted into a shared draft, native creation requires its confirmed
server save and fence. The standalone mobile route requires shared mode.

Client loss-of-ack handling reads the exact draft instead of replaying save,
claim, upload or discard mutations. Text snapshots must match; recovered binary
acknowledgements verify the original saved bytes. Every shared native/OCR response,
including thrown/failed responses, refreshes the server fence before subsequent
saves. Immediate server RO confirmations and arrival receipts are merged and
retained locally without dropping or replacing immutable payload/result state.
An existing saved photo can be selected to recover its cached odometer result
using the same photo/interpretation IDs, without a duplicate upload.

Backend safety review/tests still required: isolatedStaffDatabase helper, stripped
environment plus deny-network-egress hook; cross-actor/shop access, CSRF, schema
and byte bounds, CAS/save/claim/native races, lost upload/native acknowledgements,
late provider success, unresolved retention, and exact-id evidence attachment.
Never boot normal Next app or use environment Mongo/provider credentials.

## Odometer photo interpretation

Advertise `odometerScan:{version:1}` only with an implemented authenticated
`POST /api/dashboard/protractor/odometer-ocr`. Also return **authoritative**
`distanceUnit:"miles"|"kilometers"` in capability from shop preferences. Existing
Protractor adapters use `shop.preferences.distanceUnit` (kilometers or miles
default); native create mileage is a raw numeric odometer in the shop's unit.
The frontend never assumes the unit if the server omits it.

The new request is bounded same-origin JSON:
`{_guidedDraft:{id,revision,deviceId},photoRequestId,interpretationRequestId}`.
Load the exact already-server-saved private image, validate actual image magic
bytes/type and <=4 MiB before paid I/O; check current session, active membership,
same actor/shop, DVI photo access and draft fence. Enforce the existing AI budget
and use trackOpenAiCall, lazy OpenAI construction and bounded upstream timeout.
No credential changes. Deduplicate interpretation ids and cache exact receipts
so network retries do not make duplicate paid calls. Keep source image even if
interpretation fails. No completed inspection finding is generated.

Expected response `{result:{reading:number|null,unit:"miles"|"kilometers"|"unknown",
confidence:"high"|"medium"|"low",kind:"odometer"|"trip"|"unreadable"}}`.
Strict server schema and strict JSON parsing; do not extract digit substrings
from arbitrary model text or leak raw model/provider responses. Total odometer
only; ignore Trip A/B, range-to-empty, service intervals. Missing/occluded digits
must yield unreadable with reading:null, not guesses. Trip-only also returns null.
Odometer numeric reading is a nonnegative whole number <=9,999,999.

Client preserves previous mileage until explicit confirmation. Unknown source
unit requires selection. Unit mismatch shows original + converted value and
rounding using exactly 1 mile = 1.609344 km before applying. Suggestion, selected
unit, source photo id and confirmed reading/unit/time live in the original guided
draft snapshot. New-vehicle odometer and final RO mileage receive the confirmed
shop-unit value only after the user's explicit action.

Required backend mocked-OpenAI coverage: clear odometer, trip-only, unreadable,
km and unknown units, malformed output/extra keys/range violations, unauthorized
and cross-shop/photo access, budget refusal, bad magic bytes/oversized image,
provider failure/timeout, duplicate interpretation receipt. No paid/live calls.
