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
}): { miles: number | null; mileageInputSource: MileageInputSource | null } {
  const vehicle = input.vehicleDocMileage && input.vehicleDocMileage > 0 ? input.vehicleDocMileage : null;
  const ro = input.openRoLookup && input.openRoLookup.miles > 0 ? input.openRoLookup.miles : null;

  if (ro != null && (vehicle == null || ro >= vehicle)) {
    return { miles: ro, mileageInputSource: "open_ro" };
  }
  if (vehicle != null) {
    return { miles: vehicle, mileageInputSource: "vehicles_collection" };
  }
  return { miles: null, mileageInputSource: null };
}
