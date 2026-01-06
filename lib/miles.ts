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

/**
 * Calculate average miles driven per month based on repair order history
 * Requires at least 2 data points with different dates and mileages
 */
export async function getAverageMilesPerMonth(
  db: Db,
  vin: string
): Promise<{ avgMilesPerMonth: number | null; dataPoints: number }> {
  const cleanVin = (vin || "").toUpperCase();

  // Get repair orders with mileage and date, sorted by date
  const orders = await db
    .collection("repair_orders")
    .find(
      { vin: cleanVin, mileage: { $gt: 0 } },
      { projection: { mileage: 1, createdAt: 1, updatedAt: 1 } }
    )
    .sort({ createdAt: 1 })
    .toArray();

  if (orders.length < 2) {
    return { avgMilesPerMonth: null, dataPoints: orders.length };
  }

  // Extract data points with valid mileage and dates
  const dataPoints: { date: Date; mileage: number }[] = [];
  for (const order of orders) {
    const mileage = toPosNum(order.mileage);
    const date = order.updatedAt || order.createdAt;
    if (mileage && date instanceof Date) {
      dataPoints.push({ date, mileage });
    }
  }

  if (dataPoints.length < 2) {
    return { avgMilesPerMonth: null, dataPoints: dataPoints.length };
  }

  // Sort by date and calculate average miles per month
  dataPoints.sort((a, b) => a.date.getTime() - b.date.getTime());
  
  const first = dataPoints[0];
  const last = dataPoints[dataPoints.length - 1];
  
  const milesDriven = last.mileage - first.mileage;
  const daysDiff = (last.date.getTime() - first.date.getTime()) / (1000 * 60 * 60 * 24);
  
  if (daysDiff < 30 || milesDriven <= 0) {
    // Not enough time span or mileage going backwards
    return { avgMilesPerMonth: null, dataPoints: dataPoints.length };
  }

  const monthsDiff = daysDiff / 30.44; // Average days per month
  const avgMilesPerMonth = Math.round(milesDriven / monthsDiff);

  return { avgMilesPerMonth, dataPoints: dataPoints.length };
}
