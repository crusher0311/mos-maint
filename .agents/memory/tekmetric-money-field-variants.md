---
name: Tekmetric money field name variants
description: Job money fields differ per endpoint — estimate uses partsPrice/laborPrice; readers must accept all variants or they silently see $0.
---

# Tekmetric job money fields vary by endpoint

- `/api/repair-order/{id}/estimate` job objects: `partsPrice`, `laborPrice`
  (cents), plus full `parts[]` (retail/total/quantity) and `labor[]`
  (hours/rate/total) arrays. NO `partsTotal`/`partsAmount`.
- `/api/shop/{id}/jobs?repairOrderId=` list shape: thin — `subtotal`,
  `totalCost` only, no per-bucket parts/labor split, no line arrays.
- Webhook-cache `data.jobs` historically read via `partsTotal || partsAmount`.

**Why:** the extension's Audit-RO live fetch read only
`partsTotal || partsAmount` → every estimate job audited as $0 parts →
false "Missing Replacement Parts" criticals + AI "no parts cost" findings
on fully-parted jobs (live-verified 2026-07-12).

**How to apply:** any mapper consuming Tekmetric job money must accept all
variants (`*Total`, `*Amount`, `*Price`); treat an explicit numeric 0 as
authoritative (package-priced jobs) and only sum `parts[]`/`labor[]` arrays
when no money field exists at all. All amounts are cents.

Related: the audit AI prompt must state all line items are same-RO/same-visit
and ban timing/sequencing findings, or it invents "do the alignment after the
suspension work" safety warnings.
