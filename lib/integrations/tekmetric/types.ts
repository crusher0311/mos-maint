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
  laborAmount?: number;
  partsAmount?: number;
}

export interface TekmetricInspectionItem {
  id: number;
  name: string;
  status: 'good' | 'bad' | 'marginal' | 'not_inspected';
  notes?: string;
  mediaUrls?: string[];
}

export interface TekmetricInspection {
  id: number;
  repairOrderId: number;
  status: string;
  createdDate?: string;
  updatedDate?: string;
  items?: TekmetricInspectionItem[];
}

export interface TekmetricRepairOrderFull extends TekmetricRepairOrder {
  vehicle?: TekmetricVehicle;
  customer?: TekmetricCustomer;
  jobs?: TekmetricJob[];
  inspections?: TekmetricInspection[];
}

export interface PaginatedResponse<T> {
  content: T[];
  totalElements: number;
  totalPages: number;
  size: number;
  number: number;
  numberOfElements: number;
  first: boolean;
  last: boolean;
}

export interface TekmetricAppointment {
  id: number;
  shopId: number;
  customerId?: number;
  vehicleId?: number;
  repairOrderId?: number;
  startTime: string;
  endTime: string;
  type: string;
  status: string;
  notes?: string;
  createdDate?: string;
  updatedDate?: string;
}

export interface CreateAppointmentParams {
  shopId: number;
  customerId?: number;
  vehicleId?: number;
  startTime: string;
  endTime: string;
  type: 'DROP_OFF' | 'WAITER' | 'PICKUP';
  notes?: string;
}
