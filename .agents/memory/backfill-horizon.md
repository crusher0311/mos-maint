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

**Operational caveat (don't over-sell shrink as a catch-up lever):** shrinking
only completes shops whose cursor has *already* passed the new, shorter horizon.
When the real backlog is shops still early in their pull (cursor within the last
year), shrinking 2y→1y barely moves the "caught up" count — those shops haven't
reached even the 1y mark yet, so they stay incomplete. Measured once: 2y horizon
gave ~37/77 effectively done; 1y only added +3 (40/77). The dominant blocker in
that case was raw throughput (single shared Tekmetric key ~5 RPS), not horizon.

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
