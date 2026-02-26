import { trackApiRequest } from '@/lib/api-usage-tracker';
import type {
  ShopWarePaginatedResponse,
  ShopWareRepairOrder,
  ShopWareVehicle,
  ShopWareCustomer,
  ShopWareCannedJob,
  ShopWareRecommendation,
  ShopWarePastRecommendation,
  ShopWareShop,
  ShopWareTenant,
} from './types';

const SW_PROD_BASE = 'https://api.shop-ware.com/api/v1';
const SW_SANDBOX_BASE = 'https://api.shop-ware-api-sandbox.com/api/v1';

function getBaseUrl(): string {
  return process.env.SHOPWARE_API_BASE_URL || (process.env.SHOPWARE_USE_SANDBOX === 'true' ? SW_SANDBOX_BASE : SW_PROD_BASE);
}

function getCredentials(): { partnerApiId: string; apiSecret: string } {
  const partnerApiId = process.env.SHOPWARE_PARTNER_API_ID;
  const apiSecret = process.env.SHOPWARE_API_SECRET;
  if (!partnerApiId || !apiSecret) {
    throw new Error('SHOPWARE_PARTNER_API_ID and SHOPWARE_API_SECRET must be set');
  }
  return { partnerApiId, apiSecret };
}

export function isConfigured(): boolean {
  return Boolean(process.env.SHOPWARE_PARTNER_API_ID && process.env.SHOPWARE_API_SECRET);
}

export async function shopWareRequest<T = any>(
  path: string,
  options: RequestInit = {},
  shopId?: number
): Promise<T> {
  const { partnerApiId, apiSecret } = getCredentials();
  const method = options.method || 'GET';
  const url = `${getBaseUrl()}${path}`;
  const startTime = Date.now();
  let statusCode = 0;

  try {
    const response = await fetch(url, {
      ...options,
      cache: 'no-store',
      headers: {
        'X-Api-Partner-Id': partnerApiId,
        'X-Api-Secret': apiSecret,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...options.headers,
      },
    });

    statusCode = response.status;
    const latencyMs = Date.now() - startTime;
    trackApiRequest('shopware', path, method, statusCode, latencyMs, shopId).catch(() => {});

    const remaining = response.headers.get('X-RateLimit-Remaining');
    const reset = response.headers.get('X-RateLimit-Reset');
    if (remaining !== null && Number(remaining) === 0 && reset) {
      const resetMs = Number(reset) * 1000 - Date.now();
      if (resetMs > 0 && resetMs < 60_000) {
        console.warn(`[Shop-Ware] Rate limit hit, sleeping ${resetMs}ms`);
        await new Promise(r => setTimeout(r, resetMs));
      }
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Shop-Ware API error ${response.status}: ${errorText}`);
    }

    return response.json() as Promise<T>;
  } catch (err: any) {
    const latencyMs = Date.now() - startTime;
    trackApiRequest('shopware', path, method, statusCode || 0, latencyMs, shopId).catch(() => {});
    throw err;
  }
}

export async function getAllPages<T>(
  path: string,
  shopId?: number,
  extraParams?: Record<string, string>
): Promise<T[]> {
  const results: T[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const params = new URLSearchParams({ per_page: '100', page: String(page), ...extraParams });
    const sep = path.includes('?') ? '&' : '?';
    const data = await shopWareRequest<ShopWarePaginatedResponse<T>>(
      `${path}${sep}${params.toString()}`,
      {},
      shopId
    );

    results.push(...data.results);

    if (data.current_page >= data.total_pages || data.results.length === 0) {
      hasMore = false;
    } else {
      page++;
    }
  }

  return results;
}

export async function getTenants(): Promise<ShopWareTenant[]> {
  return getAllPages<ShopWareTenant>('/tenants');
}

export async function getTenant(tenantId: number): Promise<ShopWareTenant> {
  return shopWareRequest<ShopWareTenant>(`/tenants/${tenantId}`);
}

export async function getShops(tenantId: number): Promise<ShopWareShop[]> {
  return getAllPages<ShopWareShop>(`/tenants/${tenantId}/shops`);
}

export async function getShop(tenantId: number, shopId: number): Promise<ShopWareShop> {
  return shopWareRequest<ShopWareShop>(`/tenants/${tenantId}/shops/${shopId}`);
}

export async function getCustomer(tenantId: number, customerId: number, shopId?: number): Promise<ShopWareCustomer> {
  return shopWareRequest<ShopWareCustomer>(`/tenants/${tenantId}/customers/${customerId}`, {}, shopId);
}

export async function getCustomers(
  tenantId: number,
  shopId?: number,
  params?: { updated_after?: string; shop_id?: number }
): Promise<ShopWareCustomer[]> {
  const extra: Record<string, string> = {};
  if (params?.updated_after) extra.updated_after = params.updated_after;
  if (params?.shop_id) extra.shop_id = String(params.shop_id);
  return getAllPages<ShopWareCustomer>(`/tenants/${tenantId}/customers`, shopId, extra);
}

export async function getVehicle(tenantId: number, vehicleId: number, shopId?: number): Promise<ShopWareVehicle> {
  return shopWareRequest<ShopWareVehicle>(`/tenants/${tenantId}/vehicles/${vehicleId}`, {}, shopId);
}

export async function getVehicles(
  tenantId: number,
  shopId?: number,
  params?: { updated_after?: string; shop_id?: number }
): Promise<ShopWareVehicle[]> {
  const extra: Record<string, string> = {};
  if (params?.updated_after) extra.updated_after = params.updated_after;
  if (params?.shop_id) extra.shop_id = String(params.shop_id);
  return getAllPages<ShopWareVehicle>(`/tenants/${tenantId}/vehicles`, shopId, extra);
}

export async function searchVehiclesByVin(
  tenantId: number,
  vin: string,
  shopId?: number
): Promise<ShopWareVehicle[]> {
  const all = await getVehicles(tenantId, shopId);
  return all.filter(v => v.vin?.toUpperCase() === vin.toUpperCase());
}

export async function getRepairOrder(
  tenantId: number,
  roId: number,
  shopId?: number,
  associations = 'services,services.labors,services.parts,customer,vehicle'
): Promise<ShopWareRepairOrder> {
  return shopWareRequest<ShopWareRepairOrder>(
    `/tenants/${tenantId}/repair_orders/${roId}?associations=${associations}`,
    {},
    shopId
  );
}

export async function getRepairOrders(
  tenantId: number,
  shopId?: number,
  params?: {
    updated_after?: string;
    closed_after?: string;
    shop_id?: number;
    customer_id?: number;
    vehicle_id?: number;
    associations?: string;
  }
): Promise<ShopWareRepairOrder[]> {
  const extra: Record<string, string> = {
    associations: params?.associations ?? 'services,services.labors,services.parts,customer,vehicle',
  };
  if (params?.updated_after) extra.updated_after = params.updated_after;
  if (params?.closed_after) extra.closed_after = params.closed_after;
  if (params?.shop_id) extra.shop_id = String(params.shop_id);
  if (params?.customer_id) extra.customer_id = String(params.customer_id);
  if (params?.vehicle_id) extra.vehicle_id = String(params.vehicle_id);
  return getAllPages<ShopWareRepairOrder>(`/tenants/${tenantId}/repair_orders`, shopId, extra);
}

export async function getCannedJobs(tenantId: number, shopId?: number): Promise<ShopWareCannedJob[]> {
  return getAllPages<ShopWareCannedJob>(`/tenants/${tenantId}/canned_jobs`, shopId);
}

export async function getRecommendations(
  tenantId: number,
  shopId?: number,
  params?: { updated_after?: string; shop_id?: number }
): Promise<ShopWareRecommendation[]> {
  const extra: Record<string, string> = {};
  if (params?.updated_after) extra.updated_after = params.updated_after;
  if (params?.shop_id) extra.shop_id = String(params.shop_id);
  return getAllPages<ShopWareRecommendation>(`/tenants/${tenantId}/recommendations`, shopId, extra);
}

export async function getPastRecommendations(
  tenantId: number,
  vehicleId: number,
  shopId?: number
): Promise<ShopWarePastRecommendation[]> {
  return getAllPages<ShopWarePastRecommendation>(
    `/tenants/${tenantId}/past_recommendations?vehicle_id=${vehicleId}`,
    shopId
  );
}

export async function testConnection(
  tenantId: number
): Promise<{ ok: boolean; error?: string }> {
  try {
    await getTenant(tenantId);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}
