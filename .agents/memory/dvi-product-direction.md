---
name: DVI product direction & write paths
description: MOS Auto DVI is a native DVI replacement; where inspections can(not) be written per provider
---
Keep check-in device-handoff details collapsed by default, but expose the explicit resume action when ownership blocks editing.

**Why:** The user requested a compact mobile form; hiding the required resume action then made the desktop concern field appear broken.

**How to apply:** Preserve ownership fencing and explicit takeover consent. Keep the reason and primary recovery action visible outside collapsed explanatory controls.

MOS Auto DVI is positioned as a REPLACEMENT for third-party DVI providers (AutoFlow/AutoVitals/AS1), not an integrator with them — the inspection lives natively in MOS (checklist, G/Y/R ratings, notes/recommendations, GridFS media) and reaches CARFAX via the $0 "Inspected: …" WO package.

## Historical findings and multiple sheets

Phone-photo compatibility must include higher-bit-depth HEIC, not just ordinary 8-bit samples.

**Why:** An older browser decoder passed an 8-bit HEIC but rejected the synthetic 12-bit sample; a current decoder passed both. MIME types can also be empty on camera uploads.

**How to apply:** Keep real encoded-image regression coverage when changing conversion libraries. Convert before assigning upload identities, preserve the server size limit, and never mark failed conversion as a saved photo.

Use the existing Create New RO workflow from both the dashboard and workflow
board, not a separate local check-in flow presented as RO creation. The user
wants confirmed RO creation to continue directly into DVI, with optional vehicle
photos captured during intake carried into that visit's DVI.

**Why:** The separate workflow intake omitted concern follow-up questions and
left users expecting a Protractor ticket when only a local visit existed.

**How to apply:** Share the guided customer/vehicle/concern experience across
entry points. Preserve intake photos through the confirmed RO-to-DVI handoff,
keep DVI feature-gated, and distinguish uncertain creation from confirmed ROs.

Check-in must support moving from desktop to phone and back before a native
customer, vehicle or RO exists. The user wants vehicle entry and VIN, odometer
and arrival photos in the same guided draft, without texting a link.

**Why:** Advisors need to begin at the desk, capture details beside the vehicle,
and finish at the desk without duplicate entry or duplicate native records.

**How to apply:** Use authenticated, shop-scoped server drafts and a QR resume
entry, clearly distinguish local unsynced photos from server-confirmed uploads,
and fence conflicting devices and unresolved native operations. Keep deployment
separate from local implementation approval.

Preserve existing VIN/license-plate photo interpretation during mobile handoff;
the user also requested OpenAI interpretation of odometer photos.

**Why:** Mobile check-in should extend existing photo-assisted vehicle entry,
not regress it to manual-only entry.

**How to apply:** Keep the source photo, require explicit confirmation of the
reading and units before changing mileage, and distinguish total odometer from
trip readings or unreadable displays.

The user confirmed DVI should be feature-gated as a product, including inspection
sheet creation and management, rather than automatically available with Shop Workflow.

**Why:** DVI must support building out configurable sheets while remaining an
independently controlled feature.

**How to apply:** Gate DVI entry points and sheet-management APIs by the target
shop's DVI entitlement, then apply staff/manager permissions separately. Workflow
access alone must not grant DVI or sheet-editing authority.

Sheet definitions used by inspections are immutable versions. Catalog edits and
archival must not change existing inspection evidence or enable provider sends.
Only matching measurement identities within the same visit may automatically
reuse findings; historical visits remain reference evidence.

**Why:** Managers need to improve sheets without rewriting what a technician
actually inspected, and sheet administration is not approval for live rollout.

**How to apply:** Preserve embedded definitions and separate catalog authority
from admissions, provider write permissions and enterprise-sharing policies.

The user wants prior DVI findings to return on subsequent visits and to be shared
across enterprise locations like vehicle history. They also want multiple DVI
sheets with overlapping items automatically reusing inspection work within the
same visit, including switching from an accidentally selected sheet or upgrading
from a basic inspection to a more detailed one.

**Why:** Technicians should not repeat work just because the wrong sheet was
started or a more comprehensive inspection becomes necessary.

**How to apply:** Treat these as product requirements, not authorization to enable
enterprise sharing or reinterpret historical findings as freshly inspected results.
The user selected production Auto DVI, using the tire demo as the starting
interface and workflow, and explicitly confirmed that it must retain everything
Auto DVI already offers. It must not become a reduced tire-only replacement.

**Why:** The user asked whether the tire-style DVI would still have all Auto DVI
capabilities. Vehicle-specific generation, custom items, voice/media assistance
and provider integrations are part of that requirement, not optional follow-ups.

**How to apply:** Never send a new visit's results through legacy VIN-only
results/push handlers. Preserve existing inspections while making each feature
visit-aware; keeping legacy controls visible is preservation, not completed
feature parity or a completed unified workflow.

**Why:** owner's stated direction (July 2026) — declined AutoFlow sheet write-back for Auto DVI.

**How to apply:**
- Protractor native inspection writes update/create by package and line ID; do not assume the entire line set is replaced. Result labels are shop-configured, not a universal Good / Needs Attention / Immediate mapping. Ordinary WO package removal is unsupported; keep stable package identity.

**Why:** Public Swagger checked 2026-10-18 explicitly describes ID-based inspection upserts; later historical grid observations below contradicted the earlier replacement/universal-label assumption.

**How to apply:** Verify each shop's displayed labels and treat tombstone behavior as a separately verified capability, never as general package-deletion support.
- AutoFlow CAN be written via the extension (`update_sheet` status+notes on existing sheet items, `add_rvh` recommendations; no new items, no photos) — that path stays reserved for the separate dvi_prefill feature.
- Yellow/red ratings go on line titles as bracketed tags ("Inspected: Battery [Red]"); notes/recommendations in the package note. Tags are verb-free so titles stay inspect-only for anchoring.
- Recommended-work push (overdue/due-soon → priced packages, history-hours + cachedLaborRate) is built but parked behind an off-by-default dashboard toggle pending review.

## Protractor native inspection grid (O/R/S) — live-probed
- Inspection Result values are SHOP-CONFIGURED (Shop Manager > Setup > Work Order Setup > Inspection Results); the API accepts any string but the grid only checks a box when Result exactly matches a configured label. Shop 66: O="OK", R="Requires Future Attention", S="Required". Other shops may differ — mapping may need per-shop config later.
- Inspection lines MUST carry `Type: "Line"` (like native template lines) or the grid renders a broken all-three tri-state and reverts user clicks on save.
- The `/WorkOrder/{id}/Inspection` POST merges lines by ID (does NOT replace). To delete a line: post it with blank Title/Result/Notes AND `Header.DeletionTime` + `DeletionTimeSpecified:true`. Blank-title without the deletion stamp leaves a permanent empty row.
