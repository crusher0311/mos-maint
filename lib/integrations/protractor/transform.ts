import type { 
  NormalizedVehicle, 
  NormalizedCustomer, 
  NormalizedWorkOrder, 
  NormalizedServiceJob,
  NormalizedLineItem,
  CannedJob,
} from '@/lib/integrations/core/types';
import type { 
  ProtractorVehicle, 
  ProtractorContact, 
  ProtractorWorkOrder,
  ProtractorServicePackage,
  ProtractorServicePackageLine,
  ProtractorCannedJob,
} from './types';

export function transformVehicle(raw: ProtractorVehicle): NormalizedVehicle {
  return {
    id: raw.ID,
    vin: raw.VIN,
    year: raw.Year,
    make: raw.Make,
    model: raw.Model,
    subModel: raw.Submodel,
    engine: raw.Engine,
    transmission: raw.Transmission,
    mileage: raw.Odometer,
    mileageUnit: 'miles',
    licensePlate: raw.LicensePlate,
    color: raw.Color,
    customerId: raw.OwnerID,
    sourceId: raw.ID,
    sourceSystem: 'protractor',
  };
}

export function transformCustomer(raw: ProtractorContact): NormalizedCustomer {
  return {
    id: raw.ID,
    firstName: raw.Name?.FirstName,
    lastName: raw.Name?.LastName,
    email: raw.Email,
    phone: raw.Phone1 || raw.Phone2,
    address: raw.Address ? {
      street: raw.Address.Street,
      city: raw.Address.City,
      state: raw.Address.Province,
      zip: raw.Address.PostalCode,
    } : undefined,
    sourceId: raw.ID,
    sourceSystem: 'protractor',
  };
}

function normalizeLineType(type?: string): NormalizedLineItem['lineType'] {
  if (!type) return 'labor';
  const normalized = type.toLowerCase();
  if (normalized.includes('labor')) return 'labor';
  if (normalized.includes('part') || normalized.includes('material')) return 'part';
  if (normalized.includes('sublet')) return 'sublet';
  if (normalized.includes('fee')) return 'fee';
  return 'other';
}

export function transformLineItem(raw: ProtractorServicePackageLine): NormalizedLineItem {
  return {
    id: raw.ID,
    lineType: normalizeLineType(raw.LineType),
    description: raw.Description || '',
    partNumber: raw.PartNumber,
    manufacturer: raw.Manufacturer,
    quantity: raw.Quantity || 1,
    unitPrice: raw.UnitPrice || 0,
    extendedPrice: raw.ExtendedPrice || 0,
  };
}

export function transformServiceJob(raw: ProtractorServicePackage): NormalizedServiceJob {
  const lines = (raw.ServicePackageLines || []).map(transformLineItem);
  
  let laborHours = 0, laborAmount = 0, partsAmount = 0, totalAmount = 0;
  for (const line of lines) {
    if (line.lineType === 'labor') {
      laborHours += line.quantity;
      laborAmount += line.extendedPrice;
    } else if (line.lineType === 'part') {
      partsAmount += line.extendedPrice;
    }
    totalAmount += line.extendedPrice;
  }

  return {
    id: raw.ID,
    title: raw.Title || '',
    description: raw.Description,
    code: raw.Chapter,
    status: raw.Status || 'unknown',
    lines,
    totals: { laborHours, laborAmount, partsAmount, totalAmount },
    sourceId: raw.ID,
  };
}

export function transformWorkOrder(raw: ProtractorWorkOrder): NormalizedWorkOrder {
  const vehicle = raw.ServiceItem ? transformVehicle(raw.ServiceItem) : {
    id: raw.ServiceItemID || '',
    sourceId: raw.ServiceItemID || '',
    sourceSystem: 'protractor' as const,
  };

  const customer = raw.Contact ? transformCustomer(raw.Contact) : undefined;
  const serviceJobs = (raw.ServicePackages || []).map(transformServiceJob);

  return {
    id: raw.ID,
    workOrderNumber: raw.WorkOrderNumber,
    status: raw.Status || 'unknown',
    stage: raw.WorkflowStage,
    vehicle,
    customer,
    serviceJobs,
    createdAt: raw.Header?.CreationTime ? new Date(raw.Header.CreationTime) : undefined,
    updatedAt: raw.Header?.LastModifiedTime ? new Date(raw.Header.LastModifiedTime) : undefined,
    sourceId: raw.ID,
    sourceSystem: 'protractor',
  };
}

export function transformCannedJob(raw: ProtractorCannedJob): CannedJob {
  const lines = (raw.ServicePackageLines || []).map(transformLineItem);

  return {
    id: raw.ID,
    code: raw.Code || '',
    title: raw.Title || '',
    description: raw.Description,
    chapter: raw.Chapter,
    lines,
    sourceSystem: 'protractor',
  };
}
