---
name: ACES coverage gaps (job_index)
description: Where/why ACES coverage is low across job_index sources, and the Shop-Ware classifier/source-table quirks.
---

# ACES coverage gaps in job_index

Baseline observed 2026-06-03 (read-only, prod Mongo ~8.96M docs / 110 shops).
Full write-up: `docs/aces-coverage-gap-analysis-2026-06-03.md`.

- **Protractor history was never ACES-decoded.** ~1.90M Protractor docs have
  ~97.7% VINs but ~0% `vehicle.acesDecodedAt`. Largest *fixable* gap — Phase B
  enrichment (`backfill:job-index-aces --skip-reindex`) is cache-first/free.
- **Tekmetric is split:** undecoded-but-VIN-rich shops (fixable, e.g. 63/75/94)
  vs VIN-limited shops (inherent ceiling, e.g. 84/86/110/117/54/73/120). ACES
  can never exceed VIN%. `acesEngineId` is structurally higher than
  `acesVehicleId` because ambiguous trims blank vehicle_id (`acesFromDecoded`).
- **Line-level PCDB is 0% corpus-wide** — historical Tek/SW payloads don't carry
  PCDB and Protractor has no line-rebuild path. Inherent without a separate
  PartsTech/PCDB re-match pass; re-running the backfill won't produce it.

## Shop-Ware job_index quirks (non-obvious)
- SW live-indexed job_index docs are **skeletal**: `{ provider:"shopware",
  servicePackageId:"<string>" }` with **no `vehicle` subdocument** → 0% VIN,
  undecodable as-is. Fixing needs a live SW re-ingest via
  NormalizedIngestionService, not a backfill flag.
- They identify SW via **`provider:"shopware"`** and a *string*
  `servicePackageId`. The coverage reporter's `classifySource` only recognized
  SW via `serviceItemUuid` / 36-char `serviceItemId`, so SW docs landed in
  `unknown` until a `provider`-stamp branch was added (2026-06-03).
- The `shopware_repair_orders` source table is keyed by **`tenantId`, not
  `shopId`** — so any shopId-filtered SW reindex/VIN-recovery matches nothing.

**Why:** matters for any future ACES/job-history remediation or for trusting the
coverage reporter — the gaps are mostly "enrichment never ran" (fixable) vs
"no VIN / skeletal source" (inherent), and SW is consistently mis-bucketed.
**How to apply:** use `report:job-index-aces-coverage -- --by-shop` to re-rank;
treat Protractor + undecoded VIN-rich Tek shops as fixable, SW + PCDB as inherent.
