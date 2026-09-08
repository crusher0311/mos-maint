import { getSession } from "./auth";
import { getShopById } from "./shops";
import { getAppBaseUrl, VERIFIED_PUBLIC_APP_BASE_URLS } from "./app-host";
import * as repository from "./data/repositories/appfueled-url-events";
import { hashHookToken, newHookToken } from "./appfueled-url-webhook";
import { HookInputError, normalizeVin, parseConnectionInput, UUID_PATTERN } from "./appfueled-url-contract";
import { hookJson, readHookJson } from "./appfueled-hook-http";

export const __deps = { getSession, getShopById, getAppBaseUrl, ...repository };
export function publicConnection(connection: repository.AppFueledConnection) {
  const { tokenHash: _secret, ...safe } = connection;
  return safe;
}
function confirmBase(body: any) {
  const base = __deps.getAppBaseUrl();
  let url: URL;
  try { url = new URL(base); } catch { throw new HookInputError("invalid_configured_host"); }
  // Never provision bearer callbacks on preview or raw infrastructure hosts.
  // These are supported host templates, not a claim of verified deployment.
  if (!(VERIFIED_PUBLIC_APP_BASE_URLS as readonly string[]).includes(base)) throw new HookInputError("unsupported_callback_host");
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      body?.confirmedBaseUrl !== base) throw new HookInputError("confirm_configured_host");
  return base;
}
function parseFilters(req: Request): repository.ReceiptFilters {
  const q = new URL(req.url).searchParams;
  const filters: repository.ReceiptFilters = {};
  if (q.get("shopId")) {
    const shop = Number(q.get("shopId"));
    if (!Number.isSafeInteger(shop) || shop <= 0) throw new HookInputError("invalid_shop_filter");
    filters.shopId = shop;
  }
  if (q.get("connectionId")) {
    const connection = q.get("connectionId")!;
    if (!UUID_PATTERN.test(connection)) throw new HookInputError("invalid_connection_filter");
    filters.connectionId = connection;
  }
  if (q.get("vin")) {
    const vin = normalizeVin(q.get("vin"));
    if (!vin) throw new HookInputError("invalid_vin_filter");
    filters.vin = vin;
  }
  for (const key of ["from", "to"] as const) {
    if (!q.get(key)) continue;
    const date = new Date(q.get(key)!);
    if (isNaN(date.getTime())) throw new HookInputError("invalid_date_filter");
    filters[key] = date;
  }
  if (filters.from && filters.to && filters.from > filters.to) throw new HookInputError("invalid_date_range");
  const outcome = q.get("outcome");
  if (outcome && outcome !== "accepted" && outcome !== "rejected") throw new HookInputError("invalid_outcome_filter");
  if (outcome === "accepted" || outcome === "rejected") filters.outcome = outcome;
  const page = Number(q.get("page") || 1);
  if (!Number.isInteger(page) || page < 1 || page > 10000) throw new HookInputError("invalid_page");
  filters.page = page;
  return filters;
}

export async function handleAppFueledUrlAdmin(req: Request) {
  try {
    const session = await __deps.getSession();
    if (!session?.isPlatformAdmin) return hookJson({ error: "Forbidden" }, 403);
    if (req.method === "GET") {
      const filters = parseFilters(req);
      const [connections, receipts, urls] = await Promise.all([
        __deps.listConnections(), __deps.listReceipts(filters), __deps.listVehicleUrls(filters),
      ]);
      return hookJson({ ...receipts, hasMore: receipts.hasMore || urls.hasMore,
        connections: connections.map(publicConnection), vehicleUrls: urls.vehicleUrls,
        baseUrl: __deps.getAppBaseUrl() });
    }
    // JSON-only writes plus Origin / Fetch Metadata validation prevent cookie
    // auth being used to provision or rotate via cross-site form submission.
    const origin = req.headers.get("origin");
    if (req.headers.get("sec-fetch-site") === "cross-site" || (origin && origin !== new URL(req.url).origin)) return hookJson({ error: "Forbidden origin" }, 403);
    const body: any = await readHookJson(req);
    const actor = session.email || "platform_admin";
    if (req.method === "POST") {
      const input = parseConnectionInput(body);
      const base = confirmBase(body);
      // Exact MOS existence check, NOT the extension/provider compatibility
      // resolver. Namespace evidence is a separate operator attestation.
      const shop = await __deps.getShopById(input.mosShopId);
      if (!shop || Number(shop.shopId) !== input.mosShopId) throw new HookInputError("mos_shop_not_found");
      const token = newHookToken();
      const connection = await __deps.createConnection(input, actor, hashHookToken(token));
      return hookJson({ connection: publicConnection(connection), webhookUrl: `${base}/api/webhooks/appfueled/${token}` }, 201);
    }
    if (req.method === "PATCH") {
      if (!UUID_PATTERN.test(body?.id || "") || !["disable", "rotate"].includes(body?.action)) throw new HookInputError("invalid_action");
      const base = body.action === "rotate" ? confirmBase(body) : null;
      const token = body.action === "rotate" ? newHookToken() : null;
      const connection = await __deps.changeConnection(body.id, body.action, actor, token ? hashHookToken(token) : undefined);
      if (!connection) return hookJson({ error: "Connection not found" }, 404);
      return hookJson({ connection: publicConnection(connection), ...(token ? { webhookUrl: `${base}/api/webhooks/appfueled/${token}` } : {}) });
    }
    return hookJson({ error: "Method not allowed" }, 405);
  } catch (error) {
    if (error instanceof HookInputError) return hookJson({ error: error.reason }, error.status);
    if (error instanceof repository.ConnectionIdConflictError) return hookJson({ error: "connection_already_provisioned" }, 409);
    return hookJson({ error: "Storage unavailable. Verify the approved migration and retry." }, 503);
  }
}