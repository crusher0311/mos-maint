/**
 * Task #476 — Resolve "the mileage the Detect Dog overlay would show" from
 * the shop's most-recent RO so the partner VHI endpoint
 * (`GET /api/external/vehicles/[vin]/vhi`) matches what AppFueled sees in
 * the overlay.
 *
 * Detect Dog reads `milesIn` (Tekmetric) / equivalent field off the open RO
 * in real time. The partner endpoint historically read
 * `vehicles.currentMileage`, which is fed by CARFAX + last-known SMS state
 * and lags the open RO by hours-to-days. Same plan engine, different input
 * mileage -> the two surfaces disagree in front of the customer.
 *
 * "Open RO" semantics: we mirror the existing `resolveMileageFromRo` helper
 * in `lib/vhi-rebuild.ts` and take the most-recent RO by
 * `updatedAt`/`createdAt` on the mirror collection. We do not invent a new
 * status filter — Detect Dog's overlay reads the same mirrors and uses the
 * same recency convention, so this stays in lockstep with what the advisor
 * is looking at.
 *
 * AutoFlow has no per-RO mirror collection, so we fall through to the
 * unified `normalized_work_orders` Postgres table (where ingestion has
 * populated it). Returns null when nothing is found — caller falls back to
 * `vehicles.currentMileage` -> CARFAX estimate -> annual fallback.
 */

import { sql } from "drizzle-orm";
import type { MileageDiscrepancy } from "./mileage-discrepancy";
import { MILEAGE_DISCREPANCY_TOLERANCE_MILES, shopHistoryLabelFromProvider } from "./mileage-discrepancy";

export type OpenRoMileageIntegration =
  | "tekmetric"
  | "shopware"
  | "protractor"
  | "autoflow"
  | "normalized";

export interface OpenRoMileageResult {
  miles: number;
  integration: OpenRoMileageIntegration;
  roIdentifier: string | null;
  roDate: Date | null;
}

/**
 * Task #476 spec: the response field `mileageInputSource` is constrained
 * to this enum so partner consumers can rely on a stable contract.
 */
export type MileageInputSource =
  | "open_ro"
  | "vehicles_collection"
  | "carfax_estimated"
  | "annual_estimated";

/**
 * Task #872: freshness window for an RO odometer reading. Amends the Task
 * #476 "most-recent RO wins" rule: an RO odometer older than this window is
 * no longer treated as a *current* reading — the CARFAX rolling estimate is
 * also computed and the LARGER of the two wins (odometers are monotonic, so
 * a real reading is a floor that a forward-projecting estimate may exceed,
 * never undercut). Prevents a months-old posted-RO odometer from being
 * served as "Current" mileage (the HEART Evanston Lexus case).
 */
export const RO_ODOMETER_FRESHNESS_DAYS = 90;
export const RO_ODOMETER_FRESHNESS_MS = RO_ODOMETER_FRESHNESS_DAYS * 24 * 60 * 60 * 1000;

/**
 * Task #872: true when an RO date is known AND older than the freshness
 * window. An unknown/missing date is treated as FRESH — the roNumber-
 * specific path (an RO the advisor is looking at right now) and legacy
 * mirrors without timestamps must not be demoted on missing data.
 */
export function isRoOdometerStale(
  roDate: Date | string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!roDate) return false;
  const d = roDate instanceof Date ? roDate : new Date(roDate);
  if (isNaN(d.getTime())) return false;
  return now.getTime() - d.getTime() > RO_ODOMETER_FRESHNESS_MS;
}

/**
 * Task #872: pure reconciliation of a stale actual reading against the
 * CARFAX rolling estimate. Callers run this AFTER pickMileageInput when
 * `staleActual` is true (and an estimate could be computed):
 *  - estimate > stale actual → estimate wins, labeled `carfax_estimated`
 *  - estimate missing/lower → stale actual is still served with its
 *    original label (monotonic guard: never go backward from a real reading)
 */
export function reconcileStaleActualWithEstimate(input: {
  actualMiles: number | null;
  actualSource: MileageInputSource | null;
  estimateMiles: number | null | undefined;
}): { miles: number | null; mileageInputSource: MileageInputSource | null; estimateWon: boolean } {
  const actual = input.actualMiles && input.actualMiles > 0 ? input.actualMiles : null;
  const estimate = input.estimateMiles && input.estimateMiles > 0 ? input.estimateMiles : null;
  if (estimate != null && (actual == null || estimate > actual)) {
    return { miles: estimate, mileageInputSource: "carfax_estimated", estimateWon: true };
  }
  return { miles: actual, mileageInputSource: actual != null ? input.actualSource : null, estimateWon: false };
}

export async function resolveOpenRoMileage(opts: {
  db: any;
  shopIdVariants: any[];
  vin: string;
  provider: string | null | undefined;
  pg?: any;
}): Promise<OpenRoMileageResult | null> {
  const { db, shopIdVariants, vin, provider, pg } = opts;
  const vinUpper = vin.toUpperCase();
  const integration = ((provider || "tekmetric").toLowerCase()) as OpenRoMileageIntegration;

  try {
    if (integration === "tekmetric") {
      const wo = await db.collection("tekmetric_work_orders").findOne(
        { shopId: { $in: shopIdVariants }, vin: vinUpper },
        {
          sort: { updatedAt: -1, createdAt: -1 },
          projection: { odometer: 1, repairOrderNumber: 1, workOrderNumber: 1, updatedAt: 1, createdAt: 1 },
        },
      );
      if (wo?.odometer && Number(wo.odometer) > 0) {
        return {
          miles: Number(wo.odometer),
          integration: "tekmetric",
          roIdentifier: wo.repairOrderNumber ?? wo.workOrderNumber ?? null,
          roDate: wo.updatedAt ?? wo.createdAt ?? null,
        };
      }
      return null;
    }

    if (integration === "shopware") {
      const ro = await db.collection("shopware_repair_orders").findOne(
        { mosShopId: { $in: shopIdVariants }, vin: vinUpper },
        {
          sort: { updatedAt: -1 },
          projection: { odometer: 1, "raw.odometer": 1, "raw.odometer_out": 1, number: 1, roId: 1, updatedAt: 1 },
        },
      );
      const odo = ro?.raw?.odometer_out ?? ro?.raw?.odometer ?? ro?.odometer ?? null;
      if (odo && Number(odo) > 0) {
        return {
          miles: Number(odo),
          integration: "shopware",
          roIdentifier: ro.number != null ? String(ro.number) : ro.roId != null ? String(ro.roId) : null,
          roDate: ro.updatedAt ?? null,
        };
      }
      return null;
    }

    if (integration === "protractor") {
      const wo = await db.collection("protractor_work_orders").findOne(
        { shopId: { $in: shopIdVariants }, vin: vinUpper },
        {
          sort: { updatedAt: -1 },
          projection: {
            OutUsage: 1, InUsage: 1, Odometer: 1,
            "data.OutUsage": 1, "data.InUsage": 1, "data.Odometer": 1,
            workOrderNumber: 1, "data.OrderNumber": 1, updatedAt: 1,
          },
        },
      );
      const odo =
        wo?.OutUsage ?? wo?.InUsage ?? wo?.Odometer ??
        wo?.data?.OutUsage ?? wo?.data?.InUsage ?? wo?.data?.Odometer ?? null;
      if (odo && Number(odo) > 0) {
        return {
          miles: Number(odo),
          integration: "protractor",
          roIdentifier: wo.workOrderNumber ?? wo.data?.OrderNumber ?? null,
          roDate: wo.updatedAt ?? null,
        };
      }
      return null;
    }

    if (integration === "autoflow") {
      // No per-RO mirror collection exists for AutoFlow. Fall through to
      // the unified `normalized_work_orders` Postgres table where the
      // AutoFlow ingestion adapter populates `odometerIn` / `odometerOut`.
      // Match the most-recent row by updatedAt; vehicle JSONB carries vin.
      if (!pg) return null;
      const numericShopId = shopIdVariants.map((v: any) => Number(v)).find((n: any) => Number.isFinite(n));
      if (numericShopId == null) return null;
      const rows = await pg.execute(sql`
        SELECT
          COALESCE(odometer_out, odometer_in) AS odo,
          work_order_number,
          updated_at
        FROM normalized_work_orders
        WHERE shop_id = ${numericShopId}
          AND (provenance->>'sourceSystem') = 'autoflow'
          AND UPPER(COALESCE(vehicle->>'vin', '')) = ${vinUpper}
          AND COALESCE(odometer_out, odometer_in) IS NOT NULL
          AND COALESCE(odometer_out, odometer_in) > 0
        ORDER BY updated_at DESC
        LIMIT 1
      `);
      const row: any = rows?.rows?.[0] ?? rows?.[0] ?? null;
      if (row?.odo && Number(row.odo) > 0) {
        return {
          miles: Number(row.odo),
          integration: "autoflow",
          roIdentifier: row.work_order_number ?? null,
          roDate: row.updated_at ?? null,
        };
      }
      return null;
    }

    return null;
  } catch (err: any) {
    console.warn(
      `[OpenRoMileage] lookup error for vin=${vinUpper} provider=${integration}: ${err?.message || err}`,
    );
    return null;
  }
}

/**
 * Pure selection step used by the partner VHI endpoint. Extracted so it can
 * be regression-tested without standing up Mongo/Postgres. Picks the
 * effective input mileage and its provenance label.
 *
 * Rule (per task #476 spec): prefer the larger of (open-RO odometer,
 * vehicles.currentMileage). An odometer is monotonic — the smaller value
 * is by definition stale. When open-RO wins we surface
 * `mileageInputSource: "open_ro"`; otherwise `"vehicles_collection"`.
 * Returns nulls when neither source has a positive reading so the caller
 * can fall through to CARFAX / annual estimates and stamp those provenance
 * labels itself.
 */
export function pickMileageInput(input: {
  vehicleDocMileage: number | null | undefined;
  openRoLookup: OpenRoMileageResult | null;
  discrepancyToleranceMiles?: number;
  /** Task #872: injectable clock for freshness tests. Defaults to now. */
  now?: Date;
}): {
  miles: number | null;
  mileageInputSource: MileageInputSource | null;
  /**
   * Task #872: true when the chosen reading is an RO odometer whose RO date
   * is older than RO_ODOMETER_FRESHNESS_DAYS. A stale actual must no longer
   * short-circuit the CARFAX rolling estimate — the caller computes the
   * estimate and runs `reconcileStaleActualWithEstimate` to take the larger.
   */
  staleActual: boolean;
  /**
   * Task #476 spec: when the open RO is the LOWER of the two readings the
   * larger (vehicles.currentMileage) wins, but it's also evidence that the
   * advisor either typed a wrong odometer or the SMS row is stale —
   * surface a `mileage_discrepancy` for the partner's flags array.
   * Reuses the existing Task #391 plumbing.
   */
  discrepancy: MileageDiscrepancy | null;
} {
  const vehicle = input.vehicleDocMileage && input.vehicleDocMileage > 0 ? input.vehicleDocMileage : null;
  const roLookup = input.openRoLookup && input.openRoLookup.miles > 0 ? input.openRoLookup : null;
  const ro = roLookup ? roLookup.miles : null;
  const tolerance = input.discrepancyToleranceMiles ?? MILEAGE_DISCREPANCY_TOLERANCE_MILES;
  // Task #872: staleness of the RO reading (only meaningful when the RO wins).
  const roIsStale = roLookup ? isRoOdometerStale(roLookup.roDate, input.now) : false;

  if (ro != null && (vehicle == null || ro >= vehicle)) {
    return { miles: ro, mileageInputSource: "open_ro", staleActual: roIsStale, discrepancy: null };
  }
  if (vehicle != null) {
    let discrepancy: MileageDiscrepancy | null = null;
    if (ro != null && vehicle - ro > tolerance && roLookup != null) {
      // Open-RO odometer is below the vehicles snapshot by more than the
      // rounding tolerance. We use the larger value (vehicle) but warn.
      discrepancy = {
        currentMiles: vehicle,
        priorMiles: ro,
        priorSource: shopHistoryLabelFromProvider(roLookup.integration),
        priorDate: roLookup.roDate ? new Date(roLookup.roDate).toISOString() : null,
        gapMiles: vehicle - ro,
      };
    }
    // Task #872: the vehicles snapshot has NO per-record date (frozen since
    // its one-time import — see memory vhi-partner-latency), so we can't
    // date-gate it here; the frozen-snapshot problem is tracked separately.
    return { miles: vehicle, mileageInputSource: "vehicles_collection", staleActual: false, discrepancy };
  }
  return { miles: null, mileageInputSource: null, staleActual: false, discrepancy: null };
}
