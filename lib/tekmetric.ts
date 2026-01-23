import { trackApiRequest, acquireDistributedRateLimitSlot } from "@/lib/api-usage-tracker";
import { getValidToken, refreshToken, clearCachedToken } from "@/lib/tekmetric-auth";

const TEKMETRIC_BASE_URL = 'https://shop.tekmetric.com/api/v1';

async function tekmetricRequest(endpoint: string, options: RequestInit = {}, shopId?: number, isRetry = false): Promise<any> {
  // Acquire distributed rate limit slot (blocks if limit exceeded)
  const rateLimitResult = await acquireDistributedRateLimitSlot('tekmetric');
  if (!rateLimitResult.acquired) {
    console.warn(`[Tekmetric] Rate limit slot not acquired after ${rateLimitResult.waitedMs}ms, proceeding anyway`);
  }

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

    // Handle 401 Unauthorized - attempt token refresh
    if (response.status === 401 && !isRetry) {
      console.log('[Tekmetric] Received 401, refreshing token and retrying...');
      clearCachedToken();
      await refreshToken();
      return tekmetricRequest(endpoint, options, shopId, true);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Tekmetric API error ${response.status}: ${errorText}`);
    }

    return response.json();
  } catch (err: any) {
    const latencyMs = Date.now() - startTime;
    trackApiRequest('tekmetric', endpoint, method, statusCode || 0, latencyMs, shopId).catch(() => {});
    throw err;
  }
}

export interface TekmetricShop {
  id: number;
  name: string;
  nickname?: string;
  phone?: string;
  email?: string;
  website?: string;
  address?: {
    address1?: string;
    address2?: string;
    city?: string;
    state?: string;
    zip?: string;
    fullAddress?: string;
  };
}

export interface TekmetricCustomer {
  id: number;
  firstName: string;
  lastName: string;
  email?: string;
  phone?: Array<{
    number: string;
    type: string;
    primary: boolean;
  }>;
  address?: {
    address1?: string;
    city?: string;
    state?: string;
    zip?: string;
    fullAddress?: string;
  };
  shopId: number;
  createdDate?: string;
  updatedDate?: string;
}

export interface TekmetricVehicle {
  id: number;
  customerId: number;
  year?: number;
  make?: string;
  model?: string;
  subModel?: string;
  engine?: string;
  transmission?: string;
  drivetrain?: string;
  vin?: string;
  licensePlate?: string;
  licensePlateState?: string;
  unitNumber?: string;
  color?: string;
  mileageIn?: number;
  mileageOut?: number;
  shopId: number;
  createdDate?: string;
  updatedDate?: string;
}

export interface TekmetricRepairOrder {
  id: number;
  repairOrderNumber: number;
  shopId: number;
  customerId: number;
  vehicleId: number;
  status?: string;
  label?: {
    id?: number;
    text?: string;
    colorCode?: string;
  };
  mileageIn?: number;
  mileageOut?: number;
  poNumber?: string;
  completedDate?: string;
  createdDate?: string;
  updatedDate?: string;
  totalAmount?: number;
  laborAmount?: number;
  partsAmount?: number;
}

export interface TekmetricJob {
  id: number;
  repairOrderId: number;
  name: string;
  authorized: boolean;
  laborAmount?: number;
  partsAmount?: number;
  discountAmount?: number;
  totalAmount?: number;
  createdDate?: string;
  updatedDate?: string;
}

export interface TekmetricCannedJob {
  id: number;
  shopId: number;
  name: string;
  description?: string;
  laborAmount?: number;
  partsAmount?: number;
  totalAmount?: number;
}

export interface PaginatedResponse<T> {
  content: T[];
  totalPages: number;
  totalElements: number;
  size: number;
  number: number;
  first: boolean;
  last: boolean;
}

export async function getShop(shopId: number): Promise<TekmetricShop> {
  return tekmetricRequest(`/shops/${shopId}`, {}, shopId);
}

export async function getShops(): Promise<TekmetricShop[]> {
  return tekmetricRequest('/shops');
}

export async function getCustomers(
  shopId: number,
  params: {
    search?: string;
    page?: number;
    size?: number;
    updatedDateStart?: string;
    updatedDateEnd?: string;
  } = {}
): Promise<PaginatedResponse<TekmetricCustomer>> {
  const queryParams = new URLSearchParams({ shop: shopId.toString() });
  if (params.search) queryParams.set('search', params.search);
  if (params.page !== undefined) queryParams.set('page', params.page.toString());
  if (params.size !== undefined) queryParams.set('size', params.size.toString());
  if (params.updatedDateStart) queryParams.set('updatedDateStart', params.updatedDateStart);
  if (params.updatedDateEnd) queryParams.set('updatedDateEnd', params.updatedDateEnd);
  
  return tekmetricRequest(`/customers?${queryParams}`, {}, shopId);
}

export async function getCustomer(customerId: number): Promise<TekmetricCustomer> {
  return tekmetricRequest(`/customers/${customerId}`);
}

export async function getVehicles(
  shopId: number,
  params: {
    search?: string;
    customerId?: number;
    page?: number;
    size?: number;
    updatedDateStart?: string;
    updatedDateEnd?: string;
  } = {}
): Promise<PaginatedResponse<TekmetricVehicle>> {
  const queryParams = new URLSearchParams({ shop: shopId.toString() });
  if (params.search) queryParams.set('search', params.search);
  if (params.customerId) queryParams.set('customerId', params.customerId.toString());
  if (params.page !== undefined) queryParams.set('page', params.page.toString());
  if (params.size !== undefined) queryParams.set('size', params.size.toString());
  if (params.updatedDateStart) queryParams.set('updatedDateStart', params.updatedDateStart);
  if (params.updatedDateEnd) queryParams.set('updatedDateEnd', params.updatedDateEnd);
  
  return tekmetricRequest(`/vehicles?${queryParams}`, {}, shopId);
}

export async function getVehicle(vehicleId: number, shopId?: number): Promise<TekmetricVehicle> {
  return tekmetricRequest(`/vehicles/${vehicleId}`, {}, shopId);
}

export async function searchVehiclesByVin(shopId: number, vin: string): Promise<PaginatedResponse<TekmetricVehicle>> {
  const queryParams = new URLSearchParams({ 
    shop: shopId.toString(),
    search: vin
  });
  return tekmetricRequest(`/vehicles?${queryParams}`, {}, shopId);
}

export interface TekmetricInspectionItem {
  id: number;
  name?: string;
  status?: string;
  notes?: string;
  categoryId?: number;
  categoryName?: string;
}

export interface TekmetricInspection {
  id: number;
  repairOrderId: number;
  templateId?: number;
  templateName?: string;
  status?: string;
  completedDate?: string;
  createdDate?: string;
  updatedDate?: string;
  items?: TekmetricInspectionItem[];
}

export async function getRepairOrderInspections(repairOrderId: number): Promise<TekmetricInspection[]> {
  try {
    const response = await tekmetricRequest(`/repair-orders/${repairOrderId}/inspections`);
    return response.content || response || [];
  } catch (error: any) {
    console.log(`[Tekmetric] Inspections API returned: ${error.message}`);
    return [];
  }
}

export interface TekmetricRepairOrderFull {
  id: number;
  repairOrderNumber: number;
  shopId: number;
  repairOrderStatus?: {
    id: number;
    code: string;
    name: string;
  };
  repairOrderLabel?: {
    id: number;
    code: string;
    name: string;
  };
  repairOrderCustomLabel?: {
    name: string;
  };
  color?: string;
  customerId: number;
  vehicleId: number;
  milesIn?: number;
  milesOut?: number;
  completedDate?: string;
  postedDate?: string;
  createdDate?: string;
  updatedDate?: string;
  deletedDate?: string;
  jobs?: Array<{
    id: number;
    name: string;
    authorized: boolean;
  }>;
}

export async function getRepairOrders(
  shopId: number,
  params: {
    customerId?: number;
    vehicleId?: number;
    status?: string;
    repairOrderStatusId?: number[];
    page?: number;
    size?: number;
    updatedDateStart?: string;
    updatedDateEnd?: string;
    sort?: string;
    sortDirection?: 'ASC' | 'DESC';
  } = {}
): Promise<PaginatedResponse<TekmetricRepairOrderFull>> {
  const queryParams = new URLSearchParams({ shop: shopId.toString() });
  if (params.customerId) queryParams.set('customerId', params.customerId.toString());
  if (params.vehicleId) queryParams.set('vehicleId', params.vehicleId.toString());
  if (params.status) queryParams.set('status', params.status);
  if (params.repairOrderStatusId) {
    params.repairOrderStatusId.forEach(id => queryParams.append('repairOrderStatusId', id.toString()));
  }
  if (params.page !== undefined) queryParams.set('page', params.page.toString());
  if (params.size !== undefined) queryParams.set('size', params.size.toString());
  if (params.updatedDateStart) queryParams.set('updatedDateStart', params.updatedDateStart);
  if (params.updatedDateEnd) queryParams.set('updatedDateEnd', params.updatedDateEnd);
  if (params.sort) queryParams.set('sort', params.sort);
  if (params.sortDirection) queryParams.set('sortDirection', params.sortDirection);
  
  return tekmetricRequest(`/repair-orders?${queryParams}`, {}, shopId);
}

export async function getRepairOrder(roId: number): Promise<TekmetricRepairOrder> {
  return tekmetricRequest(`/repair-orders/${roId}`);
}

export async function getTekmetricWorkOrderStatus(
  shopId: number,
  workOrderId: string
): Promise<string | null> {
  try {
    const response = await tekmetricRequest(`/repair-orders/${workOrderId}`);
    return response?.repairOrderStatus?.code || response?.repairOrderStatus?.name || response?.status || null;
  } catch (err) {
    console.error("Error fetching Tekmetric RO status:", err);
    return null;
  }
}

export async function getTekmetricWorkOrderWithMileage(
  workOrderId: string
): Promise<{ status: string | null; mileageIn: number | null; mileageOut: number | null } | null> {
  try {
    const response = await tekmetricRequest(`/repair-orders/${workOrderId}`);
    return {
      status: response?.repairOrderStatus?.code || response?.repairOrderStatus?.name || response?.status || null,
      mileageIn: response?.milesIn || response?.mileageIn || null,
      mileageOut: response?.milesOut || response?.mileageOut || null
    };
  } catch (err) {
    console.error("Error fetching Tekmetric RO with mileage:", err);
    return null;
  }
}

export async function getJobs(
  shopId: number,
  params: {
    repairOrderId?: number;
    page?: number;
    size?: number;
  } = {}
): Promise<PaginatedResponse<TekmetricJob>> {
  const queryParams = new URLSearchParams({ shop: shopId.toString() });
  if (params.repairOrderId) queryParams.set('repairOrderId', params.repairOrderId.toString());
  if (params.page !== undefined) queryParams.set('page', params.page.toString());
  if (params.size !== undefined) queryParams.set('size', params.size.toString());
  
  return tekmetricRequest(`/jobs?${queryParams}`);
}

export async function getCannedJobs(
  shopId: number,
  params: {
    page?: number;
    size?: number;
  } = {}
): Promise<PaginatedResponse<TekmetricCannedJob>> {
  const queryParams = new URLSearchParams({ shop: shopId.toString() });
  if (params.page !== undefined) queryParams.set('page', params.page.toString());
  if (params.size !== undefined) queryParams.set('size', params.size.toString());
  
  return tekmetricRequest(`/canned-jobs?${queryParams}`);
}

export async function addCannedJobsToRepairOrder(
  repairOrderId: number,
  cannedJobIds: number[]
): Promise<any> {
  return tekmetricRequest(`/repair-orders/${repairOrderId}/canned-jobs`, {
    method: 'POST',
    body: JSON.stringify({ cannedJobIds }),
  });
}

export async function validateShopAccess(shopId: number): Promise<{ valid: boolean; shop?: TekmetricShop; error?: string }> {
  try {
    const shop = await getShop(shopId);
    return { valid: true, shop };
  } catch (error: any) {
    if (error.message?.includes('403') || error.message?.includes('Forbidden')) {
      return { valid: false, error: 'Shop not authorized for this API token' };
    }
    if (error.message?.includes('404')) {
      return { valid: false, error: 'Shop not found' };
    }
    return { valid: false, error: error.message || 'Failed to validate shop access' };
  }
}

// ============= Appointment Functions =============

export interface TekmetricAppointment {
  id: number;
  shopId: number;
  customerId: number;
  vehicleId: number;
  startTime: string;
  endTime: string;
  title?: string;
  note?: string;
  color?: string;
  appointmentType?: string;
  createdDate?: string;
  updatedDate?: string;
}

export interface CreateAppointmentParams {
  shopId: number;
  customerId: number;
  vehicleId: number;
  startTime: string; // ISO 8601 format
  endTime: string; // ISO 8601 format
  title?: string;
  note?: string;
  color?: string;
}

export async function createAppointment(params: CreateAppointmentParams): Promise<TekmetricAppointment> {
  const { shopId, customerId, vehicleId, startTime, endTime, title, note, color } = params;
  
  const body: Record<string, any> = {
    shopId,
    customerId,
    vehicleId,
    startTime,
    endTime,
  };
  
  if (title) body.title = title;
  if (note) body.note = note;
  if (color) body.color = color;
  
  console.log(`[Tekmetric] Creating appointment for customer ${customerId}, vehicle ${vehicleId} at ${startTime}`);
  
  const result = await tekmetricRequest('/appointments', {
    method: 'POST',
    body: JSON.stringify(body),
  }, shopId);
  
  console.log(`[Tekmetric] Appointment created with ID: ${result.id}`);
  return result;
}

export async function getAppointment(appointmentId: number): Promise<TekmetricAppointment> {
  return tekmetricRequest(`/appointments/${appointmentId}`);
}

export async function updateAppointment(
  appointmentId: number,
  updates: Partial<Omit<CreateAppointmentParams, 'shopId'>>
): Promise<TekmetricAppointment> {
  return tekmetricRequest(`/appointments/${appointmentId}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

export async function deleteAppointment(appointmentId: number): Promise<void> {
  await tekmetricRequest(`/appointments/${appointmentId}`, {
    method: 'DELETE',
  });
}

export async function getAppointments(
  shopId: number,
  params: {
    startTime?: string;
    endTime?: string;
    customerId?: number;
    vehicleId?: number;
    page?: number;
    size?: number;
  } = {}
): Promise<PaginatedResponse<TekmetricAppointment>> {
  const queryParams = new URLSearchParams({ shop: shopId.toString() });
  if (params.startTime) queryParams.set('startTime', params.startTime);
  if (params.endTime) queryParams.set('endTime', params.endTime);
  if (params.customerId) queryParams.set('customerId', params.customerId.toString());
  if (params.vehicleId) queryParams.set('vehicleId', params.vehicleId.toString());
  if (params.page !== undefined) queryParams.set('page', params.page.toString());
  if (params.size !== undefined) queryParams.set('size', params.size.toString());
  
  return tekmetricRequest(`/appointments?${queryParams}`, {}, shopId);
}
