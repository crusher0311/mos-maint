# Detect Dog — Enterprise Tire DVI Demo

Isolated frontend presentation at `/tire-dvi/`. Nothing imports the production app or the existing Shop Workflow artifact. Start **only this artifact's Vite workflow**, never the root production app. The managed preview workflow serves port 26170.

## Visual direction

**Industrial inspection ledger / fieldwork precision.** Tokens copied, not imported, from Detect Dog Shop Workflow: sage paper `#f1f2e9`, pine `#285746`, mineral mint `#dcebdd`, burnt orange `#d66a35`. System Aptos/Segoe UI text, local Consolas/SFMono measurements. A wheel-specific editor and documentation ledger are the central spatial motifs. Quiet opacity/translate feedback; reduced-motion support. Responsive single-column phone view and 44px primary controls. No external fonts, images, AI, auth, APIs or browser persistence.

## Five-minute walkthrough

1. **0:00 — Context and tires.** Show fictional Rowan Hale, 2019 Meridian S4 and RO #2086. Switch all four wheel positions; fronts and rears have different actual sizes. Enter I/C/O in explicit `/32 in` or mm. Before and after PSI are independent; blank after is shown as not recorded.
2. **1:00 — Green documentation.** Open **Sample AI findings**, read the fictional values, and **Confirm fictional findings**. This populates all required checks green without claiming to analyze media. After-pressure stays blank. Existing actual sizes and local evidence stay unchanged. Optional: attach your own local image/video.
3. **2:00 — Validation.** Clear a required rating and attempt **Complete inspection**. The error list identifies every missing field. Restore the rating and complete. Battery matching rated/measured CCA and manual pass are retained. No percentage inference is used.
4. **3:00 — Advisor.** Show all four tires, battery and two fixed safety checks in the $0 package. Enable rear-tire recommendation, edit its parts quantity, unit price, labor hours or rate; totals update. **Any edit invalidates completion and review:** return to Technician and complete again, then **Confirm advisor review**.
5. **4:00 — Customer and simulated handoff.** Open reviewed report: identical findings, measurements, notes and evidence. Optional work is proposed, never authorized or performed. Return to Advisor; **Simulate Protractor handoff** explicitly records only a local demonstration. Reset with confirmation.

The header also provides this walkthrough inside the app.

## Working interactions vs simulations

**Working:** shared in-memory technician/advisor/customer state; wheel-specific actual and optional OE sizes; manual tread units and I/C/O; independent pressure; explicit ratings; battery values, matching standards, pass/fail/not-tested/unable states, optional voltage/terminals; mandatory validation; always-document green results; fixed safety checks; grouped optional library; optional brake-pad mm; local image/video object URL previews and removal; editable fictional recommendations; cent-based totals; review invalidation; report preview; reset; accessible dialogs.

**Simulations:** sample AI is a static, explicitly confirmed fictional preset; it does not analyze uploaded files or run AI. Handoff is a local state transition; no real Protractor ticket is created. Fictional prices exclude taxes and shop fees. No repair is claimed to have been performed or authorized.

No network application requests (`fetch`, XHR, WebSocket clients), production modules, stores, auth, scanner controls/SDKs, AI, uploads, public links, communications, customer approvals, offline sync or persistence. Vite development assets/HMR are normal local development traffic, not integration traffic.

All uploaded files stay in memory as local object URLs. PNG/JPEG/WebP images and MP4/WebM videos up to 30MB each; battery printouts are image-only. Object URLs are revoked on removal/reset/unmount. Refresh discards state. Do not use real customer data or sensitive media.

## Completion and review rules

- Each tire must have an actual size, valid I/C/O readings, before PSI and an explicit green/yellow/red rating. OE reference and after PSI are optional. A blank after is never copied from before or described as an adjustment.
- Tread 0–32 `/32 in` or 0–25 mm; pressure 1–120 PSI. Unit selection clears tread values rather than converting numbers: the technician must re-enter readings.
- Battery defaults to CCA. Manual pass/fail requires rated and measured values 1–3000 with matching standard. No percentage is calculated. Not-tested blocks completion. Unable-to-test with an explanation permits documentation completion but is explicitly **not a completed battery test** in both previews.
- Two fixed demo safety checks require green/yellow/red. These are fictional demonstration policy, not claims of enterprise approval. Tires, battery and safety documentation cannot be deselected.
- Optional checks distinguish not-applicable and not-inspected from green. Optional brake thickness is 0–30 mm. Optional uninspected items stay explicitly identified, not counted as completed checks.
- Every finding, media, library selection or pricing edit clears completion, advisor review and simulated-handoff status. Recomplete in Technician, then rereview in Advisor. Navigation remains available to show explicitly labeled drafts; final report and handoff buttons are gated.
- Inspection lines are derived by stable item IDs on each render, never appended on edits. Required green lines always remain. Recommendations are separate optional estimates.
- Parts quantity is a whole number 0–100; hours 0–100; unit price and hourly rate 0–10000. Currency uses cent rounding. Invalid selected packages block review.

## Pure model / tests

`src/model.ts` has no React, DOM, storage or network dependencies.

Exports:
- Types `Rating`, `TreadUnit`, `BatteryResult`, `Standard`, `Media`, `WheelId`, `Wheel`, `Check`, `Battery`, `Recommendation`, `DemoState`, `InspectionLine`, `DemoAction`, `ActionResult`.
- Constants `WHEEL_NAMES`, `RATING_LABELS`, `LIBRARY`.
- `createDemoState()` returns independent fictional seed data.
- `applyAction(state, action)` returns `{ok, state, message}`, does not mutate the input.
- Actions `wheel`, `battery`, `check`, `toggle-check`, `recommendation`, `complete`, `review`, `handoff`, `reset`, `sample-green`.
- `getCompletionErrors`, `getPricingErrors`, `composeInspectionLines`, `recommendationTotal`, `ticketTotal`, `isCompleted`, `isReviewed`.

From this artifact directory: `npm run typecheck`, `npm test`, `PORT=26170 BASE_PATH=/tire-dvi/ npm run build`, and (with its workflow running) `DEMO_CHROMIUM_PATH=$(command -v chromium) npm run test:browser`. Use `DEMO_TEST_URL` to override the browser test URL. The isolated Vite defaults to port 24088 outside the managed workflow; managed preview uses 26170.

Suggested validation: initial required failures; confirmed green fixture yields seven mandatory lines and $0; unable battery with/without explanation; mismatched standards; blank after remains blank; different actual sizes retained; mm limits; optional N/A distinct from green; two rear tires 2 × $187.45 + .8 × $119.50 = **$470.50**; one alignment 1.1 × $119.50 = **$131.45**; edit clears review; repeated compose has no duplicate IDs; reset clears evidence and returns seed; desktop/390px keyboard navigation; native dialog Escape and focus restoration; zero integration requests.

## Stable accessible selectors

`nav-technician`, `nav-advisor`, `nav-customer`, `technician-view`, `advisor-view`, `customer-view`, `wheel-editor-LF` etc., `line-wheel-LF` etc., `line-battery`, `sample-findings`, `confirm-sample`, `complete-inspection`, `completion-errors`, `review-ticket`, `open-reviewed-report`, `simulate-handoff`, `handoff-result`, `ticket-total`, `recommendation-tires`, `recommendation-alignment`, `recommendation-battery`, `walkthrough`, `reset-demo`, `confirm-reset`, `toast`.

Accessible names include `Select Left front tire` (and other wheels), `Left front actual tire size`, `Left front inner tread (/32 in)`, `Left front before pressure (PSI)`, `Left front after pressure (PSI, optional)`, `Battery rated cranking value`, `Battery measured cranking value`, `Battery rated standard / unit`, `Battery measured standard / unit`, `Battery technician-entered result`. Rating buttons include the item name and textual status. All evidence inputs and price fields have stable item-prefixed labels.

## Verification disclosure

Verified isolated typecheck, production bundle, pure model tests and Chromium presentation flow. Browser coverage includes required validation, green-only documentation, local image evidence, independent pressure, matching battery standards, not-tested gating, recommendation math, review invalidation, simulated handoff, reset and all three views at 390px without horizontal overflow. Desktop and mobile screenshots were examined. Request capture allows only same-origin GET assets and local blob/data media; zero production/API or external requests were observed. Only this artifact workflow was started; the production application and existing workflow artifact stayed stopped. There is no signed-in UI.
