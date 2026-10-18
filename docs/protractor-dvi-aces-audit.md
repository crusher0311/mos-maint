# Bounded ACES readiness audit — operator instructions

Status as of 2026-10-18: **not executed; live coverage unverified**.

No approved shop sample, verified live index plans, or isolated read-only connection were established in this task. Development Mongo is production Mongo; DataOne and QA can also share production PostgreSQL. Merely having credentials is not evidence that an expensive audit is safe. Historical coverage percentages and merged backfills are not reused as current findings.

## Scope and stop conditions

Operator approves named shops, stores, time window and maximum request budget before execution. Start with one Protractor pilot shop; add one approved shop from each comparison provider only if needed. Never enumerate all shops by running a fleet aggregation.

- Read-only DB principal through the approved secrets mechanism; no credentials in commands, outputs or reports.
- Connect directly with an operator DB console, **not** app bootstrap, `getDb` scripts, ingestion, coverage/backfill executables or decode helpers. Helpers can write cache/indexes.
- One request at a time, 2-second server query deadline, 5-second client selection/socket budget, at least 250 ms between queries.
- At most 200 rows per age stratum per store, 1,000 sampled rows/shop/store, and five minutes total. Stop on first timeout, unindexed plan, large examined/returned ratio (>20), operational alert or authorization uncertainty. Do not retry a timed-out scan with a larger limit.
- Inspect catalog/index metadata and non-executing query plans first. Do not run `EXPLAIN ANALYZE`, create indexes or repair data here. Missing suitable index => mark that stratum unavailable.
- Return only grouped counts to shared documentation. Keep raw VINs, customer records, titles, IDs and financial data out of reports; discard transient row samples after aggregation.

## Mongo: indexed historical-job sample

Use `job_index` in the approved application database, not the cron database. Inspect `getIndexes()` first. Current source declares `{shopId:1, performedAt:-1}`, but runtime existence/name must be verified. Do not run index-creation helpers to make this audit possible.

In an already authenticated read-only mongosh session, bind `SHOP`, `START`, `END` to approved shop/date values. Use numeric shop ID and then a separate string-ID sample only if historical mixed typing is relevant; report denominators separately. Example query shape:

```javascript
const q = { shopId: SHOP, performedAt: { $gte: START, $lt: END } };
const projection = {
  _id: 0, shopId: 1, performedAt: 1,
  provider: 1, dataSource: 1, "metadata.sourceType": 1,
  "vehicle.vin": 1, "vehicle.acesVehicleId": 1,
  "vehicle.acesEngineId": 1, "vehicle.submodelKey": 1,
  "vehicle.acesDecodedAt": 1
};
// Run queryPlanner first; inspect IXSCAN with shop/date bounds, no collection scan.
db.job_index.find(q, projection)
  .hint({shopId:1, performedAt:-1}).sort({performedAt:-1})
  .limit(200).maxTimeMS(2000).explain("queryPlanner");
// Only after plan approval:
const rows = db.job_index.find(q, projection)
  .hint({shopId:1, performedAt:-1}).sort({performedAt:-1})
  .limit(200).maxTimeMS(2000).toArray();
```

`SHOP`, `START`, `END` are shell variables supplied by the operator, not literal strings; dates must be BSON Dates. Do not print `rows`. Group in local memory by source and date range. Source precedence must record conflicts: explicit provider/dataSource, then metadata.sourceType; unknown remains unknown rather than inferred from a GUID's length.

Age buckets relative to a fixed audit cutoff: 0–90 days, 91–365 days, 366–730 days, >730 days (bound the oldest date to the approved retention horizon). No undated/unbounded collection scan: if an indexed missing-date query cannot be proven safe, report undated coverage “not sampled.” A capped most-recent sample is biased, not a random sample or fleet estimate.

Important: Mongo `performedAt` is not uniformly a true service date. `lib/job-index.ts` has paths using header modification time and cached fetch/scheduled time. Label these buckets **indexed performedAt age (service age unverified)** unless provenance independently establishes completion/invoice date. Never compare them as equivalent to PG closed-date age. If exact service-age coverage is required, use separately authorized exact-ID source reads or leave it unverified.

Metrics per shop/provider/age/store:
`sampleN`, `validVinN`, `vehicleIdN`, `engineIdN`, `bothIdsN`, `decodedStampN`, `stampWithoutIdsN`, `invalidIdN`, `unknownProviderN`, `truncated`, `ageBasis`, `queryMs`.
Positive integer or digit-string IDs normalize as in `coerceAcesId`; zero/negative/non-numeric values are invalid. VIN validity is not successful decode. Report each fraction against all sampled rows and valid-VIN rows, avoiding division by zero.

## PostgreSQL: verify active-search propagation, not only vehicle columns

First inspect `information_schema.columns` for `normalized_service_jobs`, `normalized_work_orders`, `normalized_vehicles`, and `pg_indexes` for those tables. No table scans. Active search joins service job → work order and takes ACES fields from **work-order `vehicle` JSON**. Normalized-vehicle ACES columns are a comparison, not a substitute.

Use an approved read-only session and transaction:

```sql
BEGIN READ ONLY;
SET LOCAL statement_timeout = '2s';
SET LOCAL lock_timeout = '500ms';
-- Plan before executing. :shop, :start, :end are bound parameters.
EXPLAIN (FORMAT JSON)
SELECT id, vehicle_id, vehicle, completed_date, closed_date, provenance
FROM normalized_work_orders
WHERE shop_id = :shop AND closed_date >= :start AND closed_date < :end
ORDER BY closed_date DESC
LIMIT 200;
-- After operator confirms bounded index access, execute that SELECT without EXPLAIN.
ROLLBACK;
```

Do not execute if the live schema differs or no suitable shop/date index exists. Do not silently substitute `created_at`: it is import age, not service age. For completed-but-unclosed records, a separately planned completed_date sample can be labeled separately. Missing-date records remain unmeasured.

The SELECT is for transient local processing only, not a console dump: `vehicle`/`provenance` may include private identifiers. Retain only ID-presence classifications and source-system counts. Use prepared statements/console binding, never paste secret URLs.

For at most 20 sampled work orders, one at a time:
1. Plan an exact `normalized_service_jobs` lookup by `shop_id` and `work_order_id`, limit 20; confirm indexed access before execution. Exclude soft-deleted jobs using the same predicate as `lib/supabase-job-search.ts`. Cap total sampled jobs at 200. Record job weighting/truncation.
2. Run the pure `mapServiceJobToCanonicalResult` and `specsFromStoredAces` against a sanitized in-memory fixture shape with the sampled ID-presence categories. Do not call the search HTTP endpoint; it can decode/write caches.
3. If approved, compare the matching `normalized_vehicles` row by exact primary key and shop after plan approval, selecting only ACES columns and decode flag. Count “vehicle columns populated / WO JSON missing” separately.
4. Compare paired Mongo/PG records only via approved natural keys in transient memory, using exact indexed lookups. Do not equate independently sampled percentages with paired propagation.

These are WO samples plus bounded job subsamples, not a job-weighted census. Report both denominators. If a store has no safe query plan, leave it unverified; don't force parity conclusions.

## Interpret nulls conservatively

| Observation | Possible cause | Next read-only evidence / owning phase |
|---|---|---|
| No usable VIN | Source limitation, old malformed records, lookup mistaken for VIN | Inspect sanitized source-shape categories; do not guess ownership or run VIN repair |
| Valid VIN, no stamp/IDs | Older ingestion path, no attempted enrichment, decode failure | Compare age/provider buckets; timestamps alone cannot distinguish all causes |
| Stamp with missing vehicle ID, engine present | Ambiguous trim/body candidates | Offline ambiguity fixtures; engine identity does not prove chassis fit |
| Stamp without either ID | Ambiguous/no-match result or historical poisoned decode | Distinguish only with existing bounded cached evidence; otherwise unknown |
| Vehicle columns populated, active WO JSON missing | Mapping/propagation gap | Owning history slice needs mapping tests, not automatic backfill |
| Mongo populated, PG search result missing | Different candidate source/mapping | Pair exact keys and inspect canonical mapping |
| High heuristic scores with missing IDs | Legacy broad search behavior | Strict DVI policy must abstain rather than fill three results |
| PCDB missing | Provider/catalog limitation or missing payload enrichment | Not equivalent to missing vehicle ACES; do not promise backfill will create PCDB |

Record output template:

```text
cutoff | shop alias | provider | store | age basis/bucket | sampleN |
valid VIN % | vehicle ID % | engine ID % | both % | stamped-no-IDs % |
mapping disagreement N | capped? | query budget | caveat
```

Only operator-approved aggregate results should be appended to a later report. Recommendations for repairs/backfills require separate approval and resumable verification; this runbook authorizes neither.
