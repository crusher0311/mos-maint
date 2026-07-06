---
name: Job-search ACES tiers & ranking
description: How ACES ids feed job-search match %, why a live-decode dependency + heuristic-100 caused Great Match to outrank Exact Fit
---

# How ACES ids actually feed the job-search match %

`lib/job-scoring.ts` `scoreJob` uses ACES `vehicle_id` / `engine_id` / `submodelKey`
as **pass/fail short-circuit tiers, NOT as a graded component of the percentage**:
- Tier A: target.acesVehicleId === donor.acesVehicleId → flat 100 "Exact Fit (ACES)".
- Tier B: same engine_id, diff vehicle, powertrain systems → floor ~75 + evidence.
- Tier C: same submodelKey, diff engine, chassis systems → floor ~70 + evidence.
- Else → legacy heuristic (make/model/year/displacement + evidence), which can also reach 100.

**Live-decode dependency (the big surprise):** the tiers only fire when BOTH target
and donor have ACES ids, and those ids are **re-derived live at query time** by
decoding each vehicle's VIN squish through DataOne (`resolveDataOneSpecs` →
`batchDecodeSquishes` in `app/api/extension/jobs/search/route.ts`). The scorer does
**NOT** read the backfilled ACES columns on job records. So "the ACES backfill is
done" does NOT help this scorer — a donor with no VIN, or a DataOne miss/timeout,
silently drops to the heuristic. Making the backfill actually feed the scorer
(recognize exact-vehicle matches without a live donor VIN decode) is a real,
separate change — offered to Brandon as a follow-up option, not yet done.

**Why "Great Match" outranked "Exact Fit" (2026-07 Corolla vs Prius air filter):**
1. Heuristic gave a same-make/different-model donor a flat 100; only its *label*
   was capped to "Great Match" (band demoted when yearDiff!==0) while the *number*
   stayed 100.
2. The route sort ordered by sameVin then matchScore ONLY, so equal 100s weren't
   broken in favor of the true exact/ACES match.

**Fix shipped:** (a) when the heuristic exact band is demoted (yearDiff!==0), also
cap finalScore to SCORE_THRESHOLD_EXACT-1 so a Great Match reads below a real exact
fit; (b) add a qualityRank tie-break in the route sort
(sameVin > exact_aces > heuristic-exact > engine_match > submodel_match > likely).
Same-VIN and ACES short-circuits return BEFORE the cap, so they're unaffected.
**Why:** advisors distrust the tool when a different-model donor ties/outranks the
exact vehicle. Server-side only — no extension republish needed.
