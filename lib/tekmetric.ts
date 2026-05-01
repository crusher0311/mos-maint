import { tekmetricRequest } from "@/lib/integrations/tekmetric/client";

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

export async function getCustomer(customerId: number, shopId?: number): Promise<TekmetricCustomer> {
  return tekmetricRequest(`/customers/${customerId}`, {}, shopId);
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
  return [];
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

export async function getRepairOrder(roId: number, shopId?: number): Promise<TekmetricRepairOrder> {
  return tekmetricRequest(`/repair-orders/${roId}`, {}, shopId);
}

export async function getTekmetricWorkOrderStatus(
  shopId: number,
  workOrderId: string
): Promise<string | null> {
  try {
    const response = await tekmetricRequest(`/repair-orders/${workOrderId}`, {}, shopId);
    return response?.repairOrderStatus?.code || response?.repairOrderStatus?.name || response?.status || null;
  } catch (err) {
    console.error("Error fetching Tekmetric RO status:", err);
    return null;
  }
}

export async function getTekmetricWorkOrderWithMileage(
  workOrderId: string,
  shopId?: number,
): Promise<{ status: string | null; mileageIn: number | null; mileageOut: number | null } | null> {
  try {
    const response = await tekmetricRequest(`/repair-orders/${workOrderId}`, {}, shopId);
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
  
  return tekmetricRequest(`/jobs?${queryParams}`, {}, shopId);
}

// Bulk shop-level /jobs fetch (task #146). Tekmetric's /jobs endpoint
// accepts `shop` plus `updatedDateStart/End` (or `authorizedDateStart/End`)
// and returns 100 jobs per page across many ROs in a single call. A shop
// with ~25k historical jobs can therefore be pulled in ~250 paged calls
// instead of one-call-per-RO (typical 20-30x reduction). The shape mirrors
// `getRepairOrders` so callers can iterate the same way. Each returned
// `TekmetricJob` carries `repairOrderId` so the caller can group by RO
// and seed `tekmetric_jobs_cache`.
export async function getJobsByShopWindow(
  shopId: number,
  params: {
    page?: number;
    size?: number;
    updatedDateStart?: string;
    updatedDateEnd?: string;
    authorizedDateStart?: string;
    authorizedDateEnd?: string;
    sort?: string;
    sortDirection?: 'ASC' | 'DESC';
  } = {}
): Promise<PaginatedResponse<TekmetricJob>> {
  const queryParams = new URLSearchParams({ shop: shopId.toString() });
  if (params.page !== undefined) queryParams.set('page', params.page.toString());
  if (params.size !== undefined) queryParams.set('size', params.size.toString());
  if (params.updatedDateStart) queryParams.set('updatedDateStart', params.updatedDateStart);
  if (params.updatedDateEnd) queryParams.set('updatedDateEnd', params.updatedDateEnd);
  if (params.authorizedDateStart) queryParams.set('authorizedDateStart', params.authorizedDateStart);
  if (params.authorizedDateEnd) queryParams.set('authorizedDateEnd', params.authorizedDateEnd);
  if (params.sort) queryParams.set('sort', params.sort);
  if (params.sortDirection) queryParams.set('sortDirection', params.sortDirection);

  return tekmetricRequest(`/jobs?${queryParams}`, {}, shopId);
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
  
  return tekmetricRequest(`/canned-jobs?${queryParams}`, {}, shopId);
}

export async function addCannedJobsToRepairOrder(
  repairOrderId: number,
  cannedJobIds: number[],
  shopId?: number,
): Promise<any> {
  // Tekmetric API expects an array of canned job IDs directly, not an object
  return tekmetricRequest(`/repair-orders/${repairOrderId}/canned-jobs`, {
    method: 'POST',
    body: JSON.stringify(cannedJobIds),
  }, shopId);
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
  description?: string;
  color?: string;
  dropoffTime?: string; // ISO 8601 format
  pickupTime?: string; // ISO 8601 format
  rideOption?: "LOANER" | "RIDE" | "NONE";
  status?: "NONE" | "ARRIVED" | "NO_SHOW" | "CANCELLED";
  appointmentOption?: "STAY" | "DROP" | "TOW"; // STAY = Stay With Vehicle, DROP = Drop-off, TOW = Towed-in
  appointmentOptionId?: number; // 1=STAY, 2=DROP, 3=TOW - alternative ID-based field
}

export async function createAppointment(params: CreateAppointmentParams): Promise<TekmetricAppointment> {
  const { shopId, customerId, vehicleId, startTime, endTime, title, description, color, dropoffTime, pickupTime, rideOption, status, appointmentOption, appointmentOptionId } = params;
  
  const body: Record<string, any> = {
    shopId,
    customerId,
    vehicleId,
    startTime,
    endTime,
  };
  
  if (title) body.title = title;
  if (description) body.description = description;
  if (color) body.color = color;
  if (dropoffTime) body.dropoffTime = dropoffTime;
  if (pickupTime) body.pickupTime = pickupTime;
  if (rideOption) body.rideOption = rideOption;
  if (status) body.status = status;
  // Try including appointmentOptionId in the create request
  if (appointmentOptionId) body.appointmentOptionId = appointmentOptionId;
  const savedAppointmentOptionId = appointmentOptionId;
  
  console.log(`[Tekmetric] Creating appointment for customer ${customerId}, vehicle ${vehicleId} at ${startTime}`);
  console.log(`[Tekmetric] Appointment body:`, JSON.stringify(body, null, 2));
  
  // Tekmetric's POST /appointments requires `?shop={id}` to establish the
  // shop auth context — without it the API returns 401 "Missing credentials"
  // even with a valid Bearer token. (Reads have always passed `?shop=` via
  // their helpers; the original write helper omitted it, which only became
  // visible once the appointment-migration script tried to write at scale.)
  const result = await tekmetricRequest(`/appointments?shop=${shopId}`, {
    method: 'POST',
    body: JSON.stringify(body),
  }, shopId);
  
  const appointmentId = result.data || result.id;
  console.log(`[Tekmetric] Appointment created with ID: ${appointmentId}`);
  
  // If appointmentOption was requested, update the appointment via PATCH
  if (savedAppointmentOptionId && appointmentId) {
    const optionMap: Record<number, { id: number; code: string; name: string }> = {
      1: { id: 1, code: "STAY", name: "Stay With Vehicle" },
      2: { id: 2, code: "DROP", name: "Drop-off Vehicle" },
      3: { id: 3, code: "TOW", name: "Towed-in Vehicle" },
    };
    const appointmentOptionObj = optionMap[savedAppointmentOptionId] || optionMap[1];
    
    console.log(`[Tekmetric] Updating appointment ${appointmentId} with appointmentOption:`, appointmentOptionObj);
    
    try {
      // Try sending just the appointmentOptionId instead of the full object
      const patchBody = { appointmentOptionId: savedAppointmentOptionId };
      console.log(`[Tekmetric] PATCH body:`, JSON.stringify(patchBody));
      const patchResult = await tekmetricRequest(`/appointments/${appointmentId}`, {
        method: 'PATCH',
        body: JSON.stringify(patchBody),
      }, shopId);
      console.log(`[Tekmetric] PATCH response:`, JSON.stringify(patchResult, null, 2));
    } catch (patchError: any) {
      console.error(`[Tekmetric] Failed to update appointment option:`, patchError?.message || patchError);
    }
  }
  
  return { ...result, id: appointmentId };
}

export async function getAppointment(appointmentId: number, shopId?: number): Promise<TekmetricAppointment> {
  return tekmetricRequest(`/appointments/${appointmentId}`, {}, shopId);
}

export async function updateAppointment(
  appointmentId: number,
  updates: Partial<Omit<CreateAppointmentParams, 'shopId'>>,
  shopId?: number,
): Promise<TekmetricAppointment> {
  return tekmetricRequest(`/appointments/${appointmentId}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  }, shopId);
}

export async function deleteAppointment(appointmentId: number, shopId?: number): Promise<void> {
  await tekmetricRequest(`/appointments/${appointmentId}`, {
    method: 'DELETE',
  }, shopId);
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
