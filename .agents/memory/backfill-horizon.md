---
name: Backfill horizon (configurable, default 2y)
description: How the shared backfill horizon and its horizon-raise reopen sweep work across all three providers.
---

# Configurable backfill horizon

All three provider backfills (Tekmetric, Protractor, Shop-Ware) walk history
reverse-chronological back to a single shared horizon resolved by
`getBackfillYears()` in `lib/integrations/backfill-pace.ts`
(env `BACKFILL_HORIZON_YEARS`, default `DEFAULT_BACKFILL_YEARS = 2`). It used to
be a hard-coded `YEARS_TO_BACKFILL = 5` duplicated in each provider.

## Shrinking the horizon
Handled for free by each provider's existing `chunkEnd/cursor <= oldestDate`
completion check: a shop whose parked cursor is already older than the new
(shorter) oldestDate flips to complete cleanly on its next tick — no re-walk,
no crash. No extra code needed.

**PROD NOW RUNS 2y** (confirmed 2026-07-12 via Render API: `BACKFILL_HORIZON_YEARS=2`
on both `mos-tools` and `backfill-drain-worker`). It was 5 earlier (confirmed
2026-06-07) and was shrunk to 2 sometime between; shops completed under the 5y era
have cursors parked at ~2021 dates, newer completions park at ~2y. The horizon is
one shared env var — NOT per provider and NOT per shop.

**Shrink IS the biggest catch-up lever when the horizon is large.** A previous
"2y→1y only +3 shops" measurement assumed a 2y baseline; under the real 5y horizon
the picture is opposite. Shrinking 5y→2y/3y is a free, instant, reversible env flip
that (a) immediately flips every shop whose parked cursor already passed the new
oldestDate, and (b) cuts remaining work for all others by years. Example measured
2026-06-07: Protractor at 5y = 7/29 complete; dropping to 2y (oldest≈2024-06-07)
would instantly complete ~5 more (shops whose cursorEnd is already ≤2024-06). It's
a **product decision** (how much history to keep) → ask Brandon before changing.
Caveat still holds: shrink only helps shops whose cursor already passed the *new*
horizon; shops still pulling recent months aren't flipped, only shortened.

## Raising the horizon → resume deeper history
`reopenCompletedShopsForHorizon()` runs at the top of each provider's selection
entry (Tekmetric `getShopsNeedingBackfill`, Protractor
`findAndResumeStaleBackfills`, Shop-Ware GET before the per-shop loop). It clears
the completion flags (`completed`/`complete` on the progress doc + the shop-doc
flag where one exists) so the shop re-enters selection and resumes from its
parked `currentChunkEnd`.

**Why the guard is `currentChunkEnd > oldestDate` (not a stored "last horizon"):**
`oldestDate` advances forward with wall time, and a completed shop's parked
cursor is always `<=` the oldestDate at its completion `<=` today's oldestDate.
So steady-state and *shrunk* horizons never satisfy `currentChunkEnd > oldestDate`
— the sweep is a pure no-op until the horizon is actually *raised*. This avoids
needing to persist/compare a previous horizon value.

**How to apply:** the sweep is constrained to linked/configured/eligible shops
(`eligibleShopIds`) so orphaned/unlinked progress rows aren't reopened-then-
re-completed every tick (Tekmetric's orphan sweep would otherwise loop). It
stamps `reopenedForHorizonAt` + `resolvedBackfillHorizonYears` for audit. If you
add a fourth provider, call the same helper before its completion-filtered
selection.

The active horizon is exposed at `GET /api/cron/catchup-status`
(`backfillHorizonYears`) and in each provider's per-shop chunk log line
(`horizon=<n>y`).
