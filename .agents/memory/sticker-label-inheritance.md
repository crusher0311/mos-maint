---
name: Sticker label inheritance
description: Why saved legacy label text is preserved rather than migrated.
---
New sticker layouts should inherit the global Service Label, with “Next Oil Service” as the intended default wording. Do not automatically clear saved “Next Service Due” element overrides.

**Why:** A saved old default is indistinguishable from a shop intentionally choosing that exact wording. Preserving shop customization is safer than guessing intent.

**How to apply:** Change fresh-layout defaults without rewriting persisted element content. Any future migration of legacy overrides needs an explicit user choice.

Designer text overflow should follow the established printer behavior (single-line horizontal compression), not introduce ellipsis or new wrapping.

**Why:** Shops rely on complete service values being printed; richer formatting is not authorization to truncate values or change physical label dimensions.

**How to apply:** Keep preview and export measurements aligned when adding text decorations, and leave the legacy non-designer layout unchanged.

Do not equate browser CSS color support with node-canvas support.

**Why:** The installed node-canvas silently ignores HWB colors even though browsers accept them. Named colors, hex, RGB and HSL are compatible.

**How to apply:** Verify any new color syntax with actual server pixels before allowing it in saved sticker layouts.

Customer-name sticker defaults must not reuse VIN-based plan or booking enrichment.

**Why:** Those reads can select a different work order for the same vehicle. Their customer identity is not proof of the customer on the current visit.

**How to apply:** Use the current work order's supplied display name, or separately prove an enrichment belongs to that same order and location. Missing identity falls back to saved shop wording.

Sidebar print navigation must bind both the browser window and originating tab, including startup recovery and acknowledgments.

**Why:** Runtime broadcasts reach panels in other windows, and a service worker's “current window” can be the last-focused window rather than the panel requesting context.

**How to apply:** Resolve the owning window inside the panel document, reject navigation for other tabs/windows, and test two simultaneously open panels.
