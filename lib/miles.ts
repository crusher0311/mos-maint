// lib/miles.ts
import { Db } from "mongodb";
import { findVehicleByVin } from "@/lib/data/repositories/vehicles";
import { and, desc, sql } from "drizzle-orm";
import { getDb as getPgDb } from "@/lib/db/drizzle";
import { normalizedWorkOrders } from "@/lib/db/schema/normalized";

/**
 * Latest repair-order mileage for a VIN, sourced from the normalized
 * `normalized_work_orders` PG table (task #1000 — legacy `repair_orders`
 * Mongo reader retirement).
 *
 * Behaviour parity with the old Mongo `repair_orders.findOne`:
 *   - VIN match is exact + UPPERCASE (never regex).
 *   - "Latest" ordering = updatedAt desc, then createdAt desc.
 *   - Returns the RO odometer (`odometerIn`) and the record date so callers
 *     that only need mileage and callers that also need a recorded date can
 *     share a single query. `null`/`0`/non-positive mileage → `miles: null`.
 *
 * The legacy `repair_orders.mileage` field maps to `odometerIn` in the
 * normalized schema; VIN lives in the `vehicle` jsonb (`vehicle->>'vin'`).
 */
export async function getLatestRepairOrderMilesRecordForVin(
  vinRaw: string,
): Promise<{ miles: number | null; recordedDate: Date | null }> {
  const vin = String(vinRaw || "").toUpperCase();
  if (!vin) return { miles: null, recordedDate: null };

  const pg = getPgDb();
  const rows = await pg
    .select({
      odometerIn: normalizedWorkOrders.odometerIn,
      updatedAt: normalizedWorkOrders.updatedAt,
      createdAt: normalizedWorkOrders.createdAt,
    })
    .from(normalizedWorkOrders)
    .where(
      and(
        sql`upper(${normalizedWorkOrders.vehicle} ->> 'vin') = ${vin}`,
      ),
    )
    .orderBy(desc(normalizedWorkOrders.updatedAt), desc(normalizedWorkOrders.createdAt))
    .limit(1);

  const ro = rows[0];
  return {
    miles: toPosNum(ro?.odometerIn),
    recordedDate: ro?.updatedAt ?? ro?.createdAt ?? null,
  };
}

/** Convenience wrapper for callers that only need the mileage number. */
export async function getLatestRepairOrderMilesForVin(vinRaw: string): Promise<number | null> {
  const { miles } = await getLatestRepairOrderMilesRecordForVin(vinRaw);
  return miles;
}

/**
 * Prefer (in order, and ignoring 0/undefined):
 *   1) Latest repair-order mileage for the VIN (normalized_work_orders PG)
 *   2) Latest AutoFlow event mileage for the VIN
 *   3) vehicles.odometer (or vehicles.lastMiles)
 */
export async function getLatestMilesForVin(db: Db, vin: string): Promise<number | null> {
  const cleanVin = (vin || "").toUpperCase();

  // Latest RO for this VIN (normalized PG, task #1000)
  const mRO = await getLatestRepairOrderMilesForVin(cleanVin);

  // Latest AF / ManualClosed event, project mileage from common paths
  const af = await db.collection("events").aggregate([
    {
      $match: {
        $expr: {
          $eq: [
            {
              $toUpper: {
                $ifNull: ["$vehicleVin", { $ifNull: ["$vin", "$payload.vehicle.vin"] }],
              },
            },
            cleanVin,
          ],
        },
        $or: [
          { provider: "autoflow" },
          { provider: "ui", type: "manual_closed" },
        ],
      },
    },
    {
      $addFields: {
        createdAtDate: {
          $cond: [
            { $eq: [{ $type: "$createdAt" }, "date"] },
            "$createdAt",
            { $dateFromString: { dateString: { $toString: "$createdAt" }, onError: null, onNull: null } },
          ],
        },
      },
    },
    { $sort: { createdAtDate: -1 } },
    { $limit: 1 },
    {
      $project: {
        _id: 0,
        miles: {
          $ifNull: [
            "$payload.ticket.mileage",
            {
              $ifNull: [
                "$payload.mileage",
                {
                  $ifNull: [
                    "$payload.vehicle.mileage",
                    {
                      $ifNull: [
                        "$payload.vehicle.miles",
                        "$payload.vehicle.odometer",
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    },
  ]).next();
  const mAF = toPosNum(af?.miles);

  // Vehicle-level (odometer/lastMiles)
  const veh = await findVehicleByVin(cleanVin);
  const mVeh = toPosNum(veh?.odometer) ?? toPosNum(veh?.lastMiles);

  // Priority: RO → AF → Vehicle
  return mRO ?? mAF ?? mVeh ?? null;
}

function toPosNum(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}
