/** Strict numeric provider IDs; never accept parseInt prefixes or unsafe IDs. */
export function shopwareNumericId(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value ?? "");
  const id = Number(text);
  return /^[1-9]\d*$/.test(text) && Number.isSafeInteger(id) ? id : null;
}

export function verifiedShopwareLocation(
  data: any, tenantId: number, context: { locationId: number | null; repairOrderId: number | null },
): number {
  const { locationId, repairOrderId } = context;
  const verified = shopwareNumericId(repairOrderId ? data?.shop_id : data?.id);
  if (!verified || (repairOrderId && shopwareNumericId(data?.id) !== repairOrderId) ||
      (!repairOrderId && (verified !== locationId || shopwareNumericId(data?.tenant_id) !== tenantId)) ||
      (data?.tenant_id != null && shopwareNumericId(data.tenant_id) !== tenantId)) {
    throw new Error("Shop-Ware location evidence did not match the requested context");
  }
  return verified;
}

/** Resolve globally before applying access. Provider evidence is read-only. */
export async function resolveShopwareStickerLocation(
  db: any,
  identifier: string,
  context: { locationId?: unknown; repairOrderId?: unknown },
  verify: (tenantId: number, context: { locationId: number | null; repairOrderId: number | null }) => Promise<number>,
) {
  const locationId = shopwareNumericId(context.locationId);
  const repairOrderId = shopwareNumericId(context.repairOrderId);
  if ((context.locationId != null && !locationId) || (context.repairOrderId != null && !repairOrderId)) {
    return { status: "not_found" as const };
  }
  const tenantIdHint = shopwareNumericId(identifier);
  const claims = await db.collection("shops").find({ $or: [
    { "shopware.tenantSubdomain": identifier },
    { "shopware.tenantId": { $in: tenantIdHint ? [identifier, tenantIdHint] : [identifier] } },
  ] }).limit(51).toArray();
  if (!claims.length) return { status: "not_found" as const };
  const conflict = () => ({ status: "conflict" as const, shopIds: claims.map((s: any) => s.shopId) });
  const tenants = new Set<number | null>(claims.map((s: any) => shopwareNumericId(s.shopware?.tenantId)));
  if (claims.length > 50 || tenants.size !== 1 || tenants.has(null)) return conflict();
  const tenantId = [...tenants][0]!;
  const verifiedLocation = await verify(tenantId, { locationId, repairOrderId });
  if (!shopwareNumericId(verifiedLocation) || (locationId && locationId !== verifiedLocation)) {
    return { status: "not_found" as const };
  }
  // Check the pair globally, including other aliases and numeric/string storage.
  const owners = await db.collection("shops").find({
    "shopware.tenantId": { $in: [tenantId, String(tenantId)] },
    "shopware.swShopId": { $in: [verifiedLocation, String(verifiedLocation)] },
  }).limit(2).toArray();
  if (owners.length > 1) return { status: "conflict" as const, shopIds: owners.map((s: any) => s.shopId) };
  const owner = owners[0];
  if (!owner || !claims.some((s: any) =>
    String(s.shopId) === String(owner.shopId) &&
    shopwareNumericId(s.shopware?.swShopId) === verifiedLocation)) {
    return { status: "not_found" as const };
  }
  return { status: "resolved" as const, owner };
}
