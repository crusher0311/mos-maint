/**
 * Shopmonkey has no legacy provider RO collection. Read its normalized mirror,
 * scoped to both shop and provider; never fall back to another provider's RO.
 */
export async function findShopmonkeyRo(
  db: any,
  shopIdVariants: Array<string | number>,
  identity: { vin?: string; roId?: string; requireMileage?: boolean },
): Promise<any | null> {
  if (!identity.vin && !identity.roId) return null;
  const query: any = {
    shopId: { $in: shopIdVariants },
    "provenance.sourceIds.system": "shopmonkey",
    "softDelete.isDeleted": { $ne: true },
  };
  if (identity.vin) query["vehicle.vin"] = identity.vin.trim().toUpperCase();
  if (identity.roId) {
    query.$or = [
      { workOrderNumber: identity.roId },
      ...(Number.isFinite(Number(identity.roId)) ? [{ workOrderNumber: Number(identity.roId) }] : []),
      { "provenance.sourceIds": { $elemMatch: { system: "shopmonkey", idType: "repair_order_id", idValue: identity.roId } } },
    ];
  }
  const rows = await db.collection("normalized_work_orders").find(query, {
    // Existing index: bound the scan to this shop, never the entire mirror.
    hint: { shopId: 1, updatedAt: -1 },
    projection: { vehicle: 1, customer: 1, odometerIn: 1, odometerOut: 1, workOrderNumber: 1, status: 1, checkInDate: 1, completedDate: 1, closedDate: 1 },
    maxTimeMS: 2000,
  }).limit(501).toArray();
  // Never pick from a truncated set: ingestion order is NOT visit chronology.
  if (rows.length > 500) throw new Error("Shopmonkey RO history exceeds bounded lookup");
  // Customer/context lookups still include mileage-less estimates. Only
  // VIN-based mileage selection skips them; an explicit RO must never borrow
  // another visit's odometer.
  const candidates = identity.requireMileage && !identity.roId
    ? rows.filter((ro: any) => shopmonkeyRoMileage(ro) != null)
    : rows;
  candidates.sort((a: any, b: any) => {
    const active = (ro: any) => Number(["estimate", "work_in_progress"].includes(ro.status));
    return active(b) - active(a) ||
      (shopmonkeyRoDate(b)?.getTime() ?? 0) - (shopmonkeyRoDate(a)?.getTime() ?? 0) ||
      String(b.workOrderNumber ?? "").localeCompare(String(a.workOrderNumber ?? ""), undefined, { numeric: true });
  });
  return candidates[0] ?? null;
}

/** Source chronology only: updatedAt/createdAt are ingestion timestamps. */
export function shopmonkeyRoDate(ro: any): Date | null {
  const active = ["estimate", "work_in_progress"].includes(ro?.status);
  const dates = active ? [ro?.checkInDate] : [ro?.closedDate, ro?.completedDate, ro?.checkInDate];
  for (const value of dates) {
    if (!value) continue;
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) return date;
  }
  return null;
}

export function shopmonkeyRoMileage(ro: any): number | null {
  for (const value of [ro?.odometerOut, ro?.odometerIn]) {
    const miles = Number(value);
    if (Number.isFinite(miles) && miles > 0) return miles;
  }
  return null;
}
