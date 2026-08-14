---
name: VHI duplicate "declined" twins are OEM retitle twins
description: Why the sidepanel showed each service twice, and how the merge/dedup now works
---

Symptom "duplicate declined items" (e.g. "Coolant Service" next to "Replace engine coolant.") is usually NOT a declined-vs-OEM mismatch — both rows are `source:"oem"` with the SAME serviceKey. The shop-interval override retitles the OEM Inspect row to the canonical display name while the OEM Replace row survives, and the old dedup compared display titles only.

**Why:** key mappers (`toKeyFromName`/`toKeyFromFreeText`) already agreed on all the reported pairs; verified against prod data (cached_plans + deferred-work rows).

**How it's fixed / how to apply:** shared pure module `lib/plan-build/declined-merge.ts` (no server-only, tsx-testable) used identically by triage and the extension on-demand route:
- `groupDeclinedJobs` — repeat declines aggregate (`declinedCount`, latest row = provenance) instead of title-dedup dropping them.
- guarded title-containment secondary match (verb-strip, ≥6 chars/≥2 words, word-boundary) for genuine mapper misses; inspect rows exempt.
- `collapseDuplicateServiceItems` — same-canonical-key collapse: drops declined standalones into the plan item and OEM+OEM non-inspect twins; never collapses inspect rows or synthetic keys (misc_/dvi_/tek_declined_). `foldDeclinedProvenance` is identity-aware (same entry object attached to several twins must not double-count).
- On-demand recs carry `source:"oe"/"shop"` (not "oem") and no `action` field — adapters must normalize source and sniff inspect via `/^(inspect|check)\b/` on the title.
- Any change here needs BOTH cache bumps: `PLAN_CACHE_SCHEMA_VERSION` (lib/plan-cache.ts) and `ANALYSIS_CACHE_SCHEMA_VERSION` (extension plan route), plus an extension manifest version bump if sidepanel.js changed.
