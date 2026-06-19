---
name: Service-key OEM vs history mapping must agree
description: Why a performed service can falsely read "no record" in plan-build — two different mappers feed two sides that must resolve to the same key.
---

# OEM item key and shop-history key must resolve to the SAME serviceKey

Plan-build anchors a performed service to an OEM interval ONLY when both sides
map to the identical `serviceKey`. The two sides use DIFFERENT functions:

- OEM items (DataOne) → `toKeyFromName` (single key, in `lib/service-keys.ts`)
- Shop history / CARFAX rows → `toKeyFromFreeText` (multi-key)

If they disagree, the OEM item falls back to `misc_<maintenance_id>`, the
history anchor lands on the real key, `getEffectiveLast(misc_...)` finds
nothing, and the plan reports a paid-for service as "No record of this service
being performed" + overdue.

**Why:** DataOne phrases the auto-trans fluid service as
`"Replace automatic transmission / transaxle fluid."`. The `" / transaxle"`
insert splits the `"transmission ... fluid"` substring, and "transaxle" was
not a synonym anywhere — so `toKeyFromName` returned null → `misc_<id>`, while
the performed history row `"Automatic Transmission Fluid Service"` mapped to
`trans_auto`. Beware the red herrings that hide this: a Protractor RO# that
doesn't match (work-order# vs invoice#) looks like a data gap but isn't — the
record can be present in job_index with the correct VIN and not declined.

**How to apply:**
- When a performed service shows "no record", first dump the DataOne OEM item
  names for that VIN (`getMaintenanceScheduleCached`, name field is
  `maintenance_name`) and run BOTH `toKeyFromName` and `toKeyFromFreeText` on
  the OEM name AND the real RO title. A key mismatch (one → `misc_*`) is the
  usual culprit, not a missing backfill.
- Fix synonym gaps in BOTH directions: add specific synonyms to `SERVICE_KEYS`
  (auto vs manual variants kept separate so loop-order can't cross them), and
  add any guarded generic fallback to BOTH `toKeyFromName` and
  `toKeyFromFreeText` so OEM and history stay symmetric.
- Keep manual/auto disambiguation in the fallback (`includes("manual")`), and
  require a fluid/flush/service/exchange/drain verb so a bare unit R&R
  ("Replace transaxle") is NOT treated as a fluid anchor.
