import { dotPreservingUpdate } from "./dot-preserving-update";

/** Polls may enrich old rows, but must not replace a newer receipt.
 * No conditional upsert: a lost CAS must not insert a second RO.
 */
export async function writePolledSnapshot(
  db: any, shopId: number, roId: string | number,
  startedAt: Date, fields: Record<string, any>,
  insertFields: Record<string, any> = {},
) {
  const collection = db.collection("tekmetric_work_orders");
  const identity = {
    shopId: { $in: [shopId, String(shopId)] },
    workOrderId: { $in: [String(roId), Number(roId)] },
  };
  const existing = await collection.findOne(identity);
  if (existing) {
    if ([existing.fetchedAt, existing.updatedAt].some(value =>
      value && new Date(value).getTime() >= startedAt.getTime())) return false;
    const oldDate = Date.parse(existing.updatedDate || existing.data?.updatedDate || "");
    const incomingDate = Date.parse(fields.updatedDate || fields.data?.updatedDate || "");
    if (Number.isFinite(oldDate) && (!Number.isFinite(incomingDate) || oldDate > incomingDate)) return false;
  }
  const set = Object.fromEntries(Object.entries(fields).filter(([key, value]) =>
    value !== undefined && !(["vin", "customerName", "odometer", "vehicleYear", "vehicleMake", "vehicleModel", "vehicleEngine"].includes(key) &&
      (value == null || value === "" || value === 0 || value === "Unknown Customer"))));
  // List responses are not authoritative replacements for omitted detail.
  // Explicit arrays (including []) replace cached collections; omitted/null
  // jobs retain the webhook detail needed by audit, stickers and declined work.
  if (existing?.data && set.data &&
      String(existing.data.id) === String(set.data.id) &&
      Number(existing.data.shopId) === Number(set.data.shopId)) {
    const incoming = set.data;
    set.data = { ...existing.data, ...Object.fromEntries(
      Object.entries(incoming).filter(([, value]) => value !== undefined),
    ) };
    if (!Array.isArray(incoming.jobs) && Array.isArray(existing.data.jobs)) {
      set.data.jobs = existing.data.jobs;
    }
  }
  set.workOrderId = String(roId);
  set.shopId = shopId;
  if (!existing) {
    // Insert-only update avoids overwriting a webhook arriving after our read.
    try {
      const result = await collection.updateOne(identity, {
        $setOnInsert: { _id: `tekmetric:${fields.tekmetricShopId}:${String(roId)}`, ...insertFields, ...set },
      }, { upsert: true });
      return Boolean(result.upsertedId);
    } catch (error: any) {
      if (error?.code === 11000) return false;
      throw error;
    }
  }
  const filter: any = { _id: existing._id, ...identity };
  for (const key of ["fetchedAt", "updatedAt", "updatedDate", "status"]) {
    filter[key] = existing[key] === undefined ? { $exists: false } : existing[key];
  }
  const result = await collection.updateOne(filter, dotPreservingUpdate({ $set: set }));
  return result.matchedCount === 1;
}
