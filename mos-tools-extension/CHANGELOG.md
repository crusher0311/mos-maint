# Detect Dog by MOS Tools — Changelog

## 1.27.9 — 2026-05-19

### Improved
- **Oil sticker buckets can now be renamed and hidden per shop (Task
  #439).** The four built-in interval types (Conventional, Synthetic,
  European, Diesel) each now accept an optional custom name and a
  "Hide from pickers" toggle in the web app's sticker settings. The
  Detect Dog side-panel "Oil Type" dropdown, the Tekmetric right-click
  oil-sticker menu, and the Shop-Ware right-click oil-sticker menu all
  honor those flags — hidden buckets disappear and visible ones display
  the shop's custom label (e.g. "Full Syn 0W-20" instead of
  "Synthetic"). The right-click auto-print path also skips hidden
  buckets when picking an oil type (e.g. if "Euro" is hidden, a BMW
  falls through to Synthetic). Existing shops with no custom labels see
  the original four names unchanged.

## 1.27.8 — 2026-05-19

### Improved
- **VHI overlay no longer shouts "0/CRITICAL" when we just don't have
  enough service history (Task #439).** When CARFAX returns no records
  (rejected VIN, no history, not configured, etc.) AND the shop has
  fewer than three records of its own for the vehicle, the panel header
  now shows a gray "?" badge with a tooltip reading "Insufficient
  service history — bring vehicle in for inspection" instead of the
  red 0/Critical badge. The footer reads "Insufficient history — bring
  vehicle in for inspection" instead of "Score: 0 (Critical)". The
  minimized pill goes gray with the label "Limited history" instead of
  "X overdue". Triggered by the 2005 Ford F-150 (Schindler's Garage,
  VIN 1FTPW145Y5KC34104) where CARFAX returned error 107 ("VIN not
  valid") on every call, leaving the plan with zero anchors and every
  OEM interval reading as overdue — score correctly computed at 0 but
  presenting that as "Critical" misrepresented the situation. The
  underlying score is still computed and logged for internal tracking;
  only the customer-facing presentation changes. Backed by a new
  `dataQuality` field on the plan/VHI response payloads.

## 1.27.7 — 2026-05-14

### Improved
- **VHI overlay now surfaces "implies-reset" anchors (Task #434).** When
  CARFAX shows a parent service that implicitly resets a child's
  interval clock — e.g. "Four tires replaced" resets the tire-rotation
  cycle — and there is no direct child record, the overlay now anchors
  against the parent and labels the row "Anchored to <parent
  service> on <date>" instead of the misleading "Last done at …"
  phrasing. The Lexus RX350 case in the spec (rotation row had been
  anchored at zero, screaming "184,354 mi over") now reads "Due at
  193,908 mi · 4,536 mi to go." Hand-curated map, one hop only,
  fallback only — direct child records still always win, and the
  task #431 odometer-borrow rule still applies.

## 1.27.6 — 2026-05-10

### Fixed
- **Job Lookup now sends the target VIN to the search API.** The
  Lookup tab was firing `/api/extension/jobs/search` without the `vin`
  parameter, so the server fell into a code path that early-returned
  before resolving the VIN from the work order. Result: every search
  came back with `dataOneEnhanced: false` and `acesTier: null` on
  every donor, so ACES tier matches (Exact Fit ACES 100%, Same engine
  75 floor, Same submodel 70 floor — Task #382) never fired and the
  scorer always fell through to the legacy heuristic. Reproduced on
  RO 500278 (2015 Jeep Cherokee, VIN `1C4PJMCB7FW568719`) where a
  same-shop same-year same-model donor scored 94% instead of the
  100% ACES short-circuit it should have hit. Now: sidepanel sends
  `currentContext.vin` on every search; the server-side
  `resolveVehicleContext` was also hardened to fall back to the WO
  doc when VIN is missing even if year/make/model were passed.

### Added
- **"ACES match unavailable" banner on Job Lookup results.** When the
  API returns `dataOneEnhanced: false`, the Lookup tab now shows an
  amber notice above the results so an advisor knows the scores are
  from the heuristic scorer only. Previously this was completely
  silent — the only way to tell ACES had failed was to read the raw
  API response in DevTools.

## 1.27.5 — 2026-05-07

### Fixed
- **VHI panel now shows the technician's DVI note instead of "No record of
  this service being performed."** When a DVI item (Front Brake Pads,
  Fluid Leaks, Other, etc.) is brought into VHI, the API has always
  carried `item.notes` (the tech's finding text), but `sidepanel.js` only
  rendered `item.reason`. For DVI Finding rows `reason` is unset, so the
  panel fell through to the generic "no record" fallback even though the
  tech's note was sitting right there on the item. Now: for DVI Finding
  items the tech note replaces the fallback; for non-DVI items with a
  note, the note is appended on a second line as "Tech note: …".

## 1.27.4 — 2026-05-06

### Fixed
- **"Add all to concerns" button now actually adds concerns to the RO.**
  Pre-1.27.4 every concern POST to Tekmetric's
  `/api/repair-orders/{roId}/technician-concerns` endpoint silently
  returned HTTP 400 with
  `{"inspectionRating":"Inspection rating is required",
  "inspectionTask":"Inspection task is required"}` — the body shape
  `{concern: "..."}` we'd been sending since the feature shipped was
  never the right one (no idea where it came from). Replaced with the
  shape Tekmetric's own UI sends, captured from real HARs supplied by
  Brandon on 2026-05-06:
  ```json
  {
    "inspectionRating": {"id": 3, "code": "RQRSATTN", "name": "Requires Immediate Attention"},
    "inspectionTask": "[VHI: Engine Oil] — overdue 5000 mi"
  }
  ```
  - **Severity-aware rating mapping**: overdue items get the red
    `RQRSATTN` ("Requires Immediate Attention", id=3) rating; due-soon
    items get the yellow `MAYRQRATTN` ("May Require Attention Soon",
    id=2) rating. Both rating shapes were verified against HARs from
    real Tekmetric UI POSTs.
  - **`inspectionTask` is just the title string** — Tekmetric's
    response confirms `hasRoInspectionTask:false, roInspectionId:null`,
    so we don't need to (and can't) link concerns to real RO inspection
    tasks. The marker rewrite from 1.27.3 still applies (so the title
    becomes `[VHI: Foo] — desc` not the verbose
    `[ai-suggested from VHI: Foo] — desc`).
  - **Idempotency GET parser + silent-success verification re-fetch
    parser** both updated to read `c.inspectionTask` (the field that
    actually exists on the response) instead of the imaginary
    `c.concern` field, with a defensive `c.concern` fallback. Without
    this fix, the existing-concerns dedupe set would always be empty
    after a successful POST and the verification step would always
    falsely demote successful POSTs to "failed".

## 1.27.3 — 2026-05-06

### Changed
- Renamed the VHI button tooltip to "Add all to concerns" per
  platform-admin direction (was the longer "Add VHI items as technician
  concerns (overdue + due-soon services)").
- **Concern marker shortened from "[ai-suggested from VHI: ...]" to
  "[VHI: ...]"** per platform-admin direction. The verbose marker is
  emitted by the proposal generator on the MOS API server (different
  repo), so the extension now rewrites the marker client-side
  immediately before POSTing to Tekmetric. The markerRegex used for
  idempotency and the silent-success verification re-fetch was widened
  to match both the new short form and any legacy "[ai-suggested from
  VHI: ...]" or "[VHI] ..." concerns already present on existing ROs,
  so deduplication keeps working through the transition.

### Fixed
- **Side panel header now shows the friendly RO #, vehicle, and
  customer immediately on first paint** instead of placeholder
  "Vehicle / RO #316713112" (the long internal Tekmetric ID) until the
  VHI server round-trip completes. Implemented via a passive,
  scrape-free hook in the main-world fetch/XHR interceptor: when the
  Tekmetric SPA itself fetches `/api/shop/{shopId}/repair-order/{roId}`
  the response is parsed and posted to the content script as
  `MOS_RO_LOADED`. The content script merges friendly RO #, vehicle
  (year/make/model + id), VIN, customer (name + id), and mileage-in
  into the per-RO context cache and re-emits `SET_SMS_CONTEXT`. No DOM
  scraping involved, so this survives Tekmetric UI redesigns.

## 1.27.2 — 2026-05-05

### Changed
- **"Add technician concerns from VHI" (formerly "Build estimate from VHI")
  now creates technician concerns ONLY.** Job creation has been removed
  per platform-admin direction — the advisor builds the matching jobs
  themselves from the concerns the technician sees. This also fixes a
  reported issue where job rows were appearing on the RO with no matching
  concerns visible.
- Button title and modal header updated accordingly.

### Fixed
- **Silent-success guard on technician-concern POST.** Previously, if
  Tekmetric's `/api/repair-orders/{roId}/technician-concerns` POST
  returned 2xx without actually persisting the concern, the extension
  would mark the item as "added" and the toast would lie. The apply
  flow now (a) logs the full POST response body for every item, and
  (b) re-fetches the concerns list after the loop to verify every
  successful POST is actually visible on the RO. Items that POSTed 2xx
  but are missing on re-fetch are demoted from "added" to "failed" so
  the user sees the real outcome.

## 1.27.1 — 2026-05-05

### Changed
- **"Build estimate from VHI" button now uses the AI-flavored VHI icon
  (`aiVHI_icon.png`)** so it matches the visual style of the sibling
  Pre-fill DVI and Enhance Notes buttons in the Tekmetric RO toolbar.
  Previous build (1.27.0) used a placeholder inline SVG that did not
  match the rest of the icon row.

## 1.26.7 — 2026-04-29

### Added
- **Engine-aware oil warning in the side panel.** When a vehicle's
  engine is flagged for shorter oil intervals (TGDI engines, Hyundai/Kia
  Theta II, etc.) and the active OEM oil interval is ≥ 7,500 mi, the
  oil row now shows an amber "⚠ Engine flagged — long oil interval"
  chip with the same hover tooltip the advisor dashboard displays.
- **Auto-inserted "Safety Check — Oil Level" row.** Flagged engines
  also get a 3,000 mi safety-check recommendation, anchored off the
  most recent oil change so service writers see it at the counter.
- Existing cached analyses are invalidated automatically — no manual
  reload required for the new chip and row to appear.

## 1.26.6 — 2026-04-28

### Fixed
- **Autoflow side panel stuck on "Loading VHI…".** The Autoflow
  content script was posting context updates as
  `{ type: "SMS_CONTEXT_UPDATE" }`, but the background worker only
  listens for `{ action: "SET_SMS_CONTEXT" }` (the protocol Tekmetric
  and Shop-Ware already use). The message was silently dropped, so the
  side panel never received a shop / RO / VIN and never loaded a plan.
  Aligned the Autoflow adapter with the rest of the codebase.
- Added an `[Autoflow]` content-script load log so it's obvious in the
  browser console whether the adapter is running on
  `*.autotext.me` / `*.autoflow.com` pages.

## 1.26.5 — 2026-04-21

### Added
- **VHI progress bars in the side panel.** Every overdue / due-soon /
  upcoming row now shows the same dual Miles + Time bars that the
  advisor dashboard uses, with right-side headlines like
  "8,868 mi over" and "4 mos over."
- **Axis-aware overdue summary.** When both interval axes are past due,
  the row reads "8,868 mi over • 4 mos over" instead of just the
  mileage half.

### Improved
- **VHI Coach (DVI overlay) recommendations** now spell out which
  axis triggered the alert — e.g. "OVERDUE by mileage AND time
  (8,868 mi over, 4 mos over) — recommend immediate service" /
  "OVERDUE by mileage (...)" / "OVERDUE by time (...)". No
  extension-side change was needed; this comes from the updated
  /api/extension/vhi-coach response.

### Notes
- Older installs that don't yet receive a `progress` payload from the
  server fall back to the previous "X mi overdue" wording, so nothing
  regresses if a row is missing the new fields.
