# ACES Coverage Gap Analysis — 2026-06-03

Diagnostic for Task #578. Identifies which shops/sources still have low ACES
coverage in the live `job_index` corpus and explains why. **Read-only** — all
numbers below come from read-only aggregations against the production Mongo
cluster (dev Mongo == prod) and the canonical PG `normalized_vehicles` store.
No backfill was re-run and no data was written.

## How to reproduce

```
# per-source totals + PG cross-check (full scan, slow)
npm run report:job-index-aces-coverage

# NEW: rank the worst-covered shops per source (bounded per-shop aggregations)
npm run report:job-index-aces-coverage -- --by-shop --top 20 --min-docs 500
```

The `--by-shop` mode was added by this task (see "Reporter enhancement" below).

## Corpus baseline (job_index, ~8.96M docs, 110 shops)

| source | shops | docs | decoded | acesVid | acesEid | hasVIN | linePCDB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tekmetric | 79 | 6,997,354 | 35.7% | 22.0% | 35.0% | 87.9% | 0.0% |
| protractor | 30 | 1,901,598 | 0.1% | 0.0% | 0.1% | 97.7% | 0.0% |
| shopware (was "unknown") | 2 | ~61,025 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| **TOTAL** | | **8,959,977** | **27.9%** | **17.2%** | **27.3%** | **89.4%** | **0.0%** |

PG `normalized_vehicles` cross-check (canonical store, 362,694 rows):
decoded 78,984 (21.8%), acesVid 46,284 (12.8%), acesEid 74,463 (20.5%).

## Notable gaps and root causes

### 1. Protractor — never ACES-enriched (largest *fixable* gap)
~1.86M of 1.90M Protractor docs carry a usable VIN (97.7%) yet **0.0%** have
`vehicle.acesDecodedAt`. Confirmed at the shop level: shop 25 = 0 / 71,844
decoded; every Protractor shop (25, 29, 35, 50, 51, 66, 67, 68, 69, 71, 72, 76,
115, 116, …) sits at ~0% decoded with 90–100% VIN. The historical ACES
enrichment (backfill Phase B) effectively never persisted for Protractor docs
even though they are eligible. `enrichVinsWithAces` is cache-first via DataOne,
so most of these VINs decode for free.
**Verdict: FIXABLE.** Highest ROI. A targeted Phase-B-only re-run
(`backfill:job-index-aces -- --shop <id> --skip-reindex --skip-pg-mirror`)
should lift each Protractor shop from ~0% toward its VIN ceiling (~97%).

### 2. Tekmetric — partial; enrichment reached some shops, not others
35.7% decoded overall. Two distinct sub-populations:
- **Undecoded-but-VIN-rich (fixable):** shop 63 (148,124 docs, 0.0% decoded,
  98.9% VIN), shop 75 (193,693 docs, 0.2% decoded, 92.4% VIN), shop 94 (79,176,
  0.4%, 92.4%). These are "the backfill never reached this shop" gaps — a
  targeted enrichment re-run recovers them.
- **VIN-limited (inherent ceiling):** shop 84 (53.8% VIN), 86 (50.9%), 110
  (51.2%), 117 (54.1%), 54 (64.1%), 73 (58.7%), 120 (58.3%). ACES can never
  exceed VIN coverage, so these shops are capped by unrecoverable VINs.

Structural note: across Tekmetric, `acesEid` (35.0%) tracks `decoded` while
`acesVid` (22.0%) lags. DataOne resolves a unique engine more often than a
unique vehicle config; ambiguous trims blank `vehicle_id` (see
`acesFromDecoded`), so vehicle_id is structurally lower than engine_id. This is
expected, not a bug.

### 3. Shop-Ware — inherent gap (skeletal docs, no VIN; reindex skipped)
Shop 136 "State Street Auto Service" (~60.9k docs) and shop 77 "Shop-Ware Demo".
Two compounding problems:
- **Classifier blind spot (now fixed):** SW live-indexed docs look like
  `{ provider: "shopware", servicePackageId: "<string>" }` — a *string*
  servicePackageId (fails the numeric-Tek heuristic) and no
  `serviceItemUuid` / 36-char `serviceItemId`, so the old classifier dumped them
  into `unknown`. The reporter now recognizes the `provider` stamp, so they
  surface as `shopware`.
- **No vehicle to decode:** these SW docs have **no `vehicle` subdocument at
  all** → 0% VIN → undecodable as they stand. The backfill deliberately skips SW
  reindex (it needs the full `NormalizedIngestionService` + a live SW sync), and
  the `shopware_repair_orders` source table (22,685 docs) is keyed by
  `tenantId`, **not** `shopId`, so the backfill's shopId-filtered SW reindex /
  VIN-recovery passes match nothing.

**Verdict: INHERENT.** Requires a live Shop-Ware re-ingest through
`NormalizedIngestionService` to populate vehicles *before* ACES is even
possible. Not a simple backfill re-run.

### 4. Line-level PCDB — 0% across the entire corpus (universal gap)
**0 of 8.96M docs** have any `lines[].pcdbPartTypeId` or `partsTechPartId`
(direct count). Lines do exist (7.72M docs have a non-empty `lines` array), but
they are plain labor/part lines with no PCDB IDs attached. Root cause: Phase B
only rebuilds lines for Tek/SW when it locates the source doc *and* a
`servicePackageId`, and the rebuild only attaches PCDB when the *source payload*
already carries it (`extractTekmetricPcdb` / `extractShopWarePcdb`) — historical
Tek/SW payloads don't. Protractor has no line-rebuild path at all.
**Verdict: LARGELY INHERENT.** Not recoverable by re-running the existing
backfill; would need a separate PartsTech/PCDB re-matching pass over historical
part lines.

### 5. Mongo ↔ PG divergence
PG `normalized_vehicles` ACES (decoded 21.8%, acesVid 12.8%) sits below the
Mongo Tekmetric slice (35.7% / 22.0%). Partly different grain/population
(362k canonical vehicles vs 9M job lines; PG only covers normalized-ingested
shops) and partly the Phase C Mongo→PG mirror + `backfill-normalized-vehicles-aces`
lagging. The worst PG shops are the same Protractor shops (54, 66, 67, 68, 71,
72, 29, 115) — the "Protractor never decoded" story shows up on the PG side too.

## Recommendations (priority order)

1. **Re-run ACES enrichment for Protractor shops** (Phase B only,
   `--skip-reindex --skip-pg-mirror`, per shop). Biggest win: ~1.86M VIN-bearing
   docs at ~0% → ~97% ceiling, cache-first/free. *Fixable.*
2. **Re-run enrichment for the undecoded VIN-rich Tekmetric shops** (63, 75, 94,
   and the rest of the 0%-decoded/high-VIN tail). *Fixable.*
3. **Accept the VIN-limited Tekmetric shops** (84, 86, 110, 117, 54, 73, 120) as
   capped; only a VIN-recovery effort against source tables could raise them, and
   their source VINs are already missing. *Inherent (bounded).*
4. **Shop-Ware needs a live re-ingest**, not a backfill flag — out of scope here;
   track separately. *Inherent.*
5. **Line-level PCDB needs a dedicated PartsTech/PCDB re-match pass** if it's
   worth the cost; the current backfill cannot produce it from historical
   payloads. *Inherent.*

All write-side remediation (re-runs, decodes, re-ingest) is explicitly out of
scope for this diagnostic task per the task brief.

## Reporter enhancement (shipped with this task)

`scripts/job-index-aces-coverage.ts`:
- Added `--by-shop [--top N] [--min-docs N]`: ranks the worst-covered shops per
  source (lowest `acesVid%` first) via one bounded aggregation per shop, so
  per-shop gaps are visible without a manual loop and without streaming 9M docs
  through Node. Read-only.
- Taught `classifySource()` (and the aggregation mirror) to honor an explicit
  `provider` stamp, so Shop-Ware docs (`provider:"shopware"`) report as
  `shopware` instead of hiding in `unknown`. `provider:"sms"` still maps to
  `sms_historical`.
