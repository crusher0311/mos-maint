import { trackApiRequest } from "@/lib/api-usage-tracker";
import { acquireRateLimitSlot } from "@/lib/integrations/core/rate-limiter";
import { getValidToken, refreshToken, clearCachedToken, isConfigured } from "./auth";
import type { 
  TekmetricShop, 
  TekmetricCustomer, 
  TekmetricVehicle, 
  TekmetricRepairOrder,
  TekmetricJob,
  TekmetricCannedJob,
  TekmetricInspection,
  PaginatedResponse,
} from "./types";

const TEKMETRIC_BASE_URL = 'https://shop.tekmetric.com/api/v1';

let tekmetricApiCallCounter = 0;

export function getTekmetricApiCallCount(): number {
  return tekmetricApiCallCounter;
}

export function resetTekmetricApiCallCount(): number {
  const count = tekmetricApiCallCounter;
  tekmetricApiCallCounter = 0;
  return count;
}

export async function tekmetricRequest<T = any>(
  endpoint: string, 
  options: RequestInit = {}, 
  shopId?: number, 
  isRetry = false
): Promise<T> {
  const rateSlot = await acquireRateLimitSlot('tekmetric', 10);
  if (!rateSlot.acquired) {
    throw new Error(`[Tekmetric] Rate limit budget exhausted (waited ${rateSlot.waitedMs}ms). Request to ${endpoint} rejected to prevent 429 errors.`);
  }
  tekmetricApiCallCounter++;

  const token = await getValidToken();
  const method = options.method || 'GET';
  const startTime = Date.now();
  
  let statusCode = 0;
  try {
    const response = await fetch(`${TEKMETRIC_BASE_URL}${endpoint}`, {
      ...options,
      cache: 'no-store',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    statusCode = response.status;
    const latencyMs = Date.now() - startTime;
    
    trackApiRequest('tekmetric', endpoint, method, statusCode, latencyMs, shopId).catch(() => {});

    if (response.status === 401 && !isRetry) {
      console.log('[Tekmetric] Received 401, refreshing token and retrying...');
      clearCachedToken();
      await refreshToken();
      return tekmetricRequest<T>(endpoint, options, shopId, true);
    }

    if (response.status === 429 && !isRetry) {
      const backoffMs = Math.min(5000 + Math.random() * 2000, 10000);
      console.warn(`[Tekmetric] 429 rate limited on ${endpoint}, backing off ${Math.round(backoffMs)}ms`);
      await new Promise(r => setTimeout(r, backoffMs));
      return tekmetricRequest<T>(endpoint, options, shopId, true);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Tekmetric API error ${response.status}: ${errorText}`);
    }

    return response.json();
  } catch (err: any) {
    if (!statusCode) {
      const latencyMs = Date.now() - startTime;
      trackApiRequest('tekmetric', endpoint, method, 0, latencyMs, shopId).catch(() => {});
    }
    throw err;
  }
}

export async function getShop(shopId: number): Promise<TekmetricShop> {
  return tekmetricRequest<TekmetricShop>(`/shops/${shopId}`, {}, shopId);
}

export async function getShops(): Promise<TekmetricShop[]> {
  return tekmetricRequest<TekmetricShop[]>('/shops');
}

export async function getCustomers(
  shopId: number,
  options?: { page?: number; size?: number; search?: string }
): Promise<PaginatedResponse<TekmetricCustomer>> {
  const params = new URLSearchParams();
  params.set('shop', String(shopId));
  if (options?.page !== undefined) params.set('page', String(options.page));
  if (options?.size !== undefined) params.set('size', String(options.size));
  if (options?.search) params.set('search', options.search);
  
  return tekmetricRequest<PaginatedResponse<TekmetricCustomer>>(`/customers?${params.toString()}`, {}, shopId);
}

export async function getCustomer(customerId: number, shopId?: number): Promise<TekmetricCustomer> {
  return tekmetricRequest<TekmetricCustomer>(`/customers/${customerId}`, {}, shopId);
}

export async function getVehicles(
  shopId: number,
  options?: { page?: number; size?: number; customerId?: number }
): Promise<PaginatedResponse<TekmetricVehicle>> {
  const params = new URLSearchParams();
  params.set('shop', String(shopId));
  if (options?.page !== undefined) params.set('page', String(options.page));
  if (options?.size !== undefined) params.set('size', String(options.size));
  if (options?.customerId) params.set('customerId', String(options.customerId));
  
  return tekmetricRequest<PaginatedResponse<TekmetricVehicle>>(`/vehicles?${params.toString()}`, {}, shopId);
}

export async function getVehicle(vehicleId: number, shopId?: number): Promise<TekmetricVehicle> {
  return tekmetricRequest<TekmetricVehicle>(`/vehicles/${vehicleId}`, {}, shopId);
}

export async function searchVehiclesByVin(shopId: number, vin: string): Promise<PaginatedResponse<TekmetricVehicle>> {
  const params = new URLSearchParams();
  params.set('shop', String(shopId));
  params.set('search', vin);
  
  return tekmetricRequest<PaginatedResponse<TekmetricVehicle>>(`/vehicles?${params.toString()}`, {}, shopId);
}

export async function getRepairOrders(
  shopId: number,
  options?: { 
    page?: number; 
    size?: number; 
    vehicleId?: number; 
    customerId?: number;
    status?: string;
    updatedAfter?: Date;
    updatedBefore?: Date;
  }
): Promise<PaginatedResponse<TekmetricRepairOrder>> {
  const params = new URLSearchParams();
  params.set('shop', String(shopId));
  if (options?.page !== undefined) params.set('page', String(options.page));
  if (options?.size !== undefined) params.set('size', String(options.size));
  if (options?.vehicleId) params.set('vehicleId', String(options.vehicleId));
  if (options?.customerId) params.set('customerId', String(options.customerId));
  if (options?.status) params.set('status', options.status);
  if (options?.updatedAfter) params.set('updatedDateStart', options.updatedAfter.toISOString().split('T')[0]);
  if (options?.updatedBefore) params.set('updatedDateEnd', options.updatedBefore.toISOString().split('T')[0]);
  
  return tekmetricRequest<PaginatedResponse<TekmetricRepairOrder>>(`/repair-orders?${params.toString()}`, {}, shopId);
}

export async function getRepairOrder(roId: number, shopId?: number): Promise<TekmetricRepairOrder> {
  return tekmetricRequest<TekmetricRepairOrder>(`/repair-orders/${roId}`, {}, shopId);
}

export async function getJobs(
  repairOrderId: number,
  shopId?: number
): Promise<PaginatedResponse<TekmetricJob>> {
  return tekmetricRequest<PaginatedResponse<TekmetricJob>>(`/jobs?repairOrder=${repairOrderId}`, {}, shopId);
}

export async function getCannedJobs(
  shopId: number,
  options?: { page?: number; size?: number }
): Promise<PaginatedResponse<TekmetricCannedJob>> {
  const params = new URLSearchParams();
  params.set('shop', String(shopId));
  if (options?.page !== undefined) params.set('page', String(options.page));
  if (options?.size !== undefined) params.set('size', String(options.size));
  
  return tekmetricRequest<PaginatedResponse<TekmetricCannedJob>>(`/canned-jobs?${params.toString()}`, {}, shopId);
}

export async function getRepairOrderInspections(repairOrderId: number, shopId?: number): Promise<TekmetricInspection[]> {
  return [];
}

export async function validateShopAccess(shopId: number): Promise<{ valid: boolean; shop?: TekmetricShop; error?: string }> {
  try {
    const shop = await getShop(shopId);
    return { valid: true, shop };
  } catch (err: any) {
    return { valid: false, error: err.message };
  }
}

export async function testConnection(shopId: number): Promise<{ ok: boolean; error?: string }> {
  if (!isConfigured()) {
    return { ok: false, error: 'Tekmetric credentials not configured' };
  }
  
  try {
    const result = await validateShopAccess(shopId);
    if (!result.valid) {
      return { ok: false, error: result.error || 'Shop access validation failed' };
    }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

export { isConfigured };
