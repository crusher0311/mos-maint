---
name: Declined work in VHI
description: Design decisions for folding provider declined/deferred jobs into the VHI plan and the add-all-to-RO flow.
---

- Declined jobs merge in the plan-build triage pass: matched VHI items are forced overdue and carry a `declined` object ({serviceKey, serviceName, declinedAt, reason, origin, roNumber}); unmatched ones become their own overdue entries. Any plan-shape change like this MUST bump the plan-cache schema version so stale cached plans rebuild instead of misreading.
- **Why:** old cached plans (4h TTL) otherwise serve the old shape silently; consumers tolerate null declined fields but not a half-populated shape.
- The "add all declined to RO" endpoint deliberately does NOT write to Tekmetric. It lists declined jobs, resolves the target RO (explicit roId wins; else newest non-terminal cached RO by VIN), and dedups against jobs already on the RO. Actual writes go extension-side via CREATE_TEKMETRIC_JOB using the page session — same path as every other extension RO write.
- **How to apply:** any future provider (Protractor/Shop-Ware) extension gets the same split: server = read/resolve/dedup, extension = write. Set `declined.origin` per provider; UI gates (add-all button) key off origin.
- `declined.origin` gating matters: the extension shows the add-all button only for origin==='tekmetric' items, so mixing providers later won't offer writes a provider can't take.
