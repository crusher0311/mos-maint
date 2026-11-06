import { refreshActiveRepairOrders } from "./active-sync";

/** Small durable handoff drained by the existing incremental poller.
 * Exact RO fetches re-check lifecycle; no dashboard reads or printing needed.
 * Claims impose backoff even if the worker dies or the provider returns nothing.
 */
export async function recoverPendingContexts(db: any, shopId: number, providerShopId: number, api: {
  getRepairOrder: (id: number, shop: number) => Promise<any>;
  getVehicle: (id: number, shop: number) => Promise<any>;
  getCustomer: (id: number, shop: number) => Promise<any>;
}, budgetMs = 10_000) {
  const end = Date.now() + budgetMs;
  const collection = db.collection("tekmetric_work_orders");
  const pending = await collection.find({
    shopId: { $in: [shopId, String(shopId)] }, contextRecoveryNeeded: true,
    $or: [{ contextRecoveryAfter: { $exists: false } }, { contextRecoveryAfter: { $lte: new Date() } }],
  }).limit(3).toArray();
  let imported = 0;
  for (const row of pending) {
    if (Date.now() >= end) break;
    const claimed = await collection.updateOne({
      _id: row._id, shopId: row.shopId, contextRecoveryNeeded: true,
      contextRecoveryAfter: row.contextRecoveryAfter ?? { $exists: false },
    }, { $set: { contextRecoveryAfter: new Date(Date.now() + 30 * 60_000) } });
    if (!claimed.matchedCount) continue;
    const outcome = await refreshActiveRepairOrders(db, shopId, providerShopId, {
      ...api,
      getRepairOrders: async () => {
        const ro = await api.getRepairOrder(Number(row.workOrderId), providerShopId);
        if (!ro || String(ro.id) !== String(row.workOrderId)) throw new Error("RO unavailable");
        return { content: [ro], last: true };
      },
    }, { maxPages: 1, budgetMs: Math.max(1, end - Date.now()) });
    imported += outcome.imported;
  }
  return imported;
}
