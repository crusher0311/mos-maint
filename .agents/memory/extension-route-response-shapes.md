---
name: Extension API route response shapes are inconsistent
description: Extension-authed routes do NOT share one response envelope; check each route before wiring the sidepanel client to it.
---

The `app/api/extension/**` routes return inconsistent success envelopes. Do NOT
assume a shared shape when wiring the extension client (`sidepanel.js`) to a new
route — read the route's `NextResponse.json(...)` first.

Known shapes (Protractor Create RO family):
- `vin-plate-ocr` → `{ success: true, result: { type, vin, plate, state, ... } }` (nested under `result`)
- `vin-decode` → top-level `{ vin, year, make, model, decoded }`
- `plate-lookup` → top-level `{ success, vin, year, make, model, ... }`
- `deferred-work` → `{ ok: true, items: [...] }`

**Why:** A redesign of the extension Create RO side panel read OCR output from
top-level `result.vin/plate/state`, but that route nests them under `result.result`,
so the camera-scan path silently no-op'd (no error, just nothing populated). The
other two vehicle routes return top-level fields, which masked the inconsistency.

**How to apply:** When the client reads a route response, unwrap defensively
(`const o = result?.result || result || {}`) AND verify against the actual route.
There is no smoke test covering the OCR client/route contract, so a shape change
on either side is silent.
