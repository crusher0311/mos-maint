export type HistoryPageRequest = {
  campaignAfter?: string;
  campaignId?: string;
  shopAfter?: string;
  receiptAfter?: string;
};

export class InvalidHistoryCursor extends Error {}

const validId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f]/.test(value);

export function historyCursor(kind: string, scope: string, id: string) {
  return Buffer.from(JSON.stringify([1, kind, scope, id])).toString("base64url");
}

function decode(token: string | undefined, kind: string, scope: string) {
  if (token === undefined) return undefined;
  try {
    if (!token || token.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(token)) throw Error();
    const value = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (!Array.isArray(value) || value.length !== 4 || value[0] !== 1 ||
      value[1] !== kind || value[2] !== scope || !validId(value[3])) throw Error();
    if (kind !== "campaigns" && !value[3].startsWith(`${scope}${kind === "shops" ? ":shop" : ""}:`)) throw Error();
    return value[3] as string;
  } catch { throw new InvalidHistoryCursor("Invalid history pagination cursor"); }
}

export function parseHistoryPage(request: HistoryPageRequest) {
  if ((request.campaignId !== undefined && !validId(request.campaignId)) ||
    (request.campaignAfter !== undefined && request.campaignId !== undefined) ||
    ((request.shopAfter !== undefined || request.receiptAfter !== undefined) && !request.campaignId)) {
    throw new InvalidHistoryCursor("Invalid history pagination scope");
  }
  return {
    campaignId: request.campaignId,
    campaignAfter: decode(request.campaignAfter, "campaigns", ""),
    shopAfter: decode(request.shopAfter, "shops", request.campaignId ?? ""),
    receiptAfter: decode(request.receiptAfter, "receipts", request.campaignId ?? ""),
  };
}
