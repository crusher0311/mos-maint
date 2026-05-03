import { tekmetricRequest } from "./client";
import type {
  TekmetricJob,
  TekmetricAppointment,
  CreateAppointmentParams,
  PaginatedResponse,
} from "./types";

export interface TekmetricInventoryPart {
  id: number;
  name?: string;
  partNumber?: string;
  brand?: string;
  description?: string;
  partTypeId: number;
  shopId: number;
  cost?: number;
  retail?: number;
  min?: number | null;
  max?: number | null;
  inStock?: number;
  binNumber?: string;
  alternatePartNumber?: string;
  oemPartNumber?: string;
  width?: string | null;
  ratio?: number | null;
  diameter?: number | null;
  deletedDate?: string | null;
}

export async function getInventory(
  shopId: number,
  params: {
    partTypeId: 1 | 2 | 5;
    page?: number;
    size?: number;
    sort?: string;
    sortDirection?: 'ASC' | 'DESC';
  }
): Promise<PaginatedResponse<TekmetricInventoryPart>> {
  const queryParams = new URLSearchParams({
    shop: shopId.toString(),
    partTypeId: params.partTypeId.toString(),
  });
  if (params.page !== undefined) queryParams.set('page', params.page.toString());
  if (params.size !== undefined) queryParams.set('size', params.size.toString());
  if (params.sort) queryParams.set('sort', params.sort);
  if (params.sortDirection) queryParams.set('sortDirection', params.sortDirection);
  return tekmetricRequest(`/inventory?${queryParams}`, {}, shopId);
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

// Bulk shop-level /jobs fetch (task #146).
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

export async function addCannedJobsToRepairOrder(
  repairOrderId: number,
  cannedJobIds: number[],
  shopId?: number,
): Promise<any> {
  return tekmetricRequest(`/repair-orders/${repairOrderId}/canned-jobs`, {
    method: 'POST',
    body: JSON.stringify(cannedJobIds),
  }, shopId);
}

// ============= Appointment Functions =============

export async function createAppointment(params: CreateAppointmentParams): Promise<TekmetricAppointment> {
  const { shopId, customerId, vehicleId, startTime, endTime, title, description, color, dropoffTime, pickupTime, rideOption, status, appointmentOptionId } = params;
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
  if (appointmentOptionId) body.appointmentOptionId = appointmentOptionId;
  const savedAppointmentOptionId = appointmentOptionId;

  console.log(`[Tekmetric] Creating appointment for customer ${customerId}, vehicle ${vehicleId} at ${startTime}`);
  console.log(`[Tekmetric] Appointment body:`, JSON.stringify(body, null, 2));

  const result = await tekmetricRequest(`/appointments?shop=${shopId}`, {
    method: 'POST',
    body: JSON.stringify(body),
  }, shopId);

  const appointmentId = result.data || result.id;
  console.log(`[Tekmetric] Appointment created with ID: ${appointmentId}`);

  if (savedAppointmentOptionId && appointmentId) {
    const optionMap: Record<number, { id: number; code: string; name: string }> = {
      1: { id: 1, code: "STAY", name: "Stay With Vehicle" },
      2: { id: 2, code: "DROP", name: "Drop-off Vehicle" },
      3: { id: 3, code: "TOW", name: "Towed-in Vehicle" },
    };
    const appointmentOptionObj = optionMap[savedAppointmentOptionId] || optionMap[1];
    console.log(`[Tekmetric] Updating appointment ${appointmentId} with appointmentOption:`, appointmentOptionObj);
    try {
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
