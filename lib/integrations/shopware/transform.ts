import type {
  NormalizedVehicle,
  NormalizedCustomer,
  NormalizedWorkOrder,
  NormalizedServiceJob,
  NormalizedLineItem,
  CannedJob,
  DeclinedService,
} from '@/lib/integrations/core/types';
import type {
  ShopWareVehicle,
  ShopWareCustomer,
  ShopWareRepairOrder,
  ShopWareService,
  ShopWareCannedJob,
  ShopWarePastRecommendation,
} from './types';

export function transformVehicle(raw: ShopWareVehicle, customerId?: number): NormalizedVehicle {
  return {
    id: String(raw.id),
    vin: raw.vin ?? undefined,
    year: raw.year ? parseInt(raw.year, 10) : undefined,
    make: raw.make,
    model: raw.model,
    subModel: raw.submodel ?? undefined,
    engine: raw.engine ?? undefined,
    licensePlate: raw.plate ?? undefined,
    color: raw.color ?? undefined,
    customerId: customerId ? String(customerId) : raw.customer_ids?.[0] ? String(raw.customer_ids[0]) : undefined,
    sourceId: String(raw.id),
    sourceSystem: 'shopware',
  };
}

export function transformCustomer(raw: ShopWareCustomer): NormalizedCustomer {
  const phone = raw.phone_1 ?? raw.phone_2 ?? raw.phone_3 ?? undefined;

  return {
    id: String(raw.id),
    firstName: raw.first_name,
    lastName: raw.last_name,
    email: raw.email ?? undefined,
    phone: phone ?? undefined,
    sourceId: String(raw.id),
    sourceSystem: 'shopware',
  };
}

export function transformService(raw: ShopWareService): NormalizedServiceJob {
  const lines: NormalizedLineItem[] = [];

  for (const labor of raw.labors ?? []) {
    lines.push({
      id: `labor-${labor.id}`,
      lineType: 'labor',
      description: labor.name,
      quantity: labor.hours,
      unitPrice: 0,
      extendedPrice: 0,
    });
  }

  for (const part of raw.parts ?? []) {
    lines.push({
      id: `part-${part.id}`,
      lineType: 'part',
      description: part.description,
      partNumber: part.number ?? undefined,
      manufacturer: part.brand ?? undefined,
      quantity: part.quantity,
      unitPrice: (part.sell_price_cents ?? 0) / 100,
      extendedPrice: ((part.sell_price_cents ?? 0) / 100) * part.quantity,
    });
  }

  for (const sublet of raw.sublets ?? []) {
    lines.push({
      id: `sublet-${sublet.id}`,
      lineType: 'sublet',
      description: sublet.name,
      quantity: 1,
      unitPrice: (sublet.price_cents ?? 0) / 100,
      extendedPrice: (sublet.price_cents ?? 0) / 100,
    });
  }

  for (const hazmat of raw.hazmats ?? []) {
    lines.push({
      id: `hazmat-${hazmat.id}`,
      lineType: 'fee',
      description: hazmat.name,
      quantity: hazmat.quantity,
      unitPrice: (hazmat.fee_cents ?? 0) / 100,
      extendedPrice: ((hazmat.fee_cents ?? 0) / 100) * hazmat.quantity,
    });
  }

  const laborHours = (raw.labors ?? []).reduce((sum, l) => sum + l.hours, 0);
  const partsAmount = (raw.parts ?? []).reduce((sum, p) => sum + ((p.sell_price_cents ?? 0) / 100) * p.quantity, 0);
  const subletsAmount = (raw.sublets ?? []).reduce((sum, s) => sum + (s.price_cents ?? 0) / 100, 0);
  const hazmatsAmount = (raw.hazmats ?? []).reduce((sum, h) => sum + ((h.fee_cents ?? 0) / 100) * h.quantity, 0);

  let laborAmount = 0;
  if (raw.is_fixed_price_service && raw.fixed_price_labor_total_cents != null) {
    laborAmount = raw.fixed_price_labor_total_cents / 100;
  }

  const totalAmount = laborAmount + partsAmount + subletsAmount + hazmatsAmount;

  return {
    id: String(raw.id),
    title: raw.title,
    status: raw.completed ? 'completed' : 'pending',
    lines,
    totals: {
      laborHours,
      laborAmount,
      partsAmount,
      totalAmount,
    },
    sourceId: String(raw.id),
  };
}

export function transformRepairOrder(raw: ShopWareRepairOrder): NormalizedWorkOrder {
  const vehicle: NormalizedVehicle = raw.vehicle
    ? transformVehicle(raw.vehicle, raw.customer_id ?? undefined)
    : {
        id: String(raw.vehicle_id ?? ''),
        mileage: raw.odometer ?? undefined,
        sourceId: String(raw.vehicle_id ?? ''),
        sourceSystem: 'shopware',
      };

  const customer: NormalizedCustomer | undefined = raw.customer
    ? transformCustomer(raw.customer)
    : undefined;

  const serviceJobs = (raw.services ?? []).map(transformService);

  const stateMap: Record<string, string> = {
    estimate: 'estimate',
    in_progress: 'in_progress',
    invoice: 'closed',
  };

  return {
    id: String(raw.id),
    workOrderNumber: raw.number,
    status: stateMap[raw.state] ?? raw.state,
    stage: raw.label?.text,
    vehicle,
    customer,
    serviceJobs,
    createdAt: raw.created_at ? new Date(raw.created_at) : undefined,
    updatedAt: raw.updated_at ? new Date(raw.updated_at) : undefined,
    closedAt: raw.closed_at ? new Date(raw.closed_at) : undefined,
    sourceId: String(raw.id),
    sourceSystem: 'shopware',
  };
}

export function transformCannedJob(raw: ShopWareCannedJob): CannedJob {
  return {
    id: String(raw.id),
    code: raw.code ?? String(raw.id),
    title: raw.name,
    lines: [],
    sourceSystem: 'shopware',
  };
}

export function transformPastRecommendation(raw: ShopWarePastRecommendation): DeclinedService {
  return {
    id: String(raw.id),
    title: raw.description,
    declinedAt: raw.created_at ? new Date(raw.created_at) : undefined,
    sourceId: String(raw.id),
    sourceSystem: 'shopware',
  };
}
