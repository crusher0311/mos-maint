---
name: showInspectItems / OE inspect-filter parity
description: The "show inspect items" toggle and the OE inspect-row filter live in multiple surfaces that must stay in parity; lifetime fluids must never be silently hidden.
---

# OE "Inspect" filter parity across surfaces

The "show inspect items" shop preference and the filter that hides OE
"Inspect …" maintenance rows are implemented independently in several places.
They must stay in parity or the extension and dashboard disagree about what a
customer's plan shows.

**Canonical preference source:** `preferences.showInspectItems`, default
**true** (`!== false`). The settings UI persists ONLY to that field. Any code
that reads `settings.planPage.showInspectItems` (especially with a `?? false`
default) is wrong — it silently hides inspect rows regardless of the shop's
actual setting. Keep the legacy field as a last-resort fallback only.

**Lifetime-fluid protection (must hold on every surface):** even when the
toggle is OFF, never drop an OE inspect row whose canonical key is in
`LIFETIME_FLUID_SERVICE_KEYS` (diff, trans, transfer case, coolant, brake,
power steering, etc.) when that key has NO non-inspect ("Replace/Flush/Service")
counterpart in the same vehicle's schedule. For these fluids the "Inspect …"
row is often the ONLY OE signal — DataOne writes ~40% of diff/trans rows as
Inspect with no Replace row.

**Why:** the dashboard plan path protects these via triage's `inspectOnly`
exemption; the extension plan route (`app/api/extension/plan/route.ts`) has its
OWN name-string inspect filter and originally had no such protection, so the
in-store side panel dropped diff/trans that the dashboard kept.

**How to apply:** the extension route has a protected-fluid exemption in the
OEM loop (precomputes a replacement-key set, keeps inspect-only fluids) and at
the cached-plan filter sites (key-membership exemption). If you touch any
inspect filter, apply the same exemption on all paths, and keep the OE verb
mapping in `lib/service-keys.ts` (canonical) and the extension's local
`SERVICE_KEY_PATTERNS` regex map in sync (e.g. PTU → transfer_case lives in
both).
