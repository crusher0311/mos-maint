---
name: Plan-pregen storm after cycle-speed fix
description: Speeding up a slow cron can unleash a fan-out hidden at its tail; pregenerate is now hourly + staggered
---

The tekmetric-incremental-sync route ends each cycle by firing plan-pregenerate (cache warm: dataone/carfax/protractor) for EVERY Tekmetric shop × 50 VINs as fire-and-forget self-POSTs on the web process.

**Why:** 2026-08-14 fleet-wide slowness (features p50 9-14s, print button 30s+, admin pages >1min): the 90s cycle-deadline fix made cycles complete every ~2min, so the tail fan-out (177 shops, sometimes double via overlapping runs) fired every few minutes and starved the web event loop. Mongo showed no long ops — the web process itself was the bottleneck. Fullpage morning-tail quiet-window chunks stacked on top (per-shop quiet windows like 20:00-10:00 local ALLOW inline web backfill at 7-9am local).

**How to apply:**
- When making a slow loop/cron fast, audit what its completion triggers — completion-triggered work sized for "rare" becomes a storm at the new cadence.
- Guards now in the route: `TEKMETRIC_PLAN_PREGEN_INTERVAL_MS` (default 60min), in-process in-flight flag, `TEKMETRIC_PLAN_PREGEN_STAGGER_MS` (default 3s between shop POSTs).
- Uniform all-route slowness + clean Mongo currentOp = event-loop starvation on web; check Render live logs (log-sync feed lags 10-15min).
- TEKMETRIC_BACKFILL_PAUSE_UNTIL pauses only fullpage + weekday-boost crons, NOT incremental sync or its pregenerate tail.

**2026-08-17 recurrence:** pregen fix held; slowness was fullpage inline again after the pause expired. Permanent guard added: `inlineBusinessHoursBlock` (lib/inline-business-hours.ts) defers the Tekmetric fullpage INLINE web lane Mon–Fri 12:00–23:00 UTC (env-tunable, kill switch FULLPAGE_INLINE_BUSINESS_BLOCK_DISABLED); queue lane + night/weekend ticks unaffected; deferred shops still count in shopsRemaining.
