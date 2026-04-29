# Job-match scoring calibration — 2026-04-29 (Task #182)

## Before vs after at a glance

Same sampling methodology (5 shops × 8 random recent vehicles × 5 canonical queries × up to 60 same-make donor candidates each, run against the live `job_index` collection in production Mongo).

| Band | Before (Apr 12 algo) | After (Task #182) | Δ |
| --- | --- | --- | --- |
| Exact Fit | 25.8% | **32.7%** | **+6.9 pp** |
| Great Match | 24.8% | **35.2%** | **+10.4 pp** |
| Good Match | 24.3% | 16.7% | −7.6 pp |
| Low Confidence | 25.1% | 15.4% | −9.7 pp |

| Cohort | Before | After |
| --- | --- | --- |
| Same-VIN donors landing at Exact | **84/92** (8 missed) | **65/65** (0 missed) |
| Same make+model+≤1y landing at Exact | 411/432 | 561/570 |
| Cross-class rows at Exact (must stay 0) | 0 | 0 |
| Diesel↔gas blocked by fuel gate | 81 | 38 |

Median final score moved from 60 → **68**, p25 from 33 → **48**. The same-VIN fast path eliminated all 8 "same vehicle but not Exact" cases, the supportive-evidence bonuses (recency / same shop / corroboration) pushed the strong middle into Great Match territory, and the safety gates (cross-class, diesel-vs-gas) are still firing as before.

The original "before" and "after" raw dumps follow.

---

# Job-match scoring calibration (before) — 2026-04-29

## Sampling

- Shops: 32, 50, 67, 51, 76
- Target vehicles per shop: 8 (random, last 12 months, with VIN/year/make/model)
- Queries per target: `brake`, `oil change`, `rotation`, `battery`, `alignment`
- Donor candidates per query: up to 60 most-recent same-make jobs
- Total scored rows: 11538
- Gated out (fuel/etc): 81 (diesel/gas: 81)

## Score distribution (11457 gate-passing rows)

| Percentile | Final score |
| --- | --- |
| p10 | 11 |
| p25 | 33 |
| p50 | 60 |
| p75 | 85 |
| p90 | 100 |
| max | 100 |

## Band breakdown

| Band | Count |
| --- | --- |
| Exact (≥85) | 2955 (25.8%) |
| Likely (≥60) | 2844 (24.8%) |
| Possible (≥35) | 2783 (24.3%) |
| Low Confidence (<35) | 2875 (25.1%) |

## Same-VIN donor jobs (92 rows)

| Band | Count |
| --- | --- |
| Exact | 84 |
| Likely | 8 |
| Possible | 0 |
| Low Confidence | 0 |

**Same VIN but not Exact: 8 rows.**

## Same make+model, ≤1 year apart (432 rows)

| Band | Count |
| --- | --- |
| Exact | 411 |
| Likely | 21 |
| Possible | 0 |
| Low Confidence | 0 |

**Of those, 0 had missing DataOne decode on at least one side; 0 of those landed below Likely.**

## Safety check

- Cross-class rows that landed at Exact: **0** (must stay 0)
- Diesel-vs-gas rows blocked by fuel gate: 81




---

# Job-match scoring calibration (after) — 2026-04-29

## Sampling

- Shops: 32, 50, 67, 51, 76
- Target vehicles per shop: 8 (random, last 12 months, with VIN/year/make/model)
- Queries per target: `brake`, `oil change`, `rotation`, `battery`, `alignment`
- Donor candidates per query: up to 60 most-recent same-make jobs
- Total scored rows: 10978
- Gated out (fuel/etc): 38 (diesel/gas: 38)

## Score distribution (10940 gate-passing rows)

| Percentile | Final score |
| --- | --- |
| p10 | 6 |
| p25 | 48 |
| p50 | 68 |
| p75 | 88 |
| p90 | 100 |
| max | 100 |

## Band breakdown

| Band | Count |
| --- | --- |
| Exact Fit | 3581 (32.7%) |
| Great Match | 3849 (35.2%) |
| Good Match | 1827 (16.7%) |
| Low Confidence | 1683 (15.4%) |

## Same-VIN donor jobs (65 rows)

| Band | Count |
| --- | --- |
| Exact | 65 |
| Likely | 0 |
| Possible | 0 |
| Low Confidence | 0 |

**Same VIN but not Exact: 0 rows.**

## Same make+model, ≤1 year apart (570 rows)

| Band | Count |
| --- | --- |
| Exact | 561 |
| Likely | 9 |
| Possible | 0 |
| Low Confidence | 0 |

**Of those, 0 had missing DataOne decode on at least one side; 0 of those landed below Likely.**

## Safety check

- Cross-class rows that landed at Exact: **0** (must stay 0)
- Diesel-vs-gas rows blocked by fuel gate: 38
