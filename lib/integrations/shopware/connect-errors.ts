/**
 * Task #1064 — pure helpers for mapping Shop-Ware Connect failures to
 * friendly, actionable messages.
 *
 * Shop-Ware returns 404 both for tenants that don't exist AND for tenants
 * that never authorized our Partner API, so the raw
 * `Shop-Ware API error 404 (url): {"error":"Not Found"}` blob is
 * undiagnosable for users and support. These helpers turn that into a
 * self-explanatory message and, when the partner authorizations list is
 * available, suggest the likely-correct tenant ID.
 *
 * Deliberately free of "server-only"/db imports so it can be unit-tested
 * under tsx (see tests/shopware-connect-errors.smoke.ts).
 */

export interface PartnerAuthorizationLite {
  tenant_id: number;
  writable?: boolean;
}

/** True when an error (or error message) is a Shop-Ware 404 response. */
export function isShopWareNotFound(errOrMessage: unknown): boolean {
  const msg =
    typeof errOrMessage === "string"
      ? errOrMessage
      : (errOrMessage as any)?.message ?? "";
  return /Shop-Ware API error 404\b/.test(String(msg));
}

/**
 * When the entered tenant ID is NOT in the authorized list, and exactly one
 * authorized tenant has the entered Shop-Ware shop ID among its shops,
 * suggest that tenant. Returns null otherwise (ambiguous or no match).
 *
 * `tenantShopIds` maps authorized tenant_id -> that tenant's shop IDs
 * (built by the caller from GET /tenants/{id}/shops; tenants whose shop
 * lookup failed can simply be absent).
 */
export function suggestTenantId(
  authorizations: PartnerAuthorizationLite[],
  enteredTenantId: number,
  enteredShopId: number,
  tenantShopIds: Map<number, number[]>
): number | null {
  const authorized = new Set(authorizations.map((a) => a.tenant_id));
  if (authorized.has(enteredTenantId)) return null; // tenant is authorized; 404 came from elsewhere

  const matches: number[] = [];
  for (const [tenantId, shopIds] of tenantShopIds) {
    if (!authorized.has(tenantId)) continue;
    if (shopIds.includes(enteredShopId)) matches.push(tenantId);
  }
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Build the user-facing Connect error for a tenant-lookup 404.
 * No raw JSON or URLs — explains the ambiguity, the next step, the blank
 * Tenant ID fallback (when it applied), and a suggested tenant when known.
 */
export function buildTenantConnectError(opts: {
  enteredTenantId: number;
  enteredShopId: number;
  usedShopIdFallback: boolean;
  suggestedTenantId?: number | null;
}): string {
  const { enteredTenantId, enteredShopId, usedShopIdFallback, suggestedTenantId } = opts;
  const parts: string[] = [];

  parts.push(
    `Shop-Ware tenant ${enteredTenantId} either doesn't exist or hasn't authorized our Partner API — Shop-Ware reports both the same way.`
  );

  if (usedShopIdFallback) {
    parts.push(
      `Tenant ID was left blank, so your Shop ID (${enteredShopId}) was tried as the tenant ID. If your account is multi-location, enter your Tenant ID instead.`
    );
  }

  if (suggestedTenantId) {
    parts.push(
      `Our records show an authorized tenant (${suggestedTenantId}) that includes Shop ID ${enteredShopId} — try Tenant ID ${suggestedTenantId}.`
    );
  } else {
    parts.push(
      `Double-check the Tenant ID, and ask your Shop-Ware administrator to authorize the partner connection in Shop-Ware, then retry.`
    );
  }

  return parts.join(" ");
}
