/** Attach the provider identity to an existing legacy snapshot in its canonical
 * MOS tenant before webhook upsert. Never adopt a row by RO id alone.
 */
export async function attachLegacySnapshotIdentity(
  db: any, shopId: number, providerShopId: number, roId: string | number,
) {
  const collection = db.collection("tekmetric_work_orders");
  const canonical = await collection.findOne({
    tekmetricShopId: providerShopId, workOrderId: String(roId),
  });
  if (canonical) return;
  const legacy = await collection.findOne({
    shopId: { $in: [shopId, String(shopId)] },
    workOrderId: { $in: [String(roId), Number(roId)] },
    tekmetricShopId: null,
  });
  if (!legacy) return;
  await collection.updateOne({
    _id: legacy._id, shopId: legacy.shopId, tekmetricShopId: null,
  }, { $set: { tekmetricShopId: providerShopId, workOrderId: String(roId) } });
}
