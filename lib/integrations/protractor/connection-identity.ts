import crypto from "node:crypto";

const normalized = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
const digest = (value: string[]) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Credential generation fences workers; account binding identifies the account.
// Neither fingerprint contains credentials that can be returned to a browser.
export function connectionBinding(connectionId: string, apiKey: string): string {
  return digest([connectionId.trim().toLowerCase(), apiKey.trim().toLowerCase()]);
}

export function accountBinding(connectionId: string): string {
  return digest(["protractor-account-v1", connectionId.trim().toLowerCase()]);
}

export class ConnectionIdentityError extends Error {}

/** Only retained identity or internally consistent stored credentials establish
 * identity. A submitted account ID must never establish its own prior identity. */
export function storedAccountBinding(shop: any): string | undefined {
  const retained = shop?.protractor?.accountBinding;
  if (retained != null && (typeof retained !== "string" || !/^[a-f0-9]{64}$/.test(retained))) {
    throw new ConnectionIdentityError("Invalid retained account identity");
  }
  const ids = [normalized(shop?.protractorConnectionId), normalized(shop?.protractor?.connectionId)]
    .filter((x): x is string => !!x);
  const keys = [normalized(shop?.protractorApiKey), normalized(shop?.protractor?.apiKey)]
    .filter((x): x is string => !!x);
  if (new Set(ids).size > 1 || new Set(keys).size > 1) {
    throw new ConnectionIdentityError("Conflicting stored credentials");
  }
  const derived = ids[0] ? accountBinding(ids[0]) : undefined;
  if (retained && derived && retained !== derived) {
    throw new ConnectionIdentityError("Conflicting stored account identity");
  }
  const generation = shop?.protractor?.connectionGeneration;
  if (generation && ids[0] && keys[0] && generation !== connectionBinding(ids[0], keys[0])) {
    throw new ConnectionIdentityError("Conflicting stored credential generation");
  }
  return retained || derived;
}
