import crypto from "node:crypto";

/**
 * Task #937: server-owned idempotency-key derivation for Protractor
 * create routes.
 *
 * Protractor's create endpoints are upserts by ID (`POST /Contact/{id}`,
 * `POST /ServiceItem/{id}`, `POST /WorkOrder/{id}`), which is what makes
 * client retries after a route timeout duplicate-safe. But passing a
 * caller-supplied UUID straight through as the upstream entity ID would let
 * any authenticated user with write permission overwrite an ARBITRARY
 * existing contact/vehicle/work order by submitting its UUID as a
 * "clientRequestId".
 *
 * Instead, the routes derive the upstream ID server-side as
 * SHA-256(kind | shopId | userId | clientRequestId), formatted as a
 * v4-shaped UUID:
 *  - Deterministic: the same user retrying the same pending create (same
 *    clientRequestId) gets the SAME upstream ID → retry upserts, no dupes.
 *  - Non-forgeable targeting: hitting an existing record would require a
 *    SHA-256 preimage; the reachable ID space is only IDs this route
 *    allocated for this user+shop.
 *  - Scoped: bound to shop AND user, so a key can't be replayed across
 *    shops or by a different user.
 */
export function deriveIdempotentUpstreamId(
  kind: "contact" | "vehicle" | "workOrder",
  shopId: number | string,
  userId: string,
  clientRequestId: string,
): string {
  const digest = crypto
    .createHash("sha256")
    .update(`mos-create-id|${kind}|${shopId}|${userId}|${clientRequestId}`)
    .digest();
  const b = Buffer.from(digest.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4 nibble
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Resolve the optional clientRequestId from a request body into a safe
 * upstream ID, or undefined when absent/invalid (server then generates a
 * fresh random UUID — the pre-#937 behavior).
 */
export function resolveClientRequestId(
  kind: "contact" | "vehicle" | "workOrder",
  shopId: number | string,
  userId: unknown,
  clientRequestId: unknown,
): string | undefined {
  if (typeof clientRequestId !== "string" || clientRequestId.length === 0 || clientRequestId.length > 128) {
    return undefined;
  }
  return deriveIdempotentUpstreamId(kind, shopId, String(userId ?? ""), clientRequestId);
}
