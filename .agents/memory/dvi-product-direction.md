---
name: DVI product direction & write paths
description: MOS Auto DVI is a native DVI replacement; where inspections can(not) be written per provider
---
MOS Auto DVI is positioned as a REPLACEMENT for third-party DVI providers (AutoFlow/AutoVitals/AS1), not an integrator with them — the inspection lives natively in MOS (checklist, G/Y/R ratings, notes/recommendations, GridFS media) and reaches CARFAX via the $0 "Inspected: …" WO package.

**Why:** owner's stated direction (July 2026) — declined AutoFlow sheet write-back for Auto DVI.

**How to apply:**
- Protractor DOES have a native inspection write: POST `/WorkOrder/{id}/Inspection` (docs §1.9.4 InspectionResultUpdate) — only packages with Chapter "Inspection" processed, only header + `ServicePackageInspectionLines.ItemCollection` lines `{ID, Rank, Title, Result, Notes}` (item name goes in Title, NOT Description; live-probed 2026-07-31). Result values: Good / Needs Attention / Immediate. Re-posting the same package/line IDs updates in place (whole line set replaced). WO service packages can NEVER be deleted via API — pushes must find+reuse an existing MOS package or they stack duplicates forever. `/WorkOrder/Inspections` is the read side.
- AutoFlow CAN be written via the extension (`update_sheet` status+notes on existing sheet items, `add_rvh` recommendations; no new items, no photos) — that path stays reserved for the separate dvi_prefill feature.
- Yellow/red ratings go on line titles as bracketed tags ("Inspected: Battery [Red]"); notes/recommendations in the package note. Tags are verb-free so titles stay inspect-only for anchoring.
- Recommended-work push (overdue/due-soon → priced packages, history-hours + cachedLaborRate) is built but parked behind an off-by-default dashboard toggle pending review.

## Protractor native inspection grid (O/R/S) — live-probed
- Inspection Result values are SHOP-CONFIGURED (Shop Manager > Setup > Work Order Setup > Inspection Results); the API accepts any string but the grid only checks a box when Result exactly matches a configured label. Shop 66: O="OK", R="Requires Future Attention", S="Required". Other shops may differ — mapping may need per-shop config later.
- Inspection lines MUST carry `Type: "Line"` (like native template lines) or the grid renders a broken all-three tri-state and reverts user clicks on save.
- The `/WorkOrder/{id}/Inspection` POST merges lines by ID (does NOT replace). To delete a line: post it with blank Title/Result/Notes AND `Header.DeletionTime` + `DeletionTimeSpecified:true`. Blank-title without the deletion stamp leaves a permanent empty row.
