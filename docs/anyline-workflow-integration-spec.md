# Anyline in Detect Dog Shop Workflow / Auto DVI

**Decision specification — 21 October 2026. No implementation or activation authorized.**

## 1. Executive decision

Recommend **web-first reviewed identification, followed by an optional native tread
companion**. Keep the full staff DVI and its manual procedures as the system of
record. Browser identification can proceed independently after approval;
browser-only Anyline tread measurement is not a supported delivery promise.

The owner must decide whether distributing and supporting a native iOS/Android
application is acceptable. If not, scope Anyline to identification and retain
manual tread measurement. Do not substitute a tire-only app for Auto DVI.

Tread results initially remain **supplemental, reviewed regional/global
measurements**. They cannot complete required inner/center/outer fields without
separate vendor evidence and inspection-policy approval. Even three returned
regions do not establish three groove measurements.

This document proposes future behavior, not existing scanner functionality.
No SDK installation, licenses, vendor measurement calls, real images, store
access, native app, artifact changes, customer publication, upstream writes,
rollout or deployment are part of this work.

## 2. Versioned evidence and capability matrix

### Baseline and sources

Public documentation was read on 21 October 2026. The supplied `latest` pages
identified Web **56.1.3** and Tire Tread **16.0.0**. Numeric-version getting-started
pages and the numeric-version tread results page were also retrieved.

| ID | Source and baseline |
|---|---|
| W1 | [Web getting started, 56.1.3](https://documentation.anyline.com/web-sdk-component/56.1.3/getting_started.html) |
| W2 | [Automotive examples](https://documentation.anyline.com/web-sdk-component/latest/tire_automotive.html), observed version 56.1.3 |
| T1 | [Tread overview](https://documentation.anyline.com/tiretreadsdk-component/latest/index.html), observed version 16.0.0 |
| T2 | [Tread getting started, 16.0.0](https://documentation.anyline.com/tiretreadsdk-component/16.0.0/getting-started.html) |
| T3 | [Tread results, 16.0.0](https://documentation.anyline.com/tiretreadsdk-component/16.0.0/results.html) |
| A1 | [TTR resource API](https://documentation.anyline.com/insights-api/ttr-api.html), unversioned documentation observed on review date |

Proposed dependency pins: `@anyline/anyline-js` **56.1.3**;
Android `io.anyline.tiretread.sdk:shared:16.0.0`; iOS
`anyline-tiretread-spm-module` **16.0.0**, exact SPM version.
Implementation must verify package availability, lock resolved dependencies and
matching assets, retain the approved schemas/documentation snapshot, and record
runtime SDK versions. Do not use floating `latest`, caret ranges, or an unpinned
CDN. These are specification baselines, not tested installations. Changing them
requires a contract/device regression check.

**D** = documented; **C** = vendor/owner confirmation required; **U** =
unavailable or unverified for the proposed product (not proof it can never exist).

| Capability | Status / documented behavior | Delivery boundary |
|---|---|---|
| Browser VIN | D, W2: `vin`, `vin_with_user_guidance`, optional check-digit validation | Review before intake application; configure market-appropriate validation, not universal check-digit rejection |
| Browser regional plates | D, W2: US, Canada, EU and configured country modes | C: exact pilot regions/formats and accuracy; plate recognition does not imply plate-to-VIN lookup coverage |
| Browser TIN/DOT | D, W2: `tin` universal; `tin_dot` requires DOT prefix | Preserve raw text and mode; no invented date/plant decoding or recall service |
| Browser size | D, W2: `tire_size`, formatted `prettifiedString.text` | Review actual tire size; do not invent parsed subfields absent in verified schema |
| Browser tire make | D, W2: `tireMakeConfig`, no preset | C: supported manufacturer list; no promise of model/pattern recognition |
| Commercial tire ID | D, W2: `tire_id` | Separate optional field, not interchangeable with DOT or globally unique tire identity |
| Browser tread | U: reviewed Web docs do not document tread capture | Exclude browser-only/PWA tread promise |
| Native tread | D, T1–T3: native mobile SDK, frame upload and cloud processing | Stable network required; no offline-result promise |
| Tread outputs | D, T3: global, ordered left-to-right regions, minimum, UUID/status, optional movement direction | Not individual grooves; minimum may fall back to global; unknown orientation stays unknown |
| Numeric retrieval | D, T3: native `getResult(measurementUUID, timeoutSeconds)` | C: authenticated server numeric retrieval, callbacks/webhooks, cross-device recovery and quotas; not assumed |
| Supporting assets | D, A1: resource index can provide `svg`, `tire_image`, `gif`; keys may be absent | C: account authorization/access and retention; no blind direct endpoint probing or automatic attachment |
| Automatic vehicle/wheel association | U | Our server binds explicit context; OCR/UUID alone is not authority |
| Inflation pressure, damage diagnosis, safety rating | U for these scan contracts | Manual pressure, evaluation, recommendation and rating remain required as configured |

### Devices, camera and licensing

W1 lists devices released after 2017, iOS 10+/Android 7+, latest Safari on iOS
and Chrome on Android, 720p minimum/1080p recommended camera, and HTTPS.
These broad minimums are not a verified device matrix; current browser/OS
compatibility must be confirmed. Test camera permission and secure context,
rear-camera selection, focus, orientation changes and camera release on exit.
Embedded WebViews and desktop cameras are not implicitly supported.

W1 requires domain-restricted licenses; production licenses do not support IP
addresses or localhost. Inventory approved production, staging and development
domains with Anyline; confirm subdomain/preview-domain and non-production terms.
Do not infer a wildcard grant. Browser license material is client-visible and
must not be treated as server authentication.

T1 lists Android 6/API 23+, iOS 15+, stable internet, flash, >=1080p camera and
adequate autofocus. T2's Android support check examines camera hardware; iOS
checks minimum OS only. A positive check is not proof of measurement accuracy.
The overview requires flash while the sample manifest marks flash optional:
obtain vendor clarification and use flash-capable pilot devices meanwhile.
T2 documents camera/internet permissions, Android vibration support and iOS
camera usage description. Confirm lighting, wet/dirty/worn tires, tire types,
camera distance and scanning procedure with the vendor.

Native license initialization is required. Use platform secure storage or
approved dynamic delivery; never hand a backend vendor credential to the browser.
Confirm bundle-ID/application-ID binding, signing variants, staging/production
licenses, device/seat limits, renewal, revocation and redistribution terms rather
than assuming Web licensing covers native capture. T1/T2 also impose native build
tool requirements; budget maintained Android and macOS/iOS build/signing pipelines.

### Lifecycle facts

T3 guarantees availability only **24 hours after measurement-session creation**,
not after upload or first read. This is not a deletion guarantee.
`WaitingForImages` and `Processing` are pending; numeric results are available
only for `ResultReady`, `ResultAndReportReady`, or `Completed`.
`Aborted`, `Failed`, and `Unknown` must never be displayed as successful readings.
Persist an authorized, validated result into our own bounded store promptly;
vendor URLs are not durable evidence storage.

## 3. Technician journey and existing integration seams

### Reviewed identification during shared guided intake

1. In the vehicle stage of `components/NewWorkOrderModal.tsx`, offer Scan VIN or
   Scan plate alongside manual entry. Use the same flow from dashboard and
   workflow; do not create an independent wizard in either demo artifact.
2. Check current actor/shop, shared draft ownership and revision before capture.
   Ask for camera access only on technician action. Let staff select plate region.
3. Show raw recognized value, region and available quality metadata; compare with
   the selected vehicle. Offer **Confirm and apply**, edit with reason, retry,
   or cancel. A scan is a suggestion, never a customer/vehicle selection or RO
   create command. Conflicting VIN/plate requires explicit reconciliation.
4. Save only confirmed fields through shared-draft revision/ownership controls in
   `components/use-ro-recovery.ts`. A closed wizard, shop switch, ownership transfer
   or frozen creation request rejects late results. Manual entry remains possible.
5. Use `components/ROOdometerCapture.tsx` as the review/unit UX precedent, not an
   authorization shortcut. Do not change its mileage behavior. A plate OCR result
   cannot expand the existing downstream plate lookup's supported regions.
6. Pre-visit scans belong to the shop/actor/shared-draft identity, not a fabricated
   visit. After confirmed intake/handoff, explicitly link accepted identification
   provenance to the canonical visit. Retrying a scan must never replay RO creation.

### Wheel-specific capture inside staff inspection

1. Open the existing DVI through `DispatchPilot` / `DviEntry`; load current
   inspection access and initialize its canonical binding if required.
2. Select an active sheet instance and tire item. Display vehicle/RO for human
   checking and a prominent wheel label: LF, RF, LR or RR **relative to vehicle
   forward travel**, not camera viewpoint. Require wheel confirmation before
   each scan. Custom/multi-axle/dual/spare positions need explicit approved
   mappings; never default them to a passenger-car wheel.
3. Offer sidewall capture for size, make and TIN/DOT. Review each field; accept
   only fields the current sheet supports. Current tire fields include size but
   not dedicated make/DOT: store those as supplemental scan data until an
   approved versioned sheet adds them. Do not silently change templates.
4. Offer native tread capture only on a licensed, approved device. Save current
   edits first or explicitly discard them; do not launch over an uncertain save.
   Show identical vehicle/wheel context in the companion and require confirmation.
5. Capture with vendor guidance. Show upload progress, then **Processing — no
   inspection reading saved**. Staff may return to other items without losing
   the scan ID. The browser reads our saved status, not the vendor SDK directly.
6. On return, show original units, global/minimum/regions, orientation uncertainty,
   quality/availability and provenance. Present retry, reject, manual measurement,
   and **Accept supplemental scan into this inspection**.
7. Acceptance is a separate revision-checked write. Show the exact item and fields
   being changed. Required manual tread positions, pressure, evaluation and photos
   remain incomplete unless independently supplied. No automatic green rating,
   ready/review transition, release selection or provider write.
8. A later manual correction retains the original result and creates an attributed
   revision. A rescan creates a new attempt and explicit supersession, not an
   overwrite of prior evidence. A tire rotation/replacement requires new context.

### Failure and recovery states

| Situation | Technician behavior and durable outcome |
|---|---|
| Camera denied/unavailable | Explain settings; offer manual entry immediately; stop/release camera; no blank overwrite |
| Unsupported hardware/browser | Explain supported-device requirement; continue full manual DVI; no fake success |
| Blurry/bad/partial scan | Show guidance and retry; keep prior confirmed fields; unavailable values remain missing, not zero |
| Expired/wrong-domain/app license | Disable new scan, notify operator with redacted error; manual work and existing results remain readable |
| Upload/network timeout | Mark outcome uncertain, preserve attempt/UUID; recover same attempt first, never auto-rescan/bill again |
| Delayed result | Show pending status and last check; bounded retry/resume, no loading screen that blocks the entire DVI |
| App killed or handoff interrupted | Resume authorized attempt by server ID and durable UUID on original device; if not recoverable, mark unresolved explicitly |
| Session expires/membership removed | Require fresh sign-in/revalidation; no automatic apply or cross-shop transfer |
| Visit closes, sheet deactivates or edits become stale | Keep candidate available under read permission; refuse acceptance; show comparison/reload, never silently rebase |
| Result not recovered within availability window | Mark vendor availability expired/unconfirmed, not measured; retained local result remains distinct; offer explicit new scan/manual reading |
| Return to wrong wheel/vehicle | Reject context mismatch; do not relabel old result; start a separately confirmed attempt |

## 4. Architecture recommendation and alternative

| Concern | Recommended: Web identification + native tread companion | Alternative: broader native wrapper |
|---|---|---|
| Workflow | Existing web intake/editor remains primary; native opens only for tread | Workflow hosted inside native shell with native scan bridge |
| Authentication | Browser-assisted sign-in and short-lived, scan-scoped native session; independent device revalidation | Native session plus authenticated web surface; same server membership rules; bridge cannot grant authority |
| Handoff | Verified app/universal link or QR carrying opaque one-time code | Local bridge passes opaque server scan ID; still needs scoped authorization and replay protection |
| Distribution | Optional approved shop devices; app installation, signing, updates, support and lost-device revocation | Installation/update support for broader workflow population; WebView/navigation/cookie/bridge regressions |
| Licensing | Web domains plus native app/measurement terms | Native tread terms; confirm Web SDK-in-WebView or additional native identification licenses |
| Privacy | Browser identification and native cloud tread are separately disclosed | Same cloud tread exposure; native wrapper does not remove it |
| Operations | Two surfaces, cross-device recovery, pending-result queue, smaller mobile feature set | Fewer visible app switches, but larger mobile release/testing and security surface |
| Cost drivers | Vendor licenses/usage, supported phones, signing/distribution, storage, network, monitoring and support | Same plus wrapper/bridge maintenance, full-workflow device QA and coordinated releases |

Choose the wrapper only if the owner wants a maintained mobile workflow beyond
tread and approves its wider lifecycle. A WebView alone cannot supply native
tread; a maintained native SDK bridge is required. Wrapper SDK support and
licensing are confirmation gates, not inferred from `wrapperInfo` metadata.
No vendor prices or delivery dates are assumed.

### Proposed trust and transport contract (not implemented routes)

* Browser creates a scan intent using verified dashboard session and same-origin
  protection. Server derives shop/actor from authority, never trusts body scope.
* Reuse current membership, enterprise policy, `shop_workflow` and `auto_dvi`
  entitlements, enabled-shop configuration, canEdit, canonical binding and
  open-visit checks from `lib/auto-dvi/staff/access.ts` and `service.ts`.
  Recheck at intent, handoff claim, ingestion, read and acceptance.
* Existing `staffAccess` requires a dashboard cookie. Native bearer handling is
  **new security work**, not currently supported by the inspection/media routes.
  Authenticate native through system-browser sign-in, PKCE-style device binding
  and a one-time server exchange; reuse `staffMemberAccess` policy only after
  verified identity. Do not pass the dashboard cookie through a URL.
* Proposed handoff TTL: 2 minutes, one atomic claim; server stores a hash of the
  random code. Bind actor, shop, scan intent, visit, sheet/item, wheel, device
  challenge and allowed operation. No VIN, plate, credentials or result in QR/
  URLs/logs. Use verified links, fixed allowlisted return paths, no open redirects.
* Device-scoped scan session: proposed 15-minute access lifetime with fresh
  authorization on renewal. Expiring handoff does not delete a pending attempt.
  Resume requires sign-in, approved app/device and original context; revocation
  denies further ingestion/acceptance. Shared shop devices require per-user
  sign-in; logout clears tokens and quarantines encrypted pending work.
* Admit our attempt before invoking vendor capture. Persist measurement UUID as
  soon as available, before subsequent navigation. An SDK crash before UUID
  persistence is an unresolved attempt, not evidence that nothing was submitted.
  Vendor session creation/recovery semantics are a feasibility gate.
* Default retrieval uses native `getResult` then authenticated upload to our
  server. Client-supplied results are schema-validated technician submissions,
  **not cryptographically vendor-attested**. Record that trust level. If signed
  results or server verification is required, block tread delivery until confirmed.
* Do not plan a server numeric poller/webhook without a verified vendor contract.
  A1's supporting-resource endpoint does not prove such a numeric API exists.
  Native OS background execution is not guaranteed: the device may need to reopen
  the companion before 24 hours. Show that limitation before pilot approval.
* Proposed retry budget: one retrieval in flight per attempt, SDK timeout at most
  60 seconds, three foreground calls per resume with jittered 5/15-second pauses;
  then explicit Pending. Maximum 20 retrieval calls per attempt, no retries past
  session creation + 23 hours (one-hour safety margin). Treat missing creation
  time conservatively using intent time until vendor semantics are verified.
  These are proposed app limits, subject to vendor quotas—not vendor guarantees.
* Our API calls use a bounded deadline (proposed 15 seconds). Timeouts preserve
  request IDs and digests; repeat exact request to retrieve its receipt. Vendor
  SDK image-upload internal retries (T2: default 20 seconds per image attempt,
  one retry) must be included in UX/budget testing, not mistaken for a total
  capture deadline. Cancelling UI is not proof cloud processing was cancelled.
* Deduplicate by vendor account/environment + measurement UUID, and by scoped
  request ID + digest. Same ID with different payload/scope is conflict. Never
  attach one measurement to two wheels or shops. Store immutable result versions;
  do not regress a ready attempt from a late pending event.
* Acceptance atomically records the reference, reviewed values and receipt in the
  inspection revision boundary. Candidate result ingestion does not modify the
  finding. Cross-store ingestion/acceptance is recoverable via receipts, not
  claimed as one distributed transaction.

## 5. Proposed data and evidence contract

This is a conceptual v1 contract, not a migration or an existing API payload.
Use a dedicated bounded scan store for candidates; do not embed full vendor
payloads/images into the shop-wide inspection aggregate or audit snapshots.

| Group | Required meaning / proposed fields |
|---|---|
| Identity | `scanId`, `attemptId`, `schemaVersion`, `kind` (VIN, plate, sidewall, tread), `supersedesAttemptId?` |
| Intake context | Discriminated `scope: intake`, server `shopId`, `actorId`, `sharedDraftId`, expected draft revision/owner device; no invented inspection IDs |
| Inspection context | `scope: inspection`, server shop, canonical workflow visit, inspection record identity, provider/source binding digest, sheet instance key + version, item ID, wheel ID, wheel-context revision, expected inspection revision |
| Handoff | intent/claim IDs, device/session binding, issued/expires/claimed timestamps; hashed code only; no token in evidence |
| Vendor provenance | vendor, account/environment reference, exact SDK/platform/app/config versions, measurement UUID for tread, optional vendor status/context, source trust (`native-client-submitted` unless verified otherwise) |
| Time | device-reported capture time (untrusted), vendor session time when available, server received time, last retrieval time, deadline |
| State | admitted, capturing, upload-uncertain, pending, result-ready, failed, aborted, availability-expired, rejected, accepted, superseded; vendor status preserved independently |
| Identification | immutable raw text, reviewed text, detected/confirmed plate region, scan preset, reported confidence if available (otherwise null), correction reason |
| Sidewall | raw/reviewed TIN/DOT, mode/prefix, size text, make text, optional commercial ID; each field attributed; no assumed serial uniqueness |
| Tread source | original serialized bounded numeric result + digest; global, minimum with fallback meaning, regions with original index/order/availability; vendor-native values and unit/accessor names |
| Orientation | vendor movement direction/null, technician-confirmed wheel, capture viewpoint/physical side notes, mapping state unknown or verified, mapping policy/version and actor; no default |
| Review | immutable revisions with reviewer, server time, prior/new values, correction reason, accepted field selection, source result digest and expected inspection/evidence revisions |
| Media | optional internal scoped media references, media kind/source/digest; separate arrival references, inspection photos and customer-release selections |

Validation rejects unknown scope/units, nonfinite/negative measurements, malformed
IDs, excess payload size, wrong sheet schema and changed binding. Proposed
candidate limits for design review: 64 KiB normalized result per attempt,
10 attempts per wheel per visit, 2 concurrent captures per actor, 10 per shop.
Fail visibly at capacity; retention and operator archival must be approved before
activation. No silent receipt deletion or reuse of IDs.

### Units, orientation and corrections

Preserve every vendor-returned representation and its unit. If the SDK exposes
multiple unit accessors rather than a single original unit, record those names
and the accessor used, not an invented capture-unit label. Verify exact numeric
serialization and unavailable-region markers against 16.0.0 before coding.

Normalize only after unit validation: `inches = mm / 25.4`;
`32nds = mm * 32 / 25.4`; a value of 8 in `32nds` means 8/32 inch, not 8 inches.
Keep full source precision; proposed display precision is two decimal places
without rounding intermediate conversions. Preserve source and conversion version
alongside any accepted destination value. Current tire sheet units are mm/32nds;
do not silently add decimal inches. No automatic threshold rating in this scope.

Global and minimum are scalar summaries, not substitutes for three positions.
Regions retain vendor left-to-right ordering regardless of sweep direction.
`RightToLeft` does not authorize reversing indices into inner/outer; viewpoint,
mounted wheel side, region semantics and approved procedure all matter.
Null/unknown direction, missing regions or global-only results stay supplemental.
Even known orientation is insufficient until vendor confirms regional equivalence
to the inspection procedure and the owner approves that procedure. Manual
inner/center/outer measurements remain independently sourced and attributed.

Corrections create revisions and preserve the original; they never edit a vendor
result in place. Do not send comments/tire identifiers or user-corrected values
back to Anyline automatically. T3 documents feedback methods (all returned regions
required for regional feedback), but feedback is separate vendor data disclosure
and outside initial scope.

### Evidence, storage and release

Existing `staff/model.ts` finding schema is strict. Adding scan references requires
an explicit future schema/command design; hiding arbitrary metadata in numeric
values or notes is not acceptable. Any accepted evidence change advances evidence
revision so old ready/review markers are no longer current. Preserve versioned
sheet snapshots, explicit selection and current same-item equivalence behavior;
do not let a new scan reference silently propagate across different wheel contexts.

Follow `docs/workflow-staff-inspection-rollout.md` and
`docs/guided-ro-dvi-handoff.md`. Arrival photos remain internal context and require
the existing saved-evaluation association path; they do not satisfy inspection
photo requirements. Accepting scan data does not select anything for customer
release. Existing advisor review and publication permissions remain unchanged.

Approved inspection images use existing
`workflow_staff_inspection_media` GridFS boundaries: JPEG/PNG/WebP with MIME/magic
validation, 4 MiB/photo, six/item, 60/visit, scoped access, reservation/receipt and
cleanup fencing. Do not rely on the Replit-only object-storage sidecar or add SVG/
GIF to the photo endpoint. Vendor visualizations stay optional and unsupported
as inspection photos until separately designed. A vendor frame is not automatically
proof the required procedure/photo was performed.

Native media transport needs its own approved authentication adapter; do not relax
the existing same-origin browser upload route. Never hotlink vendor resources in
customer views. Any future server download needs allowlisted hosts, redirect and
size/time limits, content validation and SSRF protection. No general URL fetcher.

## 6. Privacy, commercial and owner decision checklist

No vendor quote, DPA, licensed device trial or account permissions were verified.
Assign an accountable owner and record written answers before the dependent phase.

| Decision / question | Responsible party | Blocks |
|---|---|---|
| Is native distribution acceptable? Companion or wrapper, iOS/Android/both, shop-owned vs BYOD? | Product/operations owner | Tread implementation |
| App Store/Play vs managed private distribution, signing ownership, updates, lost-device revocation, support staffing? | Mobile/operations owner | Native pilot |
| Exact Web domains, app IDs, licensed features, test environments, expiry/renewal behavior? | Vendor + procurement | SDK use |
| Price basis, minimum commitment, per-scan/device/seat charges, failed/retry billing, quotas, overages, support SLA? | Vendor + procurement | Budget approval; no estimate invented here |
| Exact devices/OS/browser versions; tread accuracy, repeatability, error bounds, ground-truth method, limitations and quality thresholds? | Vendor + inspection owner | Device selection and acceptance criteria |
| Region count/availability, unit serialization, orientation semantics and equivalence to required positions? | Vendor + inspection owner | Any mapping into required tread fields |
| Numeric server retrieval, result signing, webhook authentication, UUID recovery across restarts/devices, rate limits and session-creation timing? | Vendor + engineering | Recovery architecture and trustworthy result claims |
| Resource API authentication/entitlements, link expiry, export rights, permitted caching and retrieval limits? | Vendor + engineering/legal | Supporting-media ingestion |
| What images, camera frames, VIN/plate, device identifiers and telemetry leave Web/native SDKs; local processing vs network transfer; endpoints and subprocessors? | Vendor + privacy/security | Any licensed trial with real data |
| Training/secondary use, opt-out, consent notices, staff/customer rights, DPA, residency/transfer regions and security controls? | Vendor + legal/privacy | Production approval |
| Actual retention/deletion/backups for frames/results/telemetry; deletion API/process/SLA and legal holds? 24-hour availability is not retention. | Vendor + legal/privacy | Retention policy |
| Our retention for candidates, accepted results, audit/receipts and encrypted device queue; deletion ownership and capacity planning? | Legal + operations | Store activation |
| Supplemental-only policy, manual fallback procedure, allowed sheet fields, training and named pilot scope? | Inspection/product owner | Acceptance design and pilot |

Proposed minimization: send only an opaque attempt reference as vendor
`additionalContext`; omit customer names, contact details, VIN/plate and internal
shop/visit identifiers unless independently justified. Avoid stable device
`customTag` identifiers unless approved. No raw images, OCR values, credentials
or vendor UUIDs in general logs. Use internal opaque IDs for operational events.
Encrypt pending native data, limit its local lifetime, and do not promise remote
deletion of offline devices. Retain committed evidence under existing policy
until an approved archival/deletion policy replaces it.

## 7. Phased execution scope and conditional estimation

Each phase needs separate implementation authorization. This specification
authorizes none of them. Estimate ranges/dates only after licensing, device
coverage and distribution are settled; no numeric cost or time estimate is
defensible yet.

| Phase | Proposed work | Exit gate / estimation dependency |
|---|---|---|
| 0 — decision and vendor validation | Obtain written checklist answers, choose platforms/distribution, lock schemas and license terms | Owner go/no-go; estimate based on actual supported devices, account access and privacy terms |
| 1 — offline contracts | Isolated scan-store/auth/handoff state models, mocks and adversarial fixtures; no SDK/live stores | All identity, revision and recovery tests pass; estimate depends on native auth approach and result trust requirement |
| 2 — web identification | Shared intake VIN/plate review plus wheel-specific sidewall review, bounded persistence and manual fallback | Licensed test environment approval and approved device matrix; no tread claim; estimate depends on fields/regions and licenses |
| 3 — native tread companion | Native authentication/distribution, SDK capture, durable UUID recovery, bounded retrieval and supplemental review in full DVI | Supported devices, cloud/privacy terms, recovery limitations accepted; estimate separately for each OS and distribution route |
| 4 — separately approved pilot | Named shop, consented controlled captures, manual gauge comparison, failure drills, support/rollback plan | Owner-defined accuracy/repeatability thresholds met; no automatic fleet rollout |
| Optional later mapping | Verified regional procedure and orientation mapping into versioned sheet fields | Written equivalence evidence and policy approval; not needed for supplemental-only delivery |

The wrapper alternative replaces—not silently expands—phase 3 and requires a
fresh estimate for full workflow navigation, WebView/bridge security, releases
and regression coverage. Do not include customer publishing, provider writes,
arrival-policy changes or SDK feedback in either baseline.

Operational acceptance needs counters for attempts, denied/unsupported devices,
license failures, uncertain uploads, pending age, retrieval exhaustion, duplicates,
conflicts, accepted/rejected scans and manual fallback. No raw vehicle data in
metrics. Alert the owning operator on license failures or backlog approaching the
availability window. Set retry/usage caps from the contract. A kill switch stops
new admissions without deleting pending receipts or accepted evidence; authorized
recovery policy must be explicit, not an unbounded background drain.

## 8. Acceptance test matrix for future implementation

All automated tests use fixtures, disposable stores and denied external network
egress. No shared development/production Mongo, real vehicle uploads or paid calls.
Device tests require a separately approved licensed environment.

| Test | Required result |
|---|---|
| VIN/plate review, edit, cancel, invalid/unsupported region | No field change until confirmation; raw/corrected provenance retained; manual path works |
| Intake draft transfer, frozen request, late result after shop switch | Old context cannot populate new draft; no customer/vehicle/RO creation from scan |
| Cross-shop intent/read/claim/ingest/accept/media request | Denied even with known UUID, VIN, enterprise membership elsewhere or forged body shop |
| Wrong wheel, changed visit binding, tire rotation/replacement | Reject attachment; no relabeling or VIN-based lookup fallback |
| Replayed/expired handoff, wrong device verifier, open redirect | Atomic one-time claim; deny wrong device; return only to allowed local location |
| Revoked membership/entitlement, disabled shop, closed visit | Revalidate at sink; no acceptance; permitted existing evidence remains read-only |
| Dirty editor/stale revision/sheet deactivation/config change | Explicit conflict; candidate retained; no last-write-wins, auto-rebase or completion |
| Duplicate UUID and same request with different payload | One immutable ownership binding; exact retry gets receipt; changed payload conflicts |
| Lost ingestion/acceptance response and process restart | Exact-ID recovery finds commit or pending outcome; never duplicate acceptance/capture |
| Native killed before/after UUID persistence | Recover same UUID where supported; otherwise explicit unresolved state, no success fabrication |
| Pending/unknown/failed/aborted, out-of-order callbacks | No readiness until documented ready status; no terminal regression or fake zeros |
| 60-second retrieval timeout, budget exhausted, 24-hour boundary | Bounded work; pending/availability-expired shown; manual fallback and fresh explicit attempt available |
| Global only, zero/two/three/more regions, unavailable region | Preserve count/order/availability; never pad, average or copy into three required fields |
| Left/right sweeps, opposite wheel sides, null direction | No inferred inner/outer mapping; manual fields unchanged without approved mapping |
| Units: 25.4 mm, 1 inch, 32 thirty-seconds; 6.35 mm | Equivalent 32/32 and 8/32 conversions; original units/precision retained; reject unknown/negative/nonfinite |
| Corrected reading and rescan | Original immutable; new attributed revision; old review freshness invalidated on acceptance |
| Arrival association vs vendor image vs inspection photo | No automatic photo requirement satisfaction or customer-release selection |
| MIME mismatch, oversize media, SVG/GIF, arbitrary URL | Reject through existing boundaries; no script execution, hotlink or SSRF path |
| No license, permission denied, offline/poor network, unsupported device | Clear action, no false success; full manual DVI stays usable |
| Reopen pending scan after session expiry/device switch | Fresh authorization; no assumption cross-device vendor retrieval works |
| Storage/attempt cap and kill switch | Visible capacity/disabled state; retain receipts/evidence; no silent eviction or billing retry storm |
| Advisor review and existing non-tire inspection | Unchanged permissions, requirements, full-DVI navigation and release policy |

## 9. Completion evidence and execution handoff

This deliverable was checked against public documentation and the existing intake,
staff authority, strict finding schema, canonical binding, sheet and media
contracts. No application was started and no signed-in UI or scanner was tested.
There are no application changes to visually verify. Vendor claims above are
documentation evidence, not device-accuracy or account-access test results.

Primary engineering seams for approved follow-on work:
`components/NewWorkOrderModal.tsx`, `components/use-ro-recovery.ts`,
`components/ROOdometerCapture.tsx`, `app/dashboard/shop-workflow/page.tsx`,
`components/shop-dispatch/DispatchPilot.tsx`, `components/shop-dispatch/DviEntry.tsx`,
`app/api/shop-dispatch/inspection/route.ts`,
`app/api/shop-dispatch/inspection/media/route.ts`,
`lib/auto-dvi/staff/{access,model,service,sheet-catalog}.ts`,
`lib/auto-dvi/visit-model.ts`, and
`lib/data/repositories/workflow-inspections.ts`.

**Decision requested:** approve identification-only, approve a separately scoped
native companion path subject to the checklist, or request a broader wrapper
business case. Until that decision and licensing/privacy gates are recorded,
remain specification-only.
