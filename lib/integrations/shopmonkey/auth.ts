import { getDb } from "@/lib/mongo";
import type { ShopmonkeyApiKeyStatus, ShopmonkeyCredentials } from "./types";

// Shopmonkey uses a per-shop API key (Bearer) rather than a global OAuth
// client-credentials grant like Tekmetric. The key lives on the shop document
// under `shopmonkey.apiKey`. A global SHOPMONKEY_API_KEY env var may be used as
// a fallback for single-tenant / smoke-test setups, mirroring how Shop-Ware
// resolves global partner credentials.

const SHOPMONKEY_BASE_URL =
  process.env.SHOPMONKEY_API_BASE_URL || "https://api.shopmonkey.cloud/v3";

const TOKEN_FETCH_TIMEOUT_MS = Math.max(
  5000,
  Number(process.env.SHOPMONKEY_REQUEST_TIMEOUT_MS) || 60000,
);

export function getBaseUrl(): string {
  return SHOPMONKEY_BASE_URL;
}

/**
 * Resolve the per-shop Shopmonkey credentials from the shop document. Falls
 * back to a global SHOPMONKEY_API_KEY env var when no per-shop key is stored,
 * which keeps single-tenant smoke tests working without a Mongo write.
 */
export async function getCredentials(
  shopId: number,
): Promise<ShopmonkeyCredentials | null> {
  const db = await getDb();
  const shop = await db.collection("shops").findOne(
    { $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }] },
    { projection: { shopmonkey: 1 } },
  );

  const cfg = shop?.shopmonkey;
  const apiKey = cfg?.apiKey || process.env.SHOPMONKEY_API_KEY;
  if (!apiKey) return null;

  return {
    apiKey,
    locationId: cfg?.locationId ?? process.env.SHOPMONKEY_LOCATION_ID ?? null,
    companyId: cfg?.companyId ?? null,
  };
}

/**
 * Whether Shopmonkey is configured for a given shop (per-shop key or a global
 * env fallback). With no `shopId` it reports only whether the global env key is
 * present — used by registration/health checks that run before a shop context.
 */
export async function isConfigured(shopId?: number): Promise<boolean> {
  if (shopId === undefined) {
    return Boolean(process.env.SHOPMONKEY_API_KEY);
  }
  const creds = await getCredentials(shopId);
  return creds !== null;
}

/**
 * Validate an API key against Shopmonkey's status endpoint. Mirrors Tekmetric's
 * `testConnection` shape so callers get a uniform `{ ok, error? }`.
 */
export async function validateApiKey(
  apiKey: string,
): Promise<{ ok: boolean; status?: ShopmonkeyApiKeyStatus; error?: string }> {
  try {
    const res = await fetch(`${getBaseUrl()}/auth/api_key/status`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(TOKEN_FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `Shopmonkey key validation failed: ${res.status} ${text}` };
    }

    const json = await res.json().catch(() => ({}));
    const status: ShopmonkeyApiKeyStatus = json?.data ?? json ?? {};
    return { ok: true, status };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? "Shopmonkey key validation error" };
  }
}

/**
 * Discover the Shopmonkey company/location ids that a given API key belongs to.
 *
 * Shopmonkey keys are scoped to a single location, and `GET /location` returns
 * that location's own record — its singular `id` is the locationId and the
 * embedded `companyId` is the companyId. We use this to self-onboard shops that
 * were connected with only an API key (so the extension can resolve them by the
 * on-page Shopmonkey id) and to auto-fill those ids on connect.
 *
 * Each key reports ONLY its own id, so this is unambiguous even when one user
 * can access several Shopmonkey shops. A forbidden/invalid key or any transient
 * failure returns nulls rather than throwing — callers treat that as "could not
 * discover" and fail closed.
 */
export async function discoverIdsFromKey(
  apiKey: string,
): Promise<{ companyId: string | null; locationId: string | null }> {
  try {
    const res = await fetch(`${getBaseUrl()}/location`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(TOKEN_FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      return { companyId: null, locationId: null };
    }

    const json = await res.json().catch(() => ({}));
    // `/location` may return the location object directly, wrapped in a `data`
    // envelope, or (defensively) as a single-element list — normalize all three.
    let data: any = json?.data ?? json;
    if (Array.isArray(data)) data = data[0];

    const companyId =
      data?.companyId != null ? String(data.companyId) : null;
    const locationId = data?.id != null ? String(data.id) : null;
    return { companyId, locationId };
  } catch {
    return { companyId: null, locationId: null };
  }
}
