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
  // Tekmetric's richer status/label associations returned on the RO
  // detail endpoint. `status` (above) is the legacy string form; these
  // carry the structured `{ id, code, name }` objects the sync writers read.
  repairOrderStatus?: {
    id?: number;
    code?: string;
    name?: string;
  };
  repairOrderLabel?: {
    id?: number;
    code?: string;
    name?: string;
  };
  repairOrderCustomLabel?: {
    id?: number;
    code?: string;
    name?: string;
  };
  color?: string;
  mileageIn?: number;
  mileageOut?: number;
  // Odometer readings as returned on the RO detail endpoint (distinct from
  // the vehicle-level mileageIn/mileageOut).
  milesIn?: number;
  milesOut?: number;
  poNumber?: string;
  completedDate?: string;
  postedDate?: string;
  createdDate?: string;
  updatedDate?: string;
  totalAmount?: number;
  laborAmount?: number;
  partsAmount?: number;
  serviceWriterId?: number;
  serviceWriter?: { id?: number; name?: string; fullName?: string };
  serviceWriterName?: string;
  serviceWriterAccountFirstName?: string;
  serviceWriterAccountLastName?: string;
}

export interface TekmetricJob {
  id: number;
  repairOrderId: number;
  name: string;
  authorized?: boolean;
  status?: string;
  jobStatus?: string;
  authorizationStatus?: string;
  laborTotal?: number;
  laborAmount?: number;
  laborPrice?: number;
  partsTotal?: number;
  partsAmount?: number;
  partsPrice?: number;
  subletTotal?: number;
  subletAmount?: number;
  subletPrice?: number;
  discountTotal?: number;
  discountAmount?: number;
  subtotal?: number;
  total?: number;
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

export interface TekmetricInspectionRating {
  id: number;
  code: 'CHCKD' | 'MAYRQRATTN' | 'RQRSATTN' | 'NA';
  name: string;
}

export interface TekmetricInspectionTask {
  id: number;
  name: string;
  inspectionRating: TekmetricInspectionRating;
  finding: string | null;
  inspectionGroup: string;
  groupSortOrder: number;
  reported: boolean;
  externalImages: any[];
  cannedJob: any | null;
  inspectionTaskId: number;
  potentialFindingsToSelect: Array<{ id: number; name: string; sortOrder: number }> | null;
  motoVisualsAnimationId: number | null;
  images: any[] | null;
}

export interface TekmetricInspectionTaskGroup {
  title: string;
  groupSortOrder: number;
  tasks: TekmetricInspectionTask[];
}

export interface TekmetricInspectionImage {
  id: number | null;
  path: string;
  contentType: string;
  processed: number;
  processingTimeSeconds: number;
}

export interface TekmetricInspection {
  id: number;
  name: string;
  repairOrderId: number;
  technician: { id: number; name: string } | null;
  inspectionId: number;
  inspectionTasks: TekmetricInspectionTaskGroup[];
  images: TekmetricInspectionImage[];
  completedDate: string | null;
  createdDate: string | null;
  notifyServiceWriter: boolean | null;
  internalInspection: boolean;
  sortOrder: number | null;
}

export interface TekmetricInspectionItem {
  id: number;
  name: string;
  status: 'good' | 'bad' | 'marginal' | 'not_inspected';
  notes?: string;
  categoryId?: number;
  categoryName?: string;
  mediaUrls?: string[];
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
  customerId: number;
  vehicleId: number;
  repairOrderId?: number;
  startTime: string;
  endTime: string;
  title?: string;
  note?: string;
  notes?: string;
  color?: string;
  type?: string;
  status?: string;
  appointmentType?: string;
  createdDate?: string;
  updatedDate?: string;
}

export interface TekmetricEmployee {
  id: number;
  shopId: number;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  role?: string;
  type?: string;
  certified?: boolean;
  active?: boolean;
  deletedDate?: string | null;
  createdDate?: string;
  updatedDate?: string;
}

export interface CreateAppointmentParams {
  shopId: number;
  customerId: number;
  vehicleId: number;
  startTime: string;
  endTime: string;
  title?: string;
  description?: string;
  color?: string;
  dropoffTime?: string;
  pickupTime?: string;
  rideOption?: "LOANER" | "RIDE" | "NONE";
  status?: "NONE" | "ARRIVED" | "NO_SHOW" | "CANCELLED";
  appointmentOption?: "STAY" | "DROP" | "TOW";
  appointmentOptionId?: number;
}
