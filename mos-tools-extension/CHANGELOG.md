# Detect Dog by MOS Tools — Changelog

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
