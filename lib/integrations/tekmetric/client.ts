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
const TEKMETRIC_INTERNAL_BASE_URL = 'https://shop.tekmetric.com/api';

let tekmetricApiCallCounter = 0;
// Cumulative time spent in `await new Promise(r => setTimeout(r, backoffMs))`
// after a 429. Surfaced per-chunk in the backfill metrics so a regression in
// rate-limit health (e.g. cache miss spike re-saturating the per-IP throttle)
// is visible in the admin sync-health view without grepping cron logs.
let tekmetric429BackoffMs = 0;

export function getTekmetricApiCallCount(): number {
  return tekmetricApiCallCounter;
}

export function resetTekmetricApiCallCount(): number {
  const count = tekmetricApiCallCounter;
  tekmetricApiCallCounter = 0;
  return count;
}

export function getTekmetric429BackoffMs(): number {
  return tekmetric429BackoffMs;
}

export function resetTekmetric429BackoffMs(): number {
  const ms = tekmetric429BackoffMs;
  tekmetric429BackoffMs = 0;
  return ms;
}

const MAX_429_RETRIES = 5;
const MAX_BACKOFF_MS = 60_000;

function compute429Backoff(attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const seconds = parseInt(retryAfterHeader, 10);
    if (!isNaN(seconds) && seconds > 0) {
      return Math.min(seconds * 1000 + Math.random() * 1000, MAX_BACKOFF_MS);
    }
  }
  const exponential = Math.pow(2, attempt) * 1000;
  const jitter = Math.random() * 1000;
  return Math.min(exponential + jitter, MAX_BACKOFF_MS);
}

export async function tekmetricRequest<T = any>(
  endpoint: string, 
  options: RequestInit = {}, 
  shopId?: number, 
  authRetry = false
): Promise<T> {
  const method = options.method || 'GET';

  for (let attempt = 1; attempt <= MAX_429_RETRIES + 1; attempt++) {
    // Local cap reduced 10→5 rps to stay below Tekmetric's per-IP throttle.
    // Combined with the distributed limiter and the tighter incremental-sync
    // cadence, this materially reduces the 429 rate observed in production.
    const rateSlot = await acquireRateLimitSlot('tekmetric', 5);
    if (!rateSlot.acquired) {
      throw new Error(`[Tekmetric] Rate limit budget exhausted (waited ${rateSlot.waitedMs}ms). Request to ${endpoint} rejected to prevent 429 errors.`);
    }
    tekmetricApiCallCounter++;

    const token = await getValidToken();
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

      if (response.status === 401 && !authRetry) {
        console.log('[Tekmetric] Received 401, refreshing token and retrying...');
        clearCachedToken();
        await refreshToken();
        return tekmetricRequest<T>(endpoint, options, shopId, true);
      }

      if (response.status === 429 && attempt <= MAX_429_RETRIES) {
        const retryAfter = response.headers.get('Retry-After');
        const backoffMs = compute429Backoff(attempt, retryAfter);
        console.warn(`[Tekmetric] 429 on ${endpoint} (attempt ${attempt}/${MAX_429_RETRIES}), backing off ${Math.round(backoffMs)}ms${retryAfter ? ` (Retry-After=${retryAfter})` : ''}`);
        tekmetric429BackoffMs += backoffMs;
        await new Promise(r => setTimeout(r, backoffMs));
        continue;
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

  throw new Error(`Tekmetric API error 429: exceeded ${MAX_429_RETRIES} retries on ${endpoint}`);
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

export async function getRepairOrderInspections(
  repairOrderId: number, 
  tekmetricShopId: number
): Promise<TekmetricInspection[]> {
  return [];
}

export async function getRepairOrderInspectionsWithXAuth(
  repairOrderId: number, 
  tekmetricShopId: number,
  xAuthToken: string
): Promise<TekmetricInspection[]> {
  if (!tekmetricShopId || !xAuthToken) {
    return [];
  }
  
  const url = `${TEKMETRIC_INTERNAL_BASE_URL}/shop/${tekmetricShopId}/repair-orders/${repairOrderId}/inspections`;
  const endpointPath = `/shop/${tekmetricShopId}/repair-orders/${repairOrderId}/inspections`;

  for (let attempt = 1; attempt <= MAX_429_RETRIES + 1; attempt++) {
    try {
      const rateSlot = await acquireRateLimitSlot('tekmetric', 5);
      if (!rateSlot.acquired) {
        console.warn(`[Tekmetric] Rate limit exhausted for inspection fetch RO ${repairOrderId}`);
        return [];
      }
      tekmetricApiCallCounter++;

      const startTime = Date.now();
      const response = await fetch(url, {
        cache: 'no-store',
        headers: {
          'x-auth-token': xAuthToken,
          'Content-Type': 'application/json',
        },
      });

      const latencyMs = Date.now() - startTime;
      trackApiRequest('tekmetric', endpointPath, 'GET', response.status, latencyMs, tekmetricShopId).catch(() => {});

      if (response.status === 429 && attempt <= MAX_429_RETRIES) {
        const retryAfter = response.headers.get('Retry-After');
        const backoffMs = compute429Backoff(attempt, retryAfter);
        console.warn(`[Tekmetric] 429 on inspection fetch RO ${repairOrderId} (attempt ${attempt}/${MAX_429_RETRIES}), backing off ${Math.round(backoffMs)}ms${retryAfter ? ` (Retry-After=${retryAfter})` : ''}`);
        tekmetric429BackoffMs += backoffMs;
        await new Promise(r => setTimeout(r, backoffMs));
        continue;
      }

      if (!response.ok) {
        if (response.status !== 401 && response.status !== 403) {
          console.warn(`[Tekmetric] Inspection fetch failed for RO ${repairOrderId}: ${response.status}`);
        }
        return [];
      }

      return response.json();
    } catch (err: any) {
      console.warn(`[Tekmetric] Inspection fetch error for RO ${repairOrderId}: ${err.message}`);
      return [];
    }
  }

  console.warn(`[Tekmetric] Inspection fetch RO ${repairOrderId} exceeded ${MAX_429_RETRIES} retries`);
  return [];
}

export function mapInspectionRatingToStatus(code: string): 'good' | 'bad' | 'marginal' | 'not_inspected' {
  switch (code) {
    case 'CHCKD': return 'good';
    case 'RQRSATTN': return 'bad';
    case 'MAYRQRATTN': return 'marginal';
    case 'NA': return 'not_inspected';
    default: return 'not_inspected';
  }
}

export function flattenInspectionTasks(inspections: TekmetricInspection[]): Array<{
  name: string;
  status: 'good' | 'bad' | 'marginal' | 'not_inspected';
  finding: string | null;
  group: string;
  reported: boolean;
  ratingCode: string;
  ratingName: string;
  taskId: number;
}> {
  const tasks: Array<{
    name: string;
    status: 'good' | 'bad' | 'marginal' | 'not_inspected';
    finding: string | null;
    group: string;
    reported: boolean;
    ratingCode: string;
    ratingName: string;
    taskId: number;
  }> = [];

  for (const inspection of inspections) {
    for (const group of inspection.inspectionTasks || []) {
      for (const task of group.tasks || []) {
        tasks.push({
          name: task.name,
          status: mapInspectionRatingToStatus(task.inspectionRating?.code),
          finding: task.finding,
          group: group.title || task.inspectionGroup,
          reported: task.reported,
          ratingCode: task.inspectionRating?.code,
          ratingName: task.inspectionRating?.name,
          taskId: task.id,
        });
      }
    }
  }

  return tasks;
}

export async function getRepairOrderInspectionStatus(repairOrderId: number, shopId?: number): Promise<{
  hasInspection: boolean;
  inspectionShared: boolean;
  inspectionShareDate: string | null;
  inspectionUrl: string | null;
}> {
  try {
    const ro = await tekmetricRequest<any>(`/repair-orders/${repairOrderId}`, {}, shopId);
    return {
      hasInspection: !!ro?.inspectionUrl,
      inspectionShared: !!ro?.inspectionShareDate,
      inspectionShareDate: ro?.inspectionShareDate || null,
      inspectionUrl: ro?.inspectionUrl || null,
    };
  } catch (err: any) {
    return { hasInspection: false, inspectionShared: false, inspectionShareDate: null, inspectionUrl: null };
  }
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
