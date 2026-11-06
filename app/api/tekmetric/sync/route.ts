import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { getRepairOrders, getVehicle, getCustomer } from "@/lib/integrations/tekmetric";
import { refreshActiveRepairOrders } from "@/lib/integrations/tekmetric/active-sync";
import { acquireInitialSyncLock, releaseInitialSyncLock } from "@/lib/integrations/tekmetric/initial-sync-lock";
import { bumpDashboardUpdate } from "@/lib/dashboard-updates";

export async function POST(_request: NextRequest) {
  try {
    // Same authority as connection settings, including switched and ghost sessions.
    // Request bodies cannot override the authorized shop.
    const session = await getSession();
    if (!session?.shopId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const shopId = Number(session.shopId);
    const db = await getDb();
    const filter = { shopId: { $in: [shopId, String(shopId)] } };
    const shop = await db.collection("shops").findOne(filter);
    const providerShopId = Number(shop?.tekmetric?.shopId);
    if (!Number.isSafeInteger(providerShopId) || providerShopId <= 0) {
      return NextResponse.json({ error: "Tekmetric not configured for your shop", shopId }, { status: 400 });
    }
    const lock = await acquireInitialSyncLock(db, shopId);
    if (!lock.acquired) return NextResponse.json({ error: "A sync is already running for this shop", shopId }, { status: 409 });
    try {
      const current = await db.collection("shops").findOne(filter);
      if (Number(current?.tekmetric?.shopId) !== providerShopId) {
        return NextResponse.json({ error: "Connection changed. Reload before syncing.", shopId }, { status: 409 });
      }
      const stats = await refreshActiveRepairOrders(db, shopId, providerShopId, { getRepairOrders, getVehicle, getCustomer });
      await db.collection("shops").updateOne({ ...filter, "tekmetric.shopId": current!.tekmetric.shopId }, {
        $set: { "tekmetric.lastSyncAttempt": new Date(), "tekmetric.lastActiveSyncOutcome": stats,
          ...(!stats.partial ? { "tekmetric.lastSync": new Date() } : {}) },
      });
      if (stats.imported) await bumpDashboardUpdate(db, "tekmetric-manual-sync", shopId);
      return NextResponse.json({ success: !stats.partial, partial: stats.partial, shopId, stats });
    } finally { await releaseInitialSyncLock(db, shopId, lock.owner); }
  } catch (error) {
    console.error("Tekmetric active sync failed", error);
    return NextResponse.json({ error: "Sync could not finish. Some repair orders may have been updated." }, { status: 500 });
  }
}
