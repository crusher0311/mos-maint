import { AsyncLocalStorage } from "node:async_hooks";
import { trackApiRequest } from "@/lib/api-usage-tracker";
import { getBaseUrl, getCredentials } from "./auth";
import {
  acquireSharedShopmonkeySlot,
  getSharedShopmonkeyCooldownMs,
  setSharedShopmonkeyCooldown,
  type SharedSlotPriority,
} from "./shared-rate-limiter";
import type {
  ShopmonkeyEnvelope,
  ShopmonkeyPaginatedResponse,
  ShopmonkeyOrder,
  ShopmonkeyVehicle,
  ShopmonkeyCustomer,
  ShopmonkeyServiceItem,
  ShopmonkeyCannedService,
} from "./types";

const REQUEST_TIMEOUT_MS = Math.max(
  5000,
  Number(process.env.SHOPMONKEY_REQUEST_TIMEOUT_MS) || 60000,
);

// Per-chunk rate-limit backoff accumulator, scoped via AsyncLocalStorage so
// concurrent backfill chunks do not leak rate-limit waits into each other's
// per-chunk metric. Mirrors the Tekmetric/Shop-Ware pattern.
const backoffStorage = new AsyncLocalStorage<{ ms: number }>();

export async function runWithShopmonkeyBackoffTracking<T>(
  fn: (counter: { readonly ms: number }) => Promise<T>,
): Promise<T> {
  const counter = { ms: 0 };
  return backoffStorage.run(counter, () => fn(counter));
}

class ShopmonkeyNotConfiguredError extends Error {
  constructor(shopId: number) {
    super(`Shopmonkey not configured for shop ${shopId}`);
    this.name = "ShopmonkeyNotConfiguredError";
  }
}

// 429 handling: Cloudflare's 1015 edge limit on api.shopmonkey.cloud usually
// arrives as a 429 WITHOUT a Retry-After header, so a default cooldown is
// applied when no hint is present. Retries are bounded — a persistent 429
// storm throws instead of recursing forever.
const DEFAULT_429_COOLDOWN_MS = 30_000;
const MAX_429_WAIT_MS = 120_000;
const MAX_429_RETRIES = 3;

function jitterMs(): number {
  return 250 + Math.floor(Math.random() * 1250);
}

export type ShopmonkeyRequestOptions = RequestInit & {
  /**
   * Shared-limiter lane. Interactive (user-facing) callers get the full RPS
   * cap; background (cron/backfill) callers are held under the user reserve.
   */
  smPriority?: SharedSlotPriority;
};

/**
 * Core Shopmonkey request: resolves the per-shop API key, waits out any shared
 * per-shop 429 cooldown, paces through the cross-process per-second limiter,
 * issues a Bearer request, tracks API usage, and applies a bounded, jittered
 * rate-limit backoff (honoring Retry-After) when the API reports it. Throws on
 * non-2xx (after tracking the failure).
 */
export async function shopmonkeyRequest<T = any>(
  shopId: number,
  path: string,
  options: ShopmonkeyRequestOptions = {},
  attempt: number = 0,
): Promise<T> {
  const creds = await getCredentials(shopId);
  if (!creds) throw new ShopmonkeyNotConfiguredError(shopId);

  const method = options.method || "GET";
  const url = `${getBaseUrl()}${path}`;
  const priority = options.smPriority ?? "background";

  // Shared per-shop cooldown (set by any process that saw a 429 for this
  // shop). Bounded wait so a long cooldown surfaces as an error rather than
  // silently hanging an interactive caller.
  const cooldownMs = await getSharedShopmonkeyCooldownMs(shopId);
  if (cooldownMs > 0) {
    if (cooldownMs > MAX_429_WAIT_MS) {
      throw new Error(
        `Shopmonkey rate-limit cooldown active for shop ${shopId} (${Math.round(cooldownMs / 1000)}s remaining)`,
      );
    }
    const backoffCounter = backoffStorage.getStore();
    if (backoffCounter) backoffCounter.ms += cooldownMs;
    await new Promise((r) => setTimeout(r, cooldownMs));
  }

  // Cross-process per-second pacing (see shared-rate-limiter.ts). A timed-out
  // slot means the fleet is saturating the budget — fail fast instead of
  // stacking more load on an already-hot edge.
  const slot = await acquireSharedShopmonkeySlot({ priority });
  if (!slot.acquired) {
    throw new Error(`Shopmonkey shared rate limiter timed out for shop ${shopId} (${path})`);
  }

  const startTime = Date.now();
  let statusCode = 0;

  try {
    const response = await fetch(url, {
      ...options,
      cache: "no-store",
      signal: options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${creds.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...options.headers,
      },
    });

    statusCode = response.status;
    const latencyMs = Date.now() - startTime;
    trackApiRequest("shopmonkey", path, method, statusCode, latencyMs, shopId).catch(() => {});

    // Honor a Retry-After / X-RateLimit-Reset hint; default when absent
    // (Cloudflare 1015 sends none). Cooldown is shared per shop so every
    // process backs off together, and retries are bounded + jittered.
    if (response.status === 429) {
      const retryAfter = response.headers.get("Retry-After");
      const reset = response.headers.get("X-RateLimit-Reset");
      let waitMs = 0;
      if (retryAfter && Number.isFinite(Number(retryAfter))) waitMs = Number(retryAfter) * 1000;
      else if (reset && Number.isFinite(Number(reset))) waitMs = Number(reset) * 1000 - Date.now();
      if (!(waitMs > 0)) waitMs = DEFAULT_429_COOLDOWN_MS;
      waitMs = Math.min(waitMs, MAX_429_WAIT_MS) + jitterMs();

      await setSharedShopmonkeyCooldown(shopId, waitMs).catch(() => {});

      if (attempt < MAX_429_RETRIES) {
        console.warn(
          `[Shopmonkey] Rate limit hit for shop ${shopId}, sleeping ${waitMs}ms (attempt ${attempt + 1}/${MAX_429_RETRIES})`,
        );
        const backoffCounter = backoffStorage.getStore();
        if (backoffCounter) backoffCounter.ms += waitMs;
        await new Promise((r) => setTimeout(r, waitMs));
        return shopmonkeyRequest<T>(shopId, path, options, attempt + 1);
      }
      throw new Error(
        `Shopmonkey API rate limited (429) after ${MAX_429_RETRIES} retries (${url})`,
      );
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Shopmonkey API error ${response.status} (${url}): ${errorText}`);
    }

    return response.json() as Promise<T>;
  } catch (err: any) {
    const latencyMs = Date.now() - startTime;
    trackApiRequest("shopmonkey", path, method, statusCode || 0, latencyMs, shopId).catch(() => {});
    throw err;
  }
}

function unwrap<T>(res: ShopmonkeyEnvelope<T> | T): T {
  if (res && typeof res === "object" && "data" in (res as any)) {
    return (res as ShopmonkeyEnvelope<T>).data;
  }
  return res as T;
}

/**
 * Drain every page of a Shopmonkey collection endpoint. Supports both
 * cursor-based and limit/offset pagination via the `meta` block.
 */
export async function getAllPages<T>(
  shopId: number,
  path: string,
  extraParams?: Record<string, string>,
): Promise<T[]> {
  const results: T[] = [];
  const limit = 100;
  let offset = 0;
  let cursor: string | null = null;
  let hasMore = true;
  const maxPages = 200;
  let page = 0;

  while (hasMore && page < maxPages) {
    const params = new URLSearchParams({ limit: String(limit), ...extraParams });
    if (cursor) params.set("cursor", cursor);
    else params.set("offset", String(offset));

    const sep = path.includes("?") ? "&" : "?";
    const data = await shopmonkeyRequest<ShopmonkeyPaginatedResponse<T>>(
      shopId,
      `${path}${sep}${params.toString()}`,
    );

    const rows = Array.isArray(data?.data) ? data.data : [];
    results.push(...rows);

    const next = data?.meta?.nextCursor ?? data?.meta?.cursor ?? null;
    if (next && next !== cursor) {
      cursor = next;
    } else if (data?.meta?.hasMore === true || rows.length === limit) {
      offset += limit;
      cursor = null;
    } else {
      hasMore = false;
    }
    page++;
  }

  return results;
}

export async function getVehicle(shopId: number, vehicleId: string): Promise<ShopmonkeyVehicle> {
  const res = await shopmonkeyRequest<ShopmonkeyEnvelope<ShopmonkeyVehicle>>(
    shopId,
    `/vehicle/${encodeURIComponent(vehicleId)}`,
  );
  return unwrap(res);
}

export async function getVehicles(
  shopId: number,
  params?: { updatedAfter?: string; customerId?: string },
): Promise<ShopmonkeyVehicle[]> {
  const extra: Record<string, string> = {};
  if (params?.updatedAfter) extra.updatedAfter = params.updatedAfter;
  if (params?.customerId) extra.customerId = params.customerId;
  return getAllPages<ShopmonkeyVehicle>(shopId, `/vehicle`, extra);
}

export async function searchVehiclesByVin(
  shopId: number,
  vin: string,
): Promise<ShopmonkeyVehicle[]> {
  const res = await shopmonkeyRequest<ShopmonkeyPaginatedResponse<ShopmonkeyVehicle>>(
    shopId,
    `/vehicle?vin=${encodeURIComponent(vin)}&limit=50`,
  );
  const rows = Array.isArray(res?.data) ? res.data : [];
  return rows.filter((v) => v.vin?.toUpperCase() === vin.toUpperCase());
}

export async function getCustomer(shopId: number, customerId: string): Promise<ShopmonkeyCustomer> {
  const res = await shopmonkeyRequest<ShopmonkeyEnvelope<ShopmonkeyCustomer>>(
    shopId,
    `/customer/${encodeURIComponent(customerId)}`,
  );
  return unwrap(res);
}

export async function getOrder(shopId: number, orderId: string): Promise<ShopmonkeyOrder> {
  const res = await shopmonkeyRequest<ShopmonkeyEnvelope<ShopmonkeyOrder>>(
    shopId,
    `/order/${encodeURIComponent(orderId)}`,
  );
  return unwrap(res);
}

export async function getOrders(
  shopId: number,
  params?: {
    updatedAfter?: string;
    closedAfter?: string;
    vehicleId?: string;
    customerId?: string;
  },
): Promise<ShopmonkeyOrder[]> {
  const extra: Record<string, string> = {
    // The order LIST endpoint returns only vehicleId/customerId by default;
    // ask it to embed the vehicle and customer objects (it accepts an `include`
    // object via bracket notation). Line items are NOT embeddable here — they
    // must be fetched separately from `/service_item`.
    "include[vehicle]": "true",
    "include[customer]": "true",
  };
  if (params?.updatedAfter) extra.updatedAfter = params.updatedAfter;
  if (params?.closedAfter) extra.closedAfter = params.closedAfter;
  if (params?.vehicleId) extra.vehicleId = params.vehicleId;
  if (params?.customerId) extra.customerId = params.customerId;
  return getAllPages<ShopmonkeyOrder>(shopId, `/order`, extra);
}

export interface ShopmonkeyOrdersPage {
  orders: ShopmonkeyOrder[];
  /** Resume state for the NEXT call; persist both and pass them back. */
  nextCursor: string | null;
  nextOffset: number;
  hasMore: boolean;
}

/**
 * Bounded, resumable variant of `getOrders` for the full-page backfill: fetches
 * at most `maxPages` pages (100 orders each) per call and returns the resume
 * cursor/offset so the caller can checkpoint between cron ticks instead of
 * materializing an entire year of orders in one run (the pattern that
 * saturated the web instance on 2026-08-06).
 */
export async function getOrdersPaged(
  shopId: number,
  params: {
    closedAfter?: string;
    updatedAfter?: string;
    cursor?: string | null;
    offset?: number;
    maxPages?: number;
  },
): Promise<ShopmonkeyOrdersPage> {
  const extra: Record<string, string> = {
    "include[vehicle]": "true",
    "include[customer]": "true",
  };
  if (params.updatedAfter) extra.updatedAfter = params.updatedAfter;
  if (params.closedAfter) extra.closedAfter = params.closedAfter;

  const limit = 100;
  const maxPages = Math.max(1, params.maxPages ?? 1);
  const orders: ShopmonkeyOrder[] = [];
  let cursor: string | null = params.cursor ?? null;
  let offset = params.offset ?? 0;
  let hasMore = true;
  let page = 0;

  while (hasMore && page < maxPages) {
    const qs = new URLSearchParams({ limit: String(limit), ...extra });
    if (cursor) qs.set("cursor", cursor);
    else qs.set("offset", String(offset));

    const data = await shopmonkeyRequest<ShopmonkeyPaginatedResponse<ShopmonkeyOrder>>(
      shopId,
      `/order?${qs.toString()}`,
    );

    const rows = Array.isArray(data?.data) ? data.data : [];
    orders.push(...rows);

    // Track total rows consumed on EVERY page (even cursor-driven ones) so
    // that if cursor metadata ever disappears mid-run, the offset fallback is
    // a consistent continuation rather than a stale starting offset.
    offset += rows.length;

    const next = data?.meta?.nextCursor ?? data?.meta?.cursor ?? null;
    if (next && next !== cursor) {
      cursor = next;
    } else if (data?.meta?.hasMore === true || rows.length === limit) {
      cursor = null;
    } else {
      hasMore = false;
    }
    page++;
  }

  return { orders, nextCursor: cursor, nextOffset: offset, hasMore };
}

/**
 * Fetch flat order line items from the `/service_item` endpoint. Shopmonkey v3
 * does NOT embed labor/part arrays inside an order, and the endpoint REQUIRES a
 * `customerId` or `vehicleId` in a JSON `where` clause (returning 400
 * otherwise), so callers must supply at least one. Items reference their order
 * via the nested `order` object.
 */
export async function getServiceItems(
  shopId: number,
  filter: { vehicleId?: string; customerId?: string },
): Promise<ShopmonkeyServiceItem[]> {
  const where: Record<string, string> = {};
  if (filter.vehicleId) where.vehicleId = filter.vehicleId;
  if (filter.customerId) where.customerId = filter.customerId;
  if (!where.vehicleId && !where.customerId) {
    throw new Error("getServiceItems requires a vehicleId or customerId filter");
  }
  return getAllPages<ShopmonkeyServiceItem>(shopId, `/service_item`, {
    where: JSON.stringify(where),
  });
}

/**
 * Fetch the line items belonging to a single order. Resolves the order's
 * vehicle/customer id (the only valid `/service_item` filters) and keeps only
 * the items whose nested `order.id` matches. Returns an empty list if neither
 * id is available.
 */
export async function getOrderServiceItems(
  shopId: number,
  order: Pick<ShopmonkeyOrder, "id" | "vehicleId" | "customerId" | "vehicle" | "customer">,
): Promise<ShopmonkeyServiceItem[]> {
  const vehicleId = order.vehicleId ?? order.vehicle?.id ?? undefined;
  const customerId = order.customerId ?? order.customer?.id ?? undefined;
  if (!vehicleId && !customerId) return [];

  const all = await getServiceItems(shopId, { vehicleId, customerId });
  return all.filter((item) => String(item.order?.id ?? "") === String(order.id));
}

export async function getCannedServices(shopId: number): Promise<ShopmonkeyCannedService[]> {
  return getAllPages<ShopmonkeyCannedService>(shopId, `/canned_service`);
}

export async function testConnection(
  shopId: number,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const creds = await getCredentials(shopId);
    if (!creds) return { ok: false, error: "Shopmonkey not configured" };
    const { validateApiKey } = await import("./auth");
    return await validateApiKey(creds.apiKey);
  } catch (err: any) {
    return { ok: false, error: err?.message ?? "Connection test failed" };
  }
}
