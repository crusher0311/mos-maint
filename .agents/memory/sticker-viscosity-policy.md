---
name: Sticker viscosity evidence boundary
description: Display-only oil viscosity uses current RO evidence, never vehicle specifications, history or interval defaults.
---

Oil viscosity is optional print-only information. Automatic values require unambiguous engine-oil evidence from the current RO already available to the print flow; insufficient provider evidence means manual entry, not another lookup.

**Why:** The user explicitly excluded recommended-oil lookup, provider write-back, historical inference and persistent defaults. Viscosity must never change service intervals or be silently added to existing layouts.

**How to apply:** Keep manual overrides, including clearing, scoped to one shop/RO visit. Never use an interval-category label as viscosity. Additional passive provider evidence adapters must preserve this boundary.
