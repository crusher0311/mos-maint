// lib/miles.ts
import { Db } from "mongodb";

/**
 * Prefer (in order, and ignoring 0/undefined):
 *   1) Latest repair_orders.mileage for the VIN
 *   2) Latest AutoFlow event mileage for the VIN
 *   3) vehicles.odometer (or vehicles.lastMiles)
 */
export async function getLatestMilesForVin(db: Db, vin: string): Promise<number | null> {
  const cleanVin = (vin || "").toUpperCase();

  // Latest RO for this VIN
  const ro = await db.collection("repair_orders").findOne(
    { vin: cleanVin },
    { sort: { updatedAt: -1, createdAt: -1 }, projection: { mileage: 1 } }
  );
  const mRO = toPosNum(ro?.mileage);

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
  const veh = await db.collection("vehicles").findOne(
    { vin: cleanVin },
    { projection: { odometer: 1, lastMiles: 1 } }
  );
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
