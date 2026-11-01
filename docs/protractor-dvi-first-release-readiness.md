# Protractor DVI first release — isolated readiness

## Activation status

Implementation is on the existing visit-bound workflow inspection foundation.
**No live activation, deployment, database migration, provider probe, provider
write, or shop enrollment was performed.** Recording is off unless a separately
approved shop is explicitly present in `recording.enabledShopIds`. Existing
inspection, publication and Protractor pilot gates remain independent.

The existing `auto_dvi` entitlement is the outer product gate, not a new
first-release switch. Staff access and public report/media access enforce it.
The check-in context UI requires verified DVI capability; its API checks the
entitlement before reading and before returning context. Workers skip disabled
shops before scanning or claiming queued work, even when their explicit worker
list still includes those shops. Ordinary RO creation and non-DVI VHI remain
outside this optional enrichment path.

The older `.local/tasks/video-dvi-tekmetric.md` specification was inspected.
No corresponding ready implementation was found in this checkout or local
history. Its separate sessions, Replit object storage and priced Tekmetric jobs
were not imported. No standalone design artifact was modified.

## Implemented workflow

1. Existing guided check-in, shared drafts, arrival context and exact native-ID
   RO recovery remain the entry point. Merely opening check-in does not create an
   RO. Confirmed handoff initializes the approved default sheet; uncertain
   creation retains its original identity rather than starting another RO.
2. Confirmed VIN, mileage and units trigger optional early VHI context.
   Canonical cache validity rules apply. An explicitly enrolled shop can enqueue
   a bounded background preparation on cache miss. This uses retained CARFAX
   only, never a paid CARFAX request, and does not overwrite the shared plan
   cache. Changed browser context rejects late results. No score or inspection
   rating is inferred from missing coverage or maintenance timing.
3. Explicit manager policy saves version completion mode and publication/
   delivery roles. Inspections pin their policy. Current restrictions also apply
   at publication/delivery. Existing per-item evidence requirements remain
   independent of color; untouched checks are never automatically green.
   Restricting new publication does not remove authorized revocation of existing
   links. Deliver-only roles can use existing published links without obtaining
   permission to create links or publish a new version.
4. Foreground continuous or short capture saves independent segments to
   IndexedDB before upload. Exact SHA-256/sequence receipts precede local
   deletion. Restart-safe Mongo receipts and private GridFS media use current
   visit/contributor authority. Upload, processing, interruption and confirmed
   saves have separate states.
5. A dedicated worker makes narration-only, unconfirmed drafts incrementally.
   Later segments do not overwrite row corrections or saved findings. Inline
   Apply is explicit and produces an unsaved item draft. No visual model runs.
6. Selected video ranges and technician-reviewed captions enter a separate
   bounded clip queue. ffmpeg physically removes audio, subtitles and metadata;
   ffprobe verifies the derivative has only a video track. Preparation is not
   publication. Advisors explicitly select up to three prepared clips per
   released finding. The exact customer-layout preview plays prepared clips
   through a staff-authorized, visit-scoped endpoint before publication.
7. Customer reports retain immutable releases, pinned versions, revocation and
   public entitlement checks. They support silent selected playback/Play All,
   captions, concerns, red/yellow/green ordering and image/text fallback. Raw
   recording media is never accepted by the public route.
8. Authorized delivery can explicitly include an existing published report
   version/link. The server resolves the URL from an approved HTTPS origin,
   keeps the bearer token in the URL fragment rather than the page request query,
   verifies the exact released finding set and rechecks link authority before
   sending. The URL is placed in existing native inspection-line Notes, with
   the original native labels and stable package/line IDs. Exact readback is
   required for confirmation. No paid jobs are created.

## Observable limits and evidence

| Boundary | Implemented limit |
|---|---|
| Raw segment | 4 MiB; target 10 seconds, reject beyond 15 seconds |
| One recording | 30 independent segments; roughly five minutes at target length |
| Device queue | 30 entries / 120 MiB across all scopes; never silently evicts another visit |
| Derived clips | 30 requests per recording, at most 15 seconds and less than 4 MiB each |
| Browser transfers | One serialized request; 20-second request timeout |
| Processing | One leased unit per recording; three attempts; 90-second lease; narration deadline 60 seconds |
| Codec operations | Fixed local paths, no shell/remote input; one codec thread; bounded output and command timeout |
| Shop admissions | Coarse 100 recordings / 24 hours; not an atomic multi-replica billing quota |
| Cached intake context | Four process-local reads; 2.5-second optional deadline; at most eight Mongo candidates, two-second DB execution limit |
| Intake preparation | At most 16 new contexts per shop/10-minute window; two claim attempts; 20-second build-request deadline |
| Intake UI | Ten bounded polls, 40-second overall abort, no block on check-in |

Processing concurrency is additionally bounded by the explicitly deployed
worker count. Do not add workers without remeasuring provider, database and
codec capacity. The preparation request timeout does not prove the internal
plan builder stops all work on disconnect; verify this before rollout.

### Measured offline result

Real headless Chromium with its synthetic camera/microphone recorded through
the production capture controller, IndexedDB and real isolated GridFS. A
deterministic fixture narration draft appeared **11,993 ms after capture
started**, while continuous capture was still open. The same test prepared an
actual silent MP4 derivative and verified media did not mutate saved inspection
evidence. This is **not paid-model latency or a p95 measurement**.

The provisional acceptance target is p95 <=30 seconds from a segment becoming
available to its reviewable draft. Live model latency, speech quality, token
counts, transcription cost and per-inspection cost remain unmeasured.
Offline runs made zero paid-service calls; no production dollar estimate is
claimed. OpenAI tracking is reused, and background recording opts into
fail-closed budget lookup. Deepgram cost accounting needs separate measurement.

## Verification

Isolated tests cover:
- explicit policy adoption, required/captured modes, color-independent evidence,
  pinned/current role intersection and real Mongo policy readback;
- shared check-in ownership, default-sheet handoff and exact-identity recovery;
- stale intake context, missing coverage, queue deduplication and claim races;
- foreground interruption, device persistence across reload, private scopes,
  admission before camera, digest mismatch, exact retry, timeout and delayed Stop;
- worker lease expiry, restart, duplicate upload, lost acknowledgment, revoked
  contributor access, closed visits and unchanged saved evidence;
- narration-only drafts, no automatic ratings, inline corrections, bounded
  clip selection and actual audio-free output;
- report clip allowlists, immutable pinned media, revoked links, wrong identity,
  MIME validation, blob URL cleanup, playback errors and text-only reports;
- native URL Notes readback, lost provider responses, changed/revoked report
  references, exact published finding scope and no paid service packages.

Primary commands run under an empty environment with
`tests/helpers/deny-network-egress.cjs` and
`scripts/_stubs/server-only-stub.cjs`. Mongo/browser tests explicitly allow
loopback and use disposable local databases. Full TypeScript checking is run
without a concurrent Next build. Browser entry points:
`tests/browser/recording-workflow.smoke.ts`,
`tests/browser/recording-outbox.smoke.ts`, and
`tests/browser/inspection-policy.smoke.ts`.

Chromium fake devices do not establish iOS Safari, Android hardware, permission
dialogs, camera orientation, thermal, low-storage or real lock-screen behavior.
Those remain acceptance items, not supported-device claims. Unsupported browser
recording must fall back to manual findings/photos.

## Setup and separate live approval

Before enabling any named shop, an operator must approve:

- The shop, staff roles, approved sheets and completion/evidence policy.
- GridFS capacity and retention, recording/preparation query indexes, monitoring
  and orphan cleanup that protects every released clip and pending receipt.
  No automatic index creation or production migration is included.
- ffmpeg/ffprobe availability on the actual Render worker, codec licensing and
  resource allocation. Replit's object-storage sidecar is not assumed.
- A dedicated supervised worker invocation:
  `node --import tsx scripts/dvi-recording-worker.ts --shops <approved-ids>`.
  This command was **not run against configured production stores**.
- The existing recording gate plus the independent publication and Protractor
  pilot gates. The native pilot remains limited to its existing shop/test scope;
  this task does not authorize expansion.
- An approved `release.publicReportOrigin` HTTPS origin, valid report signing
  configuration, and a real released link. No guessed production URL is used.
- Verification of native Notes persistence and **actual Protractor clickability**.
  Clickability remains explicitly unverified even when exact URL text reads
  back successfully; unsupported display is a rollout blocker.
- Physical phone/tablet/desktop checks, narration timing/cost measurements,
  active background processing, supervision and support ownership.

## Support and rollback

- Keep the inspection visible and the device unlocked. Independent segments can
  have brief gaps. This is not background or full offline recording.
- Keep the same browser tab and contributor identity for recovery. Do not clear
  browser storage while uploads are pending. Retained device footage survives
  reload, but tab/session identity and browser quota behavior have limitations.
- Use Recover pending uploads for the original bytes and identity. Never
  manufacture a replacement segment after an uncertain upload.
- Retry failed processing explicitly, within the three-attempt cap. Exhausted
  or unsupported media stays private for manual review; no good result is inferred.
- Clip requests, recording saves, publication, link creation and provider
  delivery have separate receipts. Publication alone never means delivery.
- If provider delivery is uncertain, verify the original operation. Never
  recreate its package or automatically resend.
- Rollback by stopping approved workers and disabling new recording admissions
  through the normal operator procedure. Do not delete originals, receipts,
  releases or links as a rollback. Revoke specific public links deliberately.
  Existing manual inspections/photos and immutable released reports remain.

No live rollout is authorized by this document or by passing isolated tests.
