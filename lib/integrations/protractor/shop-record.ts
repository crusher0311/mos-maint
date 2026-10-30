// Resolve both legacy ID representations, but never choose between duplicates.
export class ShopConnectionError extends Error {
  constructor(public code: string, message: string, public status = 409) {
    super(message);
  }
}

export async function resolveConnectionShop(db: any, shopId: number | string) {
  const id = Number(shopId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new ShopConnectionError("INVALID_SHOP", "Invalid shop session. Sign in again.", 403);
  }
  const shops = db.collection("shops");
  const [numeric, text] = await Promise.all([
    shops.findOne({ shopId: id }),
    shops.findOne({ shopId: String(id) }),
  ]);
  if (numeric && text) {
    throw new ShopConnectionError("SHOP_ID_AMBIGUOUS", "Multiple shop records match this session. Contact support to resolve the shop identity.");
  }
  const shop = numeric || text;
  if (!shop) throw new ShopConnectionError("SHOP_NOT_FOUND", "Shop not found. Sign in again or contact support.", 404);
  return shop;
}

export function exactShop(shop: any) {
  return { _id: shop._id, shopId: shop.shopId };
}

// Mongo equality with null also matches missing: require existence explicitly.
export function snapshotField(value: unknown) {
  return value === undefined ? { $exists: false } : { $eq: value, $exists: true };
}

export function connectionSnapshot(shop: any) {
  return {
    ...exactShop(shop),
    ...(shop.protractor === null ? { protractor: snapshotField(null) } : {}),
    ...Object.fromEntries([
      "integrationProvider", "protractorConnectionId", "protractorApiKey",
      "protractor.connectionGeneration", "protractor.connectionId", "protractor.apiKey",
      "protractor.configured", "protractor.syncRevision",
    ].map(path => [path, snapshotField(path.split(".").reduce((v, key) => v?.[key], shop))])),
    "protractor.checkpointWriteToken": { $exists: false },
  };
}

// Mongo cannot apply dotted $set fields below a null parent. Replace only that
// explicitly-null parent, protected by the snapshot above, never a live object.
export function writableConnectionFields(shop: any, fields: Record<string, unknown>) {
  if (shop.protractor !== null) return fields;
  const result: Record<string, unknown> = {};
  const protractor: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key.startsWith("protractor.")) protractor[key.slice("protractor.".length)] = value;
    else result[key] = value;
  }
  return Object.keys(protractor).length ? { ...result, protractor } : result;
}

export function assertCheckpointIdle(shop: any) {
  if (Object.prototype.hasOwnProperty.call(shop.protractor || {}, "checkpointWriteToken")) {
    throw new ShopConnectionError("PROTRACTOR_CHECKPOINT_BUSY", "Sync progress is being saved. Retry shortly; if this persists, contact support.");
  }
}

export function assertMatched(result: { matchedCount: number }) {
  if (result.matchedCount !== 1) throw new ShopConnectionError(
    "PROTRACTOR_SNAPSHOT_CHANGED", "Connection changed while saving. Reload the status and retry.",
  );
}
