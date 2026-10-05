export type ProtractorShopRecord = {
  integrationProvider?: unknown;
  protractor?: {
    connectionId?: unknown;
    apiKey?: unknown;
  } | null;
  protractorConnectionId?: unknown;
  protractorApiKey?: unknown;
};

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Protractor is a shop-owned integration. A declared provider always wins;
 * legacy shops without integrationProvider remain eligible only when they
 * carry their own complete Protractor credential pair.
 */
export function isProtractorShopRecord(shop: unknown): boolean {
  if (!shop || typeof shop !== "object") return false;
  const record = shop as ProtractorShopRecord;

  const declaredProvider = nonEmptyString(record.integrationProvider)
    ? record.integrationProvider.trim().toLowerCase()
    : "";
  if (declaredProvider) return declaredProvider === "protractor";

  const connectionId = record.protractorConnectionId ?? record.protractor?.connectionId;
  const apiKey = record.protractorApiKey ?? record.protractor?.apiKey;
  return nonEmptyString(connectionId) && nonEmptyString(apiKey);
}

export function readShopProtractorCredentials(
  shop: unknown,
): { connectionId: string; apiKey: string } | null {
  if (!isProtractorShopRecord(shop)) return null;
  const record = shop as ProtractorShopRecord;

  const connectionId = record.protractorConnectionId ?? record.protractor?.connectionId;
  const apiKey = record.protractorApiKey ?? record.protractor?.apiKey;
  if (!nonEmptyString(connectionId) || !nonEmptyString(apiKey)) return null;

  return {
    connectionId: connectionId.trim(),
    apiKey: apiKey.trim(),
  };
}