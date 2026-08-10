---
name: Smart-timing conservative fallback window
description: How heavy Tekmetric backfill avoids failing open onto web during business hours for no-profile/low-confidence shops
---

The smart quiet-window gate (SMART_BACKFILL_TIMING) fails OPEN for shops without a confident activity profile (no_profile / low_confidence / no_quiet_window) — which is exactly a brand-new shop, whose initial catch-up is the heaviest work. Three Aug 2026 incidents: fullpage chunks inline on the web instance during business hours spiked p95 to 10-26s; mitigation was manual TEKMETRIC_BACKFILL_PAUSE_UNTIL flips.

**Rule:** heavy INLINE web-lane backfill (tekmetric fullpage cron Pass 2, and the date-window chunker's shopsToRun) applies `applyConservativeFallbackGate` on top of the standard gate: fallback shops only run inside a conservative default window — 01:00–06:00 shop-local (profile tz, else America/Chicago) — overridable via `SMART_BACKFILL_FALLBACK_WINDOW="start-end"`.

**How to apply:**
- Only ENFORCE mode skips; off = byte-for-byte old behavior; observe logs `[smart-timing-fallback]` would-BLOCK. Respects the SMART_BACKFILL_TIMING_SHOP_IDS canary allowlist.
- Confident-profile (established) shops are untouched — the overlay returns shouldSkip:false for non-fallback decisions.
- The BullMQ queue hand-off (Pass 1) and admin POST trigger are deliberately NOT gated: the worker lane doesn't touch web p95 (and workers auto-suspend weekday daytime anyway, so queued jobs naturally wait).
- Logic: `applyConservativeFallbackToDecision` in lib/integrations/activity-profile/profile.ts; wrapper in lib/data/repositories/activity-profiles.ts; covered by tests/activity-profile.smoke.ts.
