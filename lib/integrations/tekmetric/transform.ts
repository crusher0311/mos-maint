import type { 
  NormalizedVehicle, 
  NormalizedCustomer, 
  NormalizedWorkOrder, 
  NormalizedServiceJob,
  NormalizedLineItem,
  CannedJob,
} from '@/lib/integrations/core/types';
import type { 
  TekmetricVehicle, 
  TekmetricCustomer, 
  TekmetricRepairOrder,
  TekmetricRepairOrderFull,
  TekmetricJob,
  TekmetricCannedJob,
} from './types';

export function transformVehicle(raw: TekmetricVehicle): NormalizedVehicle {
  return {
    id: String(raw.id),
    vin: raw.vin,
    year: raw.year,
    make: raw.make,
    model: raw.model,
    subModel: raw.subModel,
    engine: raw.engine,
    transmission: raw.transmission,
    mileage: raw.mileageIn || raw.mileageOut,
    mileageUnit: 'miles',
    licensePlate: raw.licensePlate,
    color: raw.color,
    customerId: String(raw.customerId),
    sourceId: String(raw.id),
    sourceSystem: 'tekmetric',
  };
}

export function transformCustomer(raw: TekmetricCustomer): NormalizedCustomer {
  const primaryPhone = raw.phone?.find(p => p.primary)?.number || raw.phone?.[0]?.number;
  
  return {
    id: String(raw.id),
    firstName: raw.firstName,
    lastName: raw.lastName,
    email: raw.email,
    phone: primaryPhone,
    address: raw.address ? {
      street: raw.address.address1,
      city: raw.address.city,
      state: raw.address.state,
      zip: raw.address.zip,
    } : undefined,
    sourceId: String(raw.id),
    sourceSystem: 'tekmetric',
  };
}

export function transformJob(raw: TekmetricJob): NormalizedServiceJob {
  const lines: NormalizedLineItem[] = [];
  
  if (raw.laborAmount && raw.laborAmount > 0) {
    lines.push({
      id: `${raw.id}-labor`,
      lineType: 'labor',
      description: 'Labor',
      quantity: 1,
      unitPrice: raw.laborAmount,
      extendedPrice: raw.laborAmount,
    });
  }
  
  if (raw.partsAmount && raw.partsAmount > 0) {
    lines.push({
      id: `${raw.id}-parts`,
      lineType: 'part',
      description: 'Parts',
      quantity: 1,
      unitPrice: raw.partsAmount,
      extendedPrice: raw.partsAmount,
    });
  }

  return {
    id: String(raw.id),
    title: raw.name,
    status: raw.authorized ? 'authorized' : 'pending',
    lines,
    totals: {
      laborHours: 0,
      laborAmount: raw.laborAmount || 0,
      partsAmount: raw.partsAmount || 0,
      totalAmount: raw.totalAmount || 0,
    },
    sourceId: String(raw.id),
  };
}

export function transformRepairOrder(raw: TekmetricRepairOrder, vehicle?: TekmetricVehicle, customer?: TekmetricCustomer, jobs?: TekmetricJob[]): NormalizedWorkOrder {
  const normalizedVehicle = vehicle ? transformVehicle(vehicle) : {
    id: String(raw.vehicleId),
    mileage: raw.mileageIn || raw.mileageOut,
    sourceId: String(raw.vehicleId),
    sourceSystem: 'tekmetric' as const,
  };

  const normalizedCustomer = customer ? transformCustomer(customer) : undefined;
  const serviceJobs = (jobs || []).map(transformJob);

  return {
    id: String(raw.id),
    workOrderNumber: raw.repairOrderNumber,
    status: raw.status || 'unknown',
    stage: raw.label?.text,
    vehicle: normalizedVehicle,
    customer: normalizedCustomer,
    serviceJobs,
    createdAt: raw.createdDate ? new Date(raw.createdDate) : undefined,
    updatedAt: raw.updatedDate ? new Date(raw.updatedDate) : undefined,
    closedAt: raw.completedDate ? new Date(raw.completedDate) : undefined,
    sourceId: String(raw.id),
    sourceSystem: 'tekmetric',
  };
}

export function transformRepairOrderFull(raw: TekmetricRepairOrderFull): NormalizedWorkOrder {
  return transformRepairOrder(raw, raw.vehicle, raw.customer, raw.jobs);
}

export function transformCannedJob(raw: TekmetricCannedJob): CannedJob {
  const lines: NormalizedLineItem[] = [];
  
  if (raw.laborAmount && raw.laborAmount > 0) {
    lines.push({
      id: `${raw.id}-labor`,
      lineType: 'labor',
      description: 'Labor',
      quantity: 1,
      unitPrice: raw.laborAmount,
      extendedPrice: raw.laborAmount,
    });
  }
  
  if (raw.partsAmount && raw.partsAmount > 0) {
    lines.push({
      id: `${raw.id}-parts`,
      lineType: 'part',
      description: 'Parts',
      quantity: 1,
      unitPrice: raw.partsAmount,
      extendedPrice: raw.partsAmount,
    });
  }

  return {
    id: String(raw.id),
    code: String(raw.id),
    title: raw.name,
    lines,
    sourceSystem: 'tekmetric',
  };
}
