# Detect Dog by MOS Tools — Changelog

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
