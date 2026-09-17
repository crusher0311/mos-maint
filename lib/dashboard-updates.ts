import type { Db } from "mongodb";

/**
 * Advance the dashboard change marker after a durable write.
 *
 * The aggregation-pipeline update makes the marker strictly increasing even
 * when two writes land in the same millisecond. It is intentionally numeric
 * for compatibility with the original dashboard_updates document.
 */
export async function bumpDashboardUpdate(
  db: Db,
  _source?: string,
  shopId?: string | number,
): Promise<number> {
  const now = Date.now();
  const shopKey =
    shopId == null ? null : String(shopId).replace(/[^a-zA-Z0-9_-]/g, "_");
  const update: Record<string, any> | any[] = shopKey
    ? {
        $max: { [`shopTimestamps.${shopKey}`]: now },
        $inc: { [`shopVersions.${shopKey}`]: 1 },
      }
    : [
        {
          $set: {
            timestamp: {
              $let: {
                vars: { current: { $ifNull: ["$timestamp", 0] } },
                in: {
                  $cond: [
                    { $gte: ["$$current", now] },
                    { $add: ["$$current", 1] },
                    now,
                  ],
                },
              },
            },
            globalVersion: {
              $add: [{ $ifNull: ["$globalVersion", 0] }, 1],
            },
          },
        },
      ];
  await db.collection("dashboard_updates").updateOne(
    { _id: "lastUpdate" } as any,
    update as any,
    { upsert: true },
  );
  return now;
}

/**
 * Global provider signals retain their legacy millisecond marker. AutoFlow
 * writes use a per-shop timestamp plus a tie-breaker counter so one shop's
 * event does not wake every other shop's dashboard.
 */
export function getDashboardUpdateMarker(
  update: any,
  shopId?: string | number,
): number {
  return Number(getDashboardUpdateToken(update, shopId).split(":")[0] || 0);
}

/**
 * Opaque change token for the dashboard client. Do not pack independent
 * counters into a number: a large per-shop count can otherwise mask a newer
 * global signal. Keeping the components explicit also preserves equality
 * semantics when timestamps tie.
 */
export function getDashboardUpdateToken(
  update: any,
  shopId?: string | number,
): string {
  const globalTimestamp = Number(update?.timestamp || 0);
  const globalVersion = Number(update?.globalVersion || 0);
  if (shopId == null) return `${globalTimestamp}:${globalVersion}`;
  const key = String(shopId).replace(/[^a-zA-Z0-9_-]/g, "_");
  const scopedTimestamp = Number(update?.shopTimestamps?.[key] || 0);
  const scopedVersion = Number(update?.shopVersions?.[key] || 0);
  return `${globalTimestamp}:${globalVersion}:${scopedTimestamp}:${scopedVersion}`;
}