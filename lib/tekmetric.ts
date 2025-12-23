const TEKMETRIC_BASE_URL = 'https://shop.tekmetric.com/api/v1';

function getApiToken(): string {
  const token = process.env.TEKMETRIC_API_TOKEN;
  if (!token) {
    throw new Error('TEKMETRIC_API_TOKEN not configured');
  }
  return token;
}

async function tekmetricRequest(endpoint: string, options: RequestInit = {}) {
  const token = getApiToken();
  
  const response = await fetch(`${TEKMETRIC_BASE_URL}${endpoint}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Tekmetric API error ${response.status}: ${errorText}`);
  }

  return response.json();
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
  return tekmetricRequest(`/shops/${shopId}`);
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
  
  return tekmetricRequest(`/customers?${queryParams}`);
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
  
  return tekmetricRequest(`/vehicles?${queryParams}`);
}

export async function getVehicle(vehicleId: number): Promise<TekmetricVehicle> {
  return tekmetricRequest(`/vehicles/${vehicleId}`);
}

export async function getRepairOrders(
  shopId: number,
  params: {
    customerId?: number;
    vehicleId?: number;
    status?: string;
    page?: number;
    size?: number;
    updatedDateStart?: string;
    updatedDateEnd?: string;
    sort?: string;
    sortDirection?: 'ASC' | 'DESC';
  } = {}
): Promise<PaginatedResponse<TekmetricRepairOrder>> {
  const queryParams = new URLSearchParams({ shop: shopId.toString() });
  if (params.customerId) queryParams.set('customerId', params.customerId.toString());
  if (params.vehicleId) queryParams.set('vehicleId', params.vehicleId.toString());
  if (params.status) queryParams.set('status', params.status);
  if (params.page !== undefined) queryParams.set('page', params.page.toString());
  if (params.size !== undefined) queryParams.set('size', params.size.toString());
  if (params.updatedDateStart) queryParams.set('updatedDateStart', params.updatedDateStart);
  if (params.updatedDateEnd) queryParams.set('updatedDateEnd', params.updatedDateEnd);
  if (params.sort) queryParams.set('sort', params.sort);
  if (params.sortDirection) queryParams.set('sortDirection', params.sortDirection);
  
  return tekmetricRequest(`/repair-orders?${queryParams}`);
}

export async function getRepairOrder(roId: number): Promise<TekmetricRepairOrder> {
  return tekmetricRequest(`/repair-orders/${roId}`);
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
