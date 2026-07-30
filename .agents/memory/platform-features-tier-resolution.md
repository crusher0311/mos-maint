---
name: platform_features tier resolution gaps
description: How plan features resolve from PG platform_features and the demo/missing-row pitfalls
---
Plan feature entitlements resolve from PG `platform_features` (`includedInTiers` per row), NOT from `PLAN_FALLBACK_KEYS`, whenever the table has rows.

**Pitfalls (both hit July 2026 with estimate_assist):**
- No row lists a literal `demo` tier → demo shops resolved to ZERO features. Fix: `demo` (like `professional`) maps to the `elite` tier slug in `getPlanFeaturesFromDatabase`.
- A feature that ships in code without a seeded `platform_features` row is OFF for every plan (even the tiers the static map grants it to). Fix: keys absent from the table fall back to `PLAN_FALLBACK_KEYS` membership.
- Rows with non-`active` status count as "seen" (intentional admin disable) — the missing-row fallback must never re-enable them.

**How to apply:** when a new feature key ships, either seed a `platform_features` row with the right tiers or rely on the static-map fallback; when debugging "feature X missing for shop Y", check `billing.plan` + whether the table has a row for the slug and whether the plan's tier slug appears in `includedInTiers`. `trial`/`oil_sticker_legacy` still depend on rows literally listing those tier slugs.
