---
name: Protractor drops client-supplied part cost
description: Live-verified — Protractor Integration API ignores Cost/TotalCost on WO material line writes (REST and SOAP); readback always 0.
---

Protractor's Integration API does NOT persist client-supplied `Cost`/`TotalCost` on work-order material lines. Verified live against a real Protractor shop: all four MOS write paths (create-WO, dashboard add, extension add, batch add) sent Cost/TotalCost (as strings AND retried as numerics, via REST POST /WorkOrder/{guid} AND the SOAP WorkOrderUpdate fallback) — every readback shows `TotalCost: 0` and no `Cost` field at all in the GET schema.

**Why this matters:** the MOS-side part-cost pipeline (resolvePartLineCost, per-shop `partCostEstimateRatio`, `[PartCost]` source=real/estimated logging) works exactly as designed — logs and payloads are correct. The value is discarded upstream by Protractor, which appears to recompute line cost from inventory commitment / in-app entry only. Historical *invoices* DO carry `TotalCost > 0` (even on lines with no InventoryMaterialID), so the field is real — it's just not writable through the integration API on open WOs.

**Unresolved:** could not rule out that cost entered via API would surface after invoice finalization (finalizing an invoice on a live shop was too invasive to test). Also note the test shop's canned-job templates carry NO part cost (list cache and template-detail API both), so the "real cost" branch fires only when the pushed payload itself carries cost.

**How to apply:** don't debug MOS when a shop reports missing part cost/GP on MOS-pushed jobs — the `[PartCost]` log line proves what was sent; the loss is Protractor-side. Any fix needs a different mechanism (inventory-linked lines, vendor/parts workflow, or Protractor support guidance), not payload tweaks.
