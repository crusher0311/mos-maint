# Detect Dog by MOS Tools — Changelog

## 1.27.38 — 2026-06-27

### Changed
- **Create RO submits much faster.** Submitting a new repair order now returns as
  soon as the RO is created in Protractor — you still get the RO number and link
  right away. The dashboard bookkeeping (VIN decode, syncing it into MOS) now
  finishes in the background instead of making you wait. The success screen notes
  that the RO may take a moment to appear in the MOS dashboard.

## 1.27.37 — 2026-06-27

### Fixed
- **Bigger customer search box.** The "Search" button next to the customer search
  field was taking the full row width and squashing the input. The input now
  fills the row and the button only takes its own width.
- **History jobs read clearly.** Past jobs in the **History** tab were showing
  "[object Object]" for the vehicle; they now show the year/make/model.
- **Create RO no longer times out as easily.** Submitting a new repair order now
  waits up to 120 seconds (instead of 45) because creating the RO runs several
  slow lookups in Protractor behind the scenes on busy shops.

## 1.27.36 — 2026-06-27

### Changed
- **Create Repair Order now works just like the dashboard.** The "Create Repair
  Order in Protractor" side panel has been redesigned to match the full-screen
  Create RO experience step for step: start with the **Customer Concern** (with
  the AI Concern Assistant and the option to add more than one concern), then
  pick the **Customer**, then the **Vehicle**, then **Notes & Mileage**, then
  **Jobs**, and finish on a **Confirm** summary before you submit.
- **Snap a photo of the VIN or plate.** On the Vehicle step you can now take or
  upload a photo and we'll read the VIN or license plate from it, then fill in
  the year/make/model automatically. You can also type a 17-character VIN to
  decode it on the spot, or enter a plate + state to look the vehicle up.
- **Add jobs from three places.** The Jobs step now has **Canned**, **Deferred**,
  and **History** tabs, so you can pull in shop canned jobs, the vehicle's
  previously declined/deferred work, or anything from past repair orders — all
  into one new RO.

### Fixed
- **No more duplicate follow-up questions in the Concern Assistant.** When you
  clicked **More Questions**, the new set sometimes repeated questions you'd
  already been asked or answered, making the advisor re-cover the same ground.
  Repeats are now filtered out — both against everything asked in earlier rounds
  and within each new set — using a forgiving match that also catches reworded,
  re-cased, or re-punctuated near-duplicates. When there's nothing new left to
  ask, you'll see a clear "No further questions" message and the **More
  Questions** button is disabled, so you can go straight to Finish.

## 1.27.34 — 2026-06-27

### Fixed
- **No more false "session may have expired" when adding a Canned Job to an RO.**
  Adding a job from the **Canned Jobs** tab sometimes showed a "Session may have
  expired — click to re-login" prompt even though you were still signed in, while
  the same action from the **Job Lookup** tab worked fine. The canned path does
  more slow work behind the scenes, so it was more likely to land on a brief,
  harmless auth hiccup that the standard retry budget couldn't ride out. Those
  add-to-RO requests now get a longer retry window so a momentary blip clears
  quietly instead of interrupting you. A genuinely expired/invalid login still
  correctly prompts you to sign in again.

## 1.27.33 — 2026-06-26

### Added
- **A heads-up when the odometer you entered looks off.** Now that the VHI runs
  on the odometer typed on the open repair order, a slip — like a dropped digit
  that lands well below the vehicle's last known reading — would quietly skew the
  overdue/due-soon math. Detect Dog now shows a small, non-blocking note under
  the mileage (e.g. "Entered 11,950 mi — last record 116,266 mi") so you can
  confirm or correct the reading before it affects the plan. The math still runs
  on the entered value; the note is just a nudge.

## 1.27.32 — 2026-06-26

### Fixed
- **The VHI now uses the odometer you entered on the open repair order.** Before,
  the overlay sometimes showed an *estimated* mileage (from CARFAX) that
  disagreed with the actual "In:" reading on the RO — for example showing
  116,266 when the screen said 119,500 — which threw off the overdue/due-soon
  math. Detect Dog now sends the on-screen odometer to the server and anchors the
  whole VHI on it. The CARFAX estimate is only used when there's genuinely no
  entered odometer, and the mileage is still flagged when it's an estimate. A
  clearly-too-low scrape won't drag a higher known mileage backward.

## 1.27.31 — 2026-06-16

### Added
- **Show/hide password toggle on the sign-in screen.** The Password field now has
  an eye icon you can click (or tab to and press Enter/Space) to reveal what you
  typed, so you can catch typos before signing in — handy on shared shop
  computers. Click it again to re-mask. The password always starts hidden each
  time the login screen appears, and the toggle only changes what you see — it
  never changes what gets submitted.

## 1.27.30 — 2026-06-15

### Fixed
- **Features now load reliably right after signing in on a new computer.** During
  login the panel could briefly lose track of the open repair order while it was
  still fetching the shop's enabled features. That caused the feature load to
  error out and retry until it gave up ("keeping last-known-good" with nothing
  saved yet), so buttons and tabs could appear missing on a fresh sign-in. The
  panel now locks onto the shop at the start of the fetch so the retries can't be
  knocked off course.
- **The Print tab no longer shows a false "Printing features are not enabled"
  message.** If the server briefly couldn't load a shop's oil-sticker settings
  (a temporary hiccup, like backend slowness — not a real "feature off" answer),
  the panel used to show the permanent "not enabled — contact your administrator"
  notice, even for shops that have printing fully enabled. It could even appear
  right above a working Service Keytag form. Now that notice only appears when
  **both** printing features (oil stickers and keytags) are genuinely turned off
  for the shop; a temporary load failure quietly keeps the last-known-good state
  and refreshes in the background instead.

## 1.27.29 — 2026-06-10

### Fixed
- **The subscription lock no longer flashes on a momentary backend hiccup.** If
  the server briefly couldn't look up a shop's plan (a transient error, not a
  real "not subscribed" answer), the side panel used to treat that as "no
  features" and show the upgrade/lock screen — even for paying shops. Now the
  server clearly signals a temporary problem, and the panel quietly keeps the
  last known-good features and retries in the background instead of locking the
  user out. A genuine "not entitled" answer still shows the lock as before.

### Changed
- **The Print tab (keytags + oil stickers) now fills in instantly.** When a
  repair order loads, the customer name, vehicle, RO number, and mileage are
  taken straight from the data the shop page already fetched, so the keytag and
  oil sticker populate immediately and Print unlocks right away. The backend
  still confirms in the background, but a slow or incomplete reply can no longer
  blank out or re-lock fields that were already filled correctly.
- **Captured page data is now trusted over screen-scraping.** The extension
  prefers the repair order's own loaded data (VIN, vehicle, customer, mileage)
  as the source of truth, using on-screen text only to fill gaps. This stops the
  occasional wrong values (like the literal words "Name" or "Vehicle") that
  appeared while the shop page was still drawing, and lets the Specs and Common
  Failures tabs skip redundant lookups when the data is already on hand.

### Internal
- Captured repair-order data is cached per shop **and** repair order, so a
  repair-order id can never be confused between two shops.

## 1.27.28 — 2026-06-07

### Added
- **The floating Detect Dog button can now be turned on or off.** The round
  button that opens the Detect Dog side panel on your shop management screens
  (Tekmetric and Shop-Ware) is now controllable two ways:
  - **Owners (per location):** In the web app under **Settings → Preferences →
    Detect Dog Extension Button**, an owner can set the floating button to
    "Use default", "Always on", or "Always off" for the location currently
    selected in the sidebar. Turning it off here hides it for *everyone* at that
    location — it's a hard switch staff cannot override.
  - **Each user:** At the bottom of the side panel, every user gets a
    **"Show floating button on shop pages"** checkbox to hide it just for
    themselves. If the owner has turned it off for the whole shop, this checkbox
    is disabled with a note explaining why.
  - **Smart default:** For shops whose only enabled features are oil stickers and
    keytags, the floating button now defaults to **off** (since the side panel's
    other tools don't apply). Owners can still force it on.

## 1.27.27 — 2026-06-06

### Added
- **The AI Customer Concern Assistant is now built into the Create RO flow.** On
  the Create RO "Details" step, advisors with the Concern Assistant feature see a
  new **"Use AI Assistant"** button under the Customer concern box. It launches
  the same assistant used on the dashboard and the standalone Concern tab —
  describe the concern, answer the AI-generated follow-up questions, and finish to
  get a cleaned, professional write-up. The write-up flows straight back into the
  new repair order via a **"Use for Repair Order"** button, so the polished
  concern is saved on the RO when it's created in Protractor. The button only
  appears when the shop has the Concern Assistant feature enabled.

## 1.27.26 — 2026-06-06

### Fixed
- **AutoFlow DVI pages now resolve the shop, vehicle, and mileage reliably on
  both v3 (`*.autotext.me`) and v4 (`app.autoflow.com/shop/*`).** Advisors on a
  DVI page (e.g. `harrells-nc87.autotext.me/Admin/dvi_v3/...`) were seeing no
  VHI Coach data, a "Could not detect vehicle mileage" message, and a
  "No accessible shop configured for SMS shop ID …" error even though the
  mileage and VIN were on screen. Three root causes:
  - **Shop detection** was subdomain-only, so AutoFlow v4's shared host
    (`app.autoflow.com`) produced a wrong/generic id. Detection is now
    deterministic: the per-shop subdomain on v3, or the `/shop/<slug>` path
    segment on v4, and generic infrastructure subdomains (`app`/`www`/`admin`/…)
    are never treated as a shop id.
  - **VIN + mileage live in editable form fields** on the DVI page, so their
    values are not in the page text the scraper read. The adapter now also reads
    `<input>`/`<textarea>`/`<select>` values matched by field name/label, and the
    text-based mileage match tolerates a required-field asterisk and assorted
    separators (e.g. `Mileage *: 191,485`).
  - **RO/ticket detection** gained AutoFlow v4 path forms
    (`/shop/<slug>/repair-orders/<id>`, `/ro/<id>`, …) alongside the existing v3
    `status_id`/`dvi` URL patterns.
- **Dual-integration AutoFlow shops now get a real maintenance plan.** Shops
  that pair AutoFlow with a write/read provider (e.g. Protractor or Tekmetric)
  resolve under that provider, so the plan endpoint never took its AutoFlow
  path. The backend now anchors on the AutoFlow hint, resolves the VIN from
  AutoFlow's DVI ingest, and enriches the vehicle/mileage/customer from the
  linked provider matched **by VIN** (AutoFlow and the linked provider use
  different RO numbers).

## 1.27.25 — 2026-06-05

### Fixed
- **Shopmonkey shop detection now resolves the real company/location id from a
  live session.** The initial Shopmonkey adapter (1.27.24) discovered the
  per-shop identifier with a best-effort localStorage scan written from the API
  shape, without a live browser session. Verified on a real logged-in
  Shopmonkey order page, that heuristic was wrong in two ways:
  - It would have matched `algoliaCompanySearchAppIdKey` (an Algolia app id like
    `"C6099O1RSQ"`, not a Shopmonkey id) because the key name contains
    "company"/"id", producing a bogus `shopId`.
  - The canonical company/location ids are not in their own localStorage keys or
    in the auth JWT — they live in Shopmonkey's LaunchDarkly context, stored as
    a base64-encoded JSON payload inside the localStorage **key name**
    (`ld:<envId>:<base64>` → `{ company: { key }, location: { key }, ... }`).

  The adapter now decodes the LaunchDarkly context as the primary id source, and
  the generic localStorage fallback now requires an ObjectId/UUID-shaped value
  and skips third-party keys (Algolia/Pendo/Canny) so they can't masquerade as a
  Shopmonkey id. As a result `SET_SMS_CONTEXT` fires on order pages and the
  `no_shop_identifier` telemetry drop is eliminated.
- **Order-number detection gains a `document.title` fallback.** Shopmonkey order
  detail pages don't render an "Order #" string in the page body, so the human
  order number is now also derived from the browser tab title when present (the
  order is still resolved by its URL id regardless).

> Note: the order route (`/order/{id}`) and vehicle (year/make/model)
> extraction were confirmed correct against the live session and are unchanged.

## 1.27.24 — 2026-06-05

### Added
- **Shopmonkey support (read-only context + VHI Coach).** The extension now
  runs on the Shopmonkey web app (`app.shopmonkey.cloud`), bringing the same
  on-page experience advisors already have on Tekmetric, Shop-Ware, and
  AutoFlow:
  - A new content adapter (`adapters/shopmonkey-content.js`) detects the open
    Order (RO) context — order number, vehicle (year/make/model + VIN),
    mileage, and customer contact — by reading the page, and relays it to the
    background worker, which resolves the matching MOS shop and drives the
    VHI Coach overlay (`vhi-coach.js`) and realtime updates
    (`realtime-subscriber.js`).
  - Host permissions, content scripts, and web-accessible resources were added
    for `app.shopmonkey.cloud` / `*.shopmonkey.cloud`, mirroring the existing
    provider wiring. No write-back actions are enabled for Shopmonkey yet.
  - Shopmonkey is a single-host SPA, so the per-shop identifier
    (companyId / locationId) is discovered from the page rather than the
    hostname. The exact storage keys / DOM selectors are best-effort and pending
    live verification on a real Shopmonkey session.

## 1.27.23 — 2026-06-05

### Fixed
- **AutoFlow VHI recommendations now carry the correct severity.** When adding
  VHI recommendations to an AutoFlow RO (`add_rvh`), the payload previously
  omitted the modal's `type` (severity/category) select, so every added item
  landed on AutoFlow's default ("Concern") regardless of urgency. The accepted
  values were confirmed from AutoFlow's own source JS
  (`/Admin/dvi_v3/js/jquery.atme.rvh.js`): `0` = Concern, `1` = Information,
  `2` = Service. We now map recommendation status onto `type` — overdue → Concern,
  due-soon → Service, unknown → Information — so added items reflect whether they
  are overdue vs. due-soon.

## 1.27.22 — 2026-06-05

### Fixed
- **AutoFlow DVI write-back payloads verified and corrected against AutoFlow's
  own source JS.** The write-back actions shipped in 1.27.21 were built from
  reference patterns and had never been checked against AutoFlow's real request
  format. Confirmed the actual payloads from AutoFlow's public DVI scripts
  (`/Admin/dvi_v3/js/jquery.atme.notes.js` for `update_sheet`,
  `jquery.atme.rvh.js` for `add_rvh`):
  - The **Add Recommendations** (`add_rvh`) fields (`details`, `notes`,
    `skip_mapping`) were correct — no change.
  - **Pre-fill DVI** / **Enhance Notes** (`update_sheet`) now send `sheet_id`
    (which AutoFlow's own UI always includes) and no longer send
    `inspec_sub_status` / `customer_approval`, which do not exist anywhere in
    AutoFlow's DVI and were silently ignored by the server.
  Per-shop flags remain default OFF; one logged-in pilot shop should still run
  all three actions end-to-end before broader rollout.

## 1.27.21 — 2026-06-05

### Added
- **VHI write-back actions on AutoFlow (DVI).** The three VHI actions that
  previously existed only on Tekmetric now work on AutoFlow / autotext.me DVI
  pages, each behind a per-shop feature flag (default OFF) and each gated by a
  review/confirm modal before anything is written:
  - **Pre-fill DVI** (flag `dvi_prefill`): matches the DVI's inspection items
    to VHI maintenance data and sets each item's status (red / yellow / green)
    and notes. You review and edit every proposed change before applying.
  - **Enhance Notes** (flag `enhance_notes`): AI-rewrites the technician notes
    already on the sheet. Original vs. enhanced text is shown side by side in a
    review modal; only the notes you approve are written back.
  - **Add Recommendations** (flag `dvi_prefill`): turns VHI recommendations
    into AutoFlow RVH "concerns" on the RO after you confirm the list.
  Writes happen in the page over AutoFlow's own same-origin request channel
  (`/Admin/dvi_v3/request.php` / RVH) using the logged-in session — reusing
  AutoFlow's own jQuery request helpers via a MAIN-world bridge so payloads and
  auth always match the AutoFlow UI. The background worker only fetches the VHI
  analysis from MOS; it performs no provider write. Toasts report
  added / failed counts. Buttons only appear on DVI views and stay hidden when
  the shop's flags are off.

## 1.27.20 — 2026-06-05

### Added
- **VHI Coach overlay now runs on AutoFlow (read-only).** The on-page
  Vehicle Health Indicator coach — previously Tekmetric-only — now appears
  on AutoFlow / autotext.me DVI and ticket pages. It surfaces the same
  vehicle-health insights (overdue / due-soon / OK service items and the
  health score) driven from the VIN, shop, and mileage the AutoFlow adapter
  already detects. Because AutoFlow is read-only for the extension, the
  coach is fed the standard maintenance-service catalog instead of a live
  inspection, so it shows the vehicle's full VHI plan. The overlay mounts,
  refreshes, and tears down on VIN/RO change through AutoFlow's SPA, honors
  the existing per-shop VHI Coach feature flag, and uses the same live
  Realtime push (with polling fallback) as Tekmetric. No write-back into
  AutoFlow is performed.

## 1.27.19 — 2026-06-02

### Performance
- **Vehicle Health Indicator now loads instantly on revisit.** The side
  panel previously re-fetched `/api/extension/plan` over the network every
  time you switched back to the Plan tab or re-opened a repair order, so
  even a server-cached report still showed a loading spinner each visit.
  The panel now keeps an in-memory plan cache (per shop + RO, 5-minute
  TTL): a previously-viewed RO paints immediately from cache, then quietly
  refreshes in the background. The refresh button still forces a fresh
  pull.

### Fixed
- **No more "snap-back" off the tab you're on.** When the shop management
  system re-sent the *same* repair-order context (a common, harmless
  re-fire), the panel force-switched you to the first RO-independent tab,
  yanking you off Plan/Jobs/etc. It now stays on your current tab unless
  there's genuinely no RO to show.
- **Late/stale plan responses can no longer paint the wrong vehicle.** If
  you switch to a different RO while a plan request is still in flight, the
  late response is now dropped instead of overwriting the current view and
  context.

## 1.27.18 — 2026-05-29

### Maintenance
- **Version bump to guarantee the Chrome Web Store build matches HEAD.**
  No functional code changes — the working tree was identical to the
  already-live 1.27.17 build. Brandon asked to bump and republish "just
  to be sure all new items are deployed," so this ships the current
  committed extension under a fresh version number (Google rejects
  re-uploading an identical version). Published to Google at Brandon's
  explicit "publish it" instruction.

## 1.27.17 — 2026-05-28

### Fixed
- **Floating button mascot no longer has white letterbox bands.** The
  FAB source icon (`icons/mos-fab.png`) was 127×110 (not square), so
  inside the 48×48 white FAB container with `object-fit: contain` it
  got letterboxed — leaving visible white space above and below the
  detective-dog artwork. Swapped in Brandon's square 100×100 mascot
  (mascot on a solid blue background) so the art fills the rounded
  button edge-to-edge with no banding, no distortion, and no awkward
  crop. No FAB CSS changes — the existing `width:100%; height:100%;
  object-fit: contain; overflow:hidden` rules already render a square
  source cleanly. Applies to Tekmetric and the Shop-Ware / AutoFlow /
  Protractor FABs that reuse the same icon path. **Not auto-published**
  — Brandon must say "publish it" before this ships to Google.

## 1.27.16 — 2026-05-28

### Added
- **Client-side telemetry reporter (task #511).** The extension now
  sends privacy-safe events to the new `/api/extension/telemetry`
  endpoint so platform admins can see how often soft session expiry,
  terminal token clears, API fetch failures, and user-action drops
  happen in the wild. Events are buffered in the background worker
  and flushed in small batches (≤50 events, ~3s debounce, capped at
  120 req/min/shop on the server) so a retry storm doesn't fan out
  to one HTTP call per event. Payloads carry only `code`, `status`,
  `attempt`, `retryBudgetRemaining`, `elapsedMs`, `action`, `reason`,
  `provider`, plus a sanitized endpoint shape (numeric IDs and query
  strings stripped) — no inspection text, no VINs, no tokens. The
  reporter never throws and never recurses into itself. Wired into:
  the 401 terminal/soft path and non-2xx branches in
  `handleMosApiRequest`; pre-fill DVI / enhance findings / build-RO
  failure handlers in `tekmetric-content.js`; sticker print failures
  on all three adapters; "add job" and "add finding" failures on
  Shop-Ware. Content scripts relay via a new `REPORT_TELEMETRY`
  background message since they don't have direct access to the API
  token. View at `/admin/extension-telemetry` (platform-admin only;
  link added to the Admin sidebar). 30-day TTL on the Mongo
  collection. **Not auto-published** — Brandon must say "publish it"
  before this ships to Google.

## 1.27.15 — 2026-05-28

### Fixed
- **Floating tab mascot now fills the button.** v1.27.14 swapped in
  the detective-bear artwork but the FAB's inner `<img>` was still
  hard-capped at 40×40 inside a 48×48 container with 2px padding, so
  the 127×110-aspect source rendered at ~40×34 — visibly dwarfed by
  the surrounding white card, especially against Tekmetric's bold
  refer-and-earn promo art. Now the img is `width:100%; height:100%`
  with `object-fit: contain`, container padding is 0, and the new
  `overflow:hidden` keeps everything inside the rounded corner. Same
  rule applied to the Shop-Ware FAB (which was also stretching the
  source because it lacked `object-fit`).

## 1.27.14 — 2026-05-28

### Changed
- **Floating tab now shows the Detect Dog mascot.** Replaced the
  generic MOS logo on the draggable side-rail launcher (Tekmetric +
  Shop-Ware) with the detective-bear-with-magnifying-glass artwork
  Brandon supplied so the FAB matches the rest of the Detect Dog
  brand. No code changes — `icons/mos-fab.png` was swapped; the
  48×48 rounded-white-square container and 40×40 `object-fit:contain`
  render rules are unchanged so the new artwork sizes correctly.

## 1.27.13 — 2026-05-28

### Fixed
- **Specs tab now disambiguates multi-variant VIN squishes.**
  Pierce reported the Specs tab showing "No specifications found for
  this vehicle" on a 2020 INFINITI Q50 (VIN JN1EV7AR3LM253178) even
  though the rest of the panel correctly displayed year/make/model and
  the engine description. Root cause: that VIN's DataOne squish
  (`JN1EV7AR_L`) matches multiple variants (Pure 3.0L V6 Twin-Turbo vs
  Red Sport 400 with the higher-output VR30, plus AWD vs RWD), so the
  decoder refuses to attach trim-specific specs to an arbitrary
  variant and returns "VIN matches multiple vehicle variants — pass
  trim or transmission to disambiguate". The `/api/extension/specs`
  route has accepted `?engine=`, `?trim=`, `?subModel=`,
  `?transmission=`, `?transmissionType=` hints all along, but the
  Specs tab was only sending `?vin=`. The Failures and Job Lookup
  tabs were already forwarding the engine description from
  `currentContext.vehicle`, so this brings Specs in line with them.
  The fix forwards every disambiguation field that's actually
  populated in `currentContext.vehicle` (today engine is the one that
  always lands; the others are passed only if a future SMS adapter
  surfaces them, so this is forward-compatible). Failed responses are
  not cached, so anyone who hit the empty state before will get a
  fresh call as soon as they reopen the tab on v1.27.13.

## 1.27.12 — 2026-05-27

### Fixed
- **Stop logging users out on a single transient 401 (Task #502).**
  The extension previously destroyed the saved login token the first
  time any MOS API call came back 401 (after one silent re-auth
  attempt). A single upstream blip, a brief network hiccup, or a
  routine identity-store miss was enough to kick the user back to the
  "Please sign in again" screen mid-shift — exactly the symptom Mason
  reported, where closing Chrome, reinstalling the extension, and
  re-syncing didn't stop the logouts. The background worker now
  retries 401s with exponential backoff (500ms / 1.5s / 4s + jitter)
  before attempting a silent re-auth, and only clears the token when
  the server explicitly says the token itself is invalid
  (`TOKEN_INVALID`). Expired tokens, shop-scope mismatches, lookup
  failures, and 503s all leave the saved token in place so the user
  isn't bounced for recoverable conditions. Pairs with a server-side
  change that tags every 401 with a stable error code and adds a
  Postgres-miss → MongoDB fallback for the identity lookup so drift
  between the two stores stops manifesting as customer-visible
  logouts.

## 1.27.11 — 2026-05-27

### Fixed
- **Specs tab now honors the shop's kilometers preference (Task #491).**
  For shops set to kilometers, the Detect Dog Specs tab previously
  rendered every dimension, wheel diameter, brake diameter, cargo
  volume and passenger volume with hardcoded imperial labels (`"`,
  `cu ft`). The server now reads `shop.preferences.distanceUnit` (with
  legacy `settings.distanceUnit` fallback) on `/api/extension/specs`
  and sends `unitDisplay: "imperial" | "metric"` back to the
  extension; the renderer formats every value from that field so a
  metric shop sees `cm` and `L` everywhere instead of `"` / `cu ft`.
  Fuel tank (`gal/L`) and weights (`lbs/kg`) — which were already
  dual — now also respect the same preference. Matches the dashboard
  Specs tab toggle from task #331.
- **Oil sticker now defaults to the shop's main km toggle (Task
  #491).** Previously the sticker had its own `useKilometers` boolean
  that started life as `false` even after a shop flipped the main
  distance preference to kilometers, so a Canadian shop's stickers
  would still print in miles until someone hunted down the second
  toggle in Settings → Stickers. The extension sticker config now
  falls back to `shop.preferences.distanceUnit === "kilometers"` when
  `stickerConfig.useKilometers` is unset. An explicit sticker-config
  value (`true` or `false`) still wins so shops that intentionally
  diverge keep working unchanged.
- **Specs tab is more resilient to DataOne hiccups (Task #491).** The
  `/api/extension/specs` route now wraps both DataOne calls
  (`getVehicleSpecsLocal` + `decodeVinLocal`) in an 8s per-call
  timeout, retries the pair once after a short backoff if the first
  attempt fails, and logs `vin`, `hasHint`, elapsed ms, and which
  call (specs / decode / both) hit the error so the next sporadic
  failure is debuggable from Better Stack. The user-facing error
  message also now surfaces the real reason instead of a stringified
  Error object.

## 1.27.10 — 2026-05-26

### Improved
- **VHI overlay now updates live when service history changes (Task
  #484).** The Detect Dog overlay subscribes to a per-shop, per-VIN
  Supabase Realtime channel while it's open and re-fetches within a
  second whenever the server invalidates the plan cache, a Tekmetric
  webhook fires (RO posted/invoiced or DVI complete), or the full-page
  backfill lands a job change for that VIN. Previously a tech had to
  reload or navigate away and back to see fresh recommendations after a
  service was added or a DVI was completed in another tab. If the
  realtime push is unavailable (feature flag off, missing config, or
  the WebSocket can't connect), the overlay silently falls back to the
  existing polling cadence — no visible change for the tech. The
  subscription closes automatically on VIN change or overlay dismiss.

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
