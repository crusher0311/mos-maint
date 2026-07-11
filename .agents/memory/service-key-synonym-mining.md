---
name: Service-key synonym mining data source
description: Where to find real unmatched service-name data when expanding SERVICE_KEYS synonyms.
---

The `[interval-import]` unmatched-name log stream can be empty (the import feature has little/no real usage), so it cannot ground synonym expansion.

**How to apply:** Mine `[PlanBuild] ... unmatched job names:` lines from the Supabase `production_logs` table (30-day retention; the Better Stack hot table only holds ~1 hour). These are real shop job phrasings run through the same matcher (`toKeyFromName`), so synonyms grounded there transfer directly.

**Why:** Tried the interval-import log first and found zero rows across a full 30-day window; PlanBuild misses yielded ~10k distinct real names.

Safety pattern that held up: bare one-word lines ("battery", "coolant", "rotation") must be exact-equality post-loop fallbacks, never substrings — substring versions falsely catch "Key Fob Battery", "Check Battery", "Coolant Leak". Keep exact-match branches mirrored in BOTH `toKeyFromName` and `toKeyFromFreeText`.

Known residual gap: CARFAX parenthesized plurals ("Tire(s) replaced") don't match `\btires?\s+` regexes in IMPLIES_RESET (follow-up proposed).
