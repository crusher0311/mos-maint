---
name: Testing feature gates in dev
description: How to see locked vs unlocked entitlement states in dev without touching prod flags
---

Dev auto-login reads `DEV_SHOP_ID` from process.env at request time (lib/auth.ts), so flipping the development env var + workflow restart switches the whole session to another shop — no prod writes needed.

**Why:** feature entitlements live in prod Mongo (dev == prod cluster) and flag flips are operator-gated, so you can't enable a feature for the default dev shop just to test the UI.

**How to apply:** to see the *unlocked* state of a gated page, point `DEV_SHOP_ID` at a `detect_dog_founder`-plan shop (founder plan is a wildcard — ALL current and future feature keys enabled, lib/plan-feature-tiers.ts). Shop 57 (Kennedy Auto Solutions) is one with a Tekmetric integration. Revert the env var afterwards. Note: as of 2026-07, no shop has per-shop feature overrides; entitlements come almost entirely from plan tier.
