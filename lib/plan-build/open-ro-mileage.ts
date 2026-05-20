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
 * This helper queries the local mirror collection for whichever SMS the
 * shop uses (tekmetric_work_orders, shopware_repair_orders,
 * protractor_work_orders) and returns the freshest RO's odometer along
 * with the source metadata. It does NOT filter on RO "status = open"
 * because the SMS mirrors don't all surface a uniform open-flag; the
 * most-recent RO by `createdAt`/`updatedAt` is the same row the overlay
 * is reading from in practice.
 *
 * Returns null when no RO is found (caller falls back to
 * vehicles.currentMileage -> CARFAX estimate -> annual fallback).
 */

export type OpenRoMileageIntegration = "tekmetric" | "shopware" | "protractor" | "autoflow";

export interface OpenRoMileageResult {
  miles: number;
  integration: OpenRoMileageIntegration;
  roIdentifier: string | null;
  roDate: Date | null;
}

export async function resolveOpenRoMileage(opts: {
  db: any;
  shopIdVariants: any[];
  vin: string;
  provider: string | null | undefined;
}): Promise<OpenRoMileageResult | null> {
  const { db, shopIdVariants, vin, provider } = opts;
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

    // AutoFlow + any unknown provider: no per-RO mirror collection we can
    // safely read here without a write. The caller already falls back to
    // vehicles.currentMileage which AutoFlow's sync keeps reasonably fresh.
    return null;
  } catch (err: any) {
    console.warn(
      `[OpenRoMileage] lookup error for vin=${vinUpper} provider=${integration}: ${err?.message || err}`,
    );
    return null;
  }
}
