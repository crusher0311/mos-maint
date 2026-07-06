import "server-only";
import { isDeclinedJobIndexRow } from "@/lib/job-index";
import { listRecentJobIndexForVehicle } from "@/lib/data/repositories/job-index";
import {
  estimateMileageFromCarfax,
  getCachedCarfaxServiceRecords,
} from "@/lib/integrations/carfax";
import {
  buildRecord,
  toPosNum,
  matchLastPerformed,
  type PerformedRecord,
  type VehicleHistory,
  type LastPerformedResult,
} from "@/lib/last-performed-match";

// Re-export the pure matching layer so existing consumers keep importing
// everything from "@/lib/last-performed".
export {
  matchLastPerformed,
  normalizeTokens,
} from "@/lib/last-performed-match";
export type {
  LastPerformedSource,
  LastPerformedResult,
  PerformedRecord,
  VehicleHistory,
} from "@/lib/last-performed-match";

/**
 * Task #743 — "Last performed" lookup.
 *
 * Given a shop + VIN + a repair/job name, find the most recent time that
 * same service was actually PERFORMED on the current vehicle, so an advisor
 * searching or adding a job can see "Last performed on DATE / ~X mi / at
 * your shop (or via CARFAX)".
 *
 * Fact-only: this never applies warranty logic, never guesses "never done"
 * (an absent record simply returns `null` → the caller renders no badge),
 * and never triggers a paid live CARFAX fetch (it reads the cached snapshot
 * only, exactly like the mileage estimator).
 *
 * It reuses the same per-VIN history sources and guards the plan builder
 * already relies on:
 *   - `job_index` (authoritative shop-history table), skipping declined /
 *     deferred / unauthorized rows via `isDeclinedJobIndexRow`.
 *   - CARFAX cached service records, skipping inspect-only phrases.
 *   - The existing service-key matcher for canonical maintenance items and
 *     a conservative free-text token match for arbitrary repairs that don't
 *     resolve to a canonical key.
 *   - `computeAnchorMiles` to estimate mileage from a date when the record
 *     itself carries no odometer.
 *
 * NOTE: The canonical Postgres `normalized_service_jobs` table is the
 * cross-shop job *search* index; for per-VIN service history it is fed by
 * the same backfill/webhook pipeline that populates `job_index`, which is
 * indexed by `{shopId, vehicle.vin}`. We therefore read `job_index` for the
 * shop-history arm rather than issuing an unindexed `vehicle->>'vin'` JSONB
 * scan against `normalized_work_orders` (see project memory:
 * plan-build VIN lookups that scan can saturate the shared datastore).
 *
 * The pure, data-store-free matching layer (types, tokenization, and
 * `matchLastPerformed`) lives in `lib/last-performed-match.ts` and is
 * re-exported above so consumers keep a single import surface.
 */

/**
 * Load and normalize the current vehicle's performed-service history from
 * every reused source in one pass, so a batch of job names can be matched
 * in-memory without re-querying per name.
 */
export async function loadVehicleHistory(opts: {
  shopId: number;
  shopIds?: number[];
  vin: string;
  currentMiles?: number | null;
}): Promise<VehicleHistory> {
  const { shopId, vin } = opts;
  const vinUpper = String(vin || "").toUpperCase().trim();
  const shopIds = (opts.shopIds && opts.shopIds.length > 0 ? opts.shopIds : [shopId])
    .map(Number)
    .filter((n) => Number.isFinite(n));

  const records: PerformedRecord[] = [];

  if (!vinUpper) {
    return { records, currentMiles: opts.currentMiles ?? null, milesPerDay: null };
  }

  // ---- job_index (authoritative shop-history) via the repository layer ----
  // VIN can be cased differently across legacy writers; we match the
  // exact-uppercase VIN under both the nested (`vehicle.vin`) and flat
  // (`vin`) shapes. Exact match only — never a case-insensitive $regex,
  // which cannot use an index and can saturate the shared Mongo cluster.
  try {
    const perShop = await Promise.all(
      shopIds.map((s) =>
        listRecentJobIndexForVehicle(
          s,
          [{ "vehicle.vin": vinUpper }, { vin: vinUpper } as any],
          500,
        ),
      ),
    );

    for (const ji of perShop.flat() as any[]) {
      // Declined / deferred / unauthorized rows are NOT performed service.
      if (isDeclinedJobIndexRow(ji)) continue;

      const serviceName: string = ji.jobName || ji.job?.title || ji.title || "";
      if (!serviceName) continue;

      const dateRaw =
        ji.closedDate || ji.closedAt || ji.performedAt || ji.completedAt || ji.indexedAt || null;
      const date = dateRaw ? new Date(dateRaw) : null;
      if (date && isNaN(date.getTime())) continue;

      const miles =
        toPosNum(ji.mileage) ?? toPosNum(ji.odometer) ?? toPosNum(ji.vehicle?.mileage) ?? null;

      records.push(buildRecord("shop", serviceName, date, miles));
    }
  } catch (err) {
    console.warn(`[LastPerformed] job_index read failed for ${vinUpper}: ${(err as Error)?.message}`);
  }

  // ---- CARFAX (cache-only snapshot; never a paid live fetch) ----
  let milesPerDay: number | null = null;
  let currentMiles = opts.currentMiles ?? null;
  try {
    const serviceRecords = await getCachedCarfaxServiceRecords(Number(shopId), vinUpper);
    for (const r of serviceRecords) {
      const description: string = r?.description || "";
      if (!description) continue;
      const date = r?.date ? new Date(r.date) : null;
      if (date && isNaN(date.getTime())) continue;
      const miles = toPosNum(r?.odometer);
      records.push(buildRecord("carfax", description, date, miles));
    }
  } catch (err) {
    console.warn(`[LastPerformed] carfax read failed for ${vinUpper}: ${(err as Error)?.message}`);
  }

  // Mileage estimation inputs (cache-only) for records that carry a date but
  // no recorded odometer.
  try {
    const est = await estimateMileageFromCarfax(Number(shopId), vinUpper);
    if (est.estimated) {
      milesPerDay = est.milesPerDay;
      if (currentMiles == null) currentMiles = est.mileage;
    }
  } catch {
    /* estimation is best-effort */
  }

  return { records, currentMiles, milesPerDay };
}

/**
 * Convenience: load history and match a batch of job names in one call.
 * Returns results aligned to the input `names` order (null where absent).
 */
export async function getLastPerformedBatch(opts: {
  shopId: number;
  shopIds?: number[];
  vin: string;
  names: string[];
  currentMiles?: number | null;
}): Promise<(LastPerformedResult | null)[]> {
  const history = await loadVehicleHistory(opts);
  return opts.names.map((n) => matchLastPerformed(history, n));
}
