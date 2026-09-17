import { getDb } from "@/lib/data/db";
import { getDashboardUpdateToken } from "@/lib/dashboard-updates";

/** Snapshot before rendering/fetching rows so a concurrent change stays visible. */
export async function getDashboardBaselineToken(shopId: string | number): Promise<string> {
  const db = await getDb();
  const update = await db.collection("dashboard_updates").findOne(
    { _id: "lastUpdate" } as any,
    {
      projection: {
        timestamp: 1,
        globalVersion: 1,
        shopTimestamps: 1,
        shopVersions: 1,
      },
    },
  );
  return getDashboardUpdateToken(update, shopId);
}