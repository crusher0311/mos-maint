import type {
  NormalizedVehicle,
  NormalizedCustomer,
  NormalizedWorkOrder,
  NormalizedServiceJob,
  NormalizedLineItem,
  CannedJob,
} from "@/lib/integrations/core/types";
import type {
  ShopmonkeyVehicle,
  ShopmonkeyCustomer,
  ShopmonkeyOrder,
  ShopmonkeyService,
  ShopmonkeyCannedService,
} from "./types";

export interface ShopmonkeyTransformOptions {
  /**
   * Shopmonkey stores odometer values in whatever unit the shop operates in
   * (miles for US shops). The normalized record must carry the resolved unit so
   * downstream VHI math doesn't mistake one unit for the other (see
   * lib/shop-distance-unit.ts).
   */
  mileageUnit?: "miles" | "kilometers";
}

const centsToDollars = (cents?: number | null): number =>
  cents == null ? 0 : cents / 100;

export function transformVehicle(
  raw: ShopmonkeyVehicle,
  options?: ShopmonkeyTransformOptions,
): NormalizedVehicle {
  return {
    id: String(raw.id),
    vin: raw.vin ?? undefined,
    year: raw.year ?? undefined,
    make: raw.make ?? undefined,
    model: raw.model ?? undefined,
    subModel: raw.submodel ?? raw.subModel ?? undefined,
    engine: raw.engine ?? undefined,
    transmission: raw.transmission ?? undefined,
    mileage: raw.mileage ?? raw.mileageIn ?? raw.mileageOut ?? undefined,
    mileageUnit: options?.mileageUnit ?? "miles",
    licensePlate: raw.licensePlate ?? undefined,
    color: raw.color ?? undefined,
    customerId: raw.customerId ? String(raw.customerId) : undefined,
    sourceId: String(raw.id),
    sourceSystem: "shopmonkey",
  };
}

export function transformCustomer(raw: ShopmonkeyCustomer): NormalizedCustomer {
  const primaryPhone =
    raw.phoneNumbers?.find((p) => p.primary)?.number || raw.phoneNumbers?.[0]?.number;

  return {
    id: String(raw.id),
    firstName: raw.firstName ?? undefined,
    lastName: raw.lastName ?? undefined,
    email: raw.email ?? undefined,
    phone: primaryPhone ?? undefined,
    address: raw.address
      ? {
          street: raw.address.address1 ?? undefined,
          city: raw.address.city ?? undefined,
          state: raw.address.state ?? undefined,
          zip: raw.address.zip ?? raw.address.postalCode ?? undefined,
        }
      : undefined,
    sourceId: String(raw.id),
    sourceSystem: "shopmonkey",
  };
}

export function transformService(raw: ShopmonkeyService): NormalizedServiceJob {
  const lines: NormalizedLineItem[] = [];

  for (const labor of raw.labors ?? []) {
    const rate = centsToDollars(labor.rateCents);
    const hours = labor.hours ?? 1;
    const total = labor.totalCents != null ? centsToDollars(labor.totalCents) : rate * hours;
    lines.push({
      id: `labor-${labor.id}`,
      lineType: "labor",
      description: labor.name ?? labor.description ?? "Labor",
      quantity: hours,
      unitPrice: rate,
      extendedPrice: total,
    });
  }

  for (const part of raw.parts ?? []) {
    const qty = part.quantity ?? 1;
    const unit = centsToDollars(part.retailCents);
    const total = part.totalCents != null ? centsToDollars(part.totalCents) : unit * qty;
    lines.push({
      id: `part-${part.id}`,
      lineType: "part",
      description: part.name ?? part.description ?? "Part",
      partNumber: part.partNumber ?? undefined,
      manufacturer: part.brand ?? part.manufacturer ?? undefined,
      quantity: qty,
      unitPrice: unit,
      extendedPrice: total,
    });
  }

  const laborHours = (raw.labors ?? []).reduce((sum, l) => sum + (l.hours ?? 0), 0);
  const laborAmount =
    raw.laborCents != null
      ? centsToDollars(raw.laborCents)
      : (raw.labors ?? []).reduce(
          (sum, l) => sum + centsToDollars(l.totalCents) || 0,
          0,
        );
  const partsAmount =
    raw.partsCents != null
      ? centsToDollars(raw.partsCents)
      : (raw.parts ?? []).reduce(
          (sum, p) => sum + (centsToDollars(p.totalCents) || centsToDollars(p.retailCents) * (p.quantity ?? 1)),
          0,
        );
  const totalAmount =
    raw.totalCents != null ? centsToDollars(raw.totalCents) : laborAmount + partsAmount;

  return {
    id: String(raw.id),
    title: raw.name ?? raw.title ?? "Service",
    status: raw.authorized ? "authorized" : raw.declined ? "declined" : "pending",
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

export function transformOrder(
  raw: ShopmonkeyOrder,
  options?: ShopmonkeyTransformOptions,
): NormalizedWorkOrder {
  const vehicle: NormalizedVehicle = raw.vehicle
    ? transformVehicle(raw.vehicle, options)
    : {
        id: String(raw.vehicleId ?? ""),
        mileage: raw.mileage ?? raw.mileageIn ?? raw.mileageOut ?? undefined,
        mileageUnit: options?.mileageUnit ?? "miles",
        sourceId: String(raw.vehicleId ?? ""),
        sourceSystem: "shopmonkey",
      };

  const customer = raw.customer ? transformCustomer(raw.customer) : undefined;
  const serviceJobs = (raw.services ?? []).map(transformService);

  const statusMap: Record<string, string> = {
    Estimate: "estimate",
    estimate: "estimate",
    WorkInProgress: "work_in_progress",
    "Work-In-Progress": "work_in_progress",
    Invoice: "closed",
    invoice: "closed",
    Complete: "closed",
    Posted: "closed",
  };

  return {
    id: String(raw.id),
    workOrderNumber: raw.number ?? raw.invoiceNumber ?? undefined,
    status: (raw.status && (statusMap[raw.status] ?? raw.status)) || "unknown",
    stage: raw.label?.text ?? undefined,
    vehicle,
    customer,
    serviceJobs,
    createdAt: raw.createdDate ? new Date(raw.createdDate) : undefined,
    updatedAt: raw.updatedDate ? new Date(raw.updatedDate) : undefined,
    closedAt: raw.completedDate
      ? new Date(raw.completedDate)
      : raw.closedDate
        ? new Date(raw.closedDate)
        : undefined,
    sourceId: String(raw.id),
    sourceSystem: "shopmonkey",
  };
}

export function transformCannedService(raw: ShopmonkeyCannedService): CannedJob {
  const lines: NormalizedLineItem[] = [];
  for (const labor of raw.labors ?? []) {
    lines.push({
      id: `labor-${labor.id}`,
      lineType: "labor",
      description: labor.name ?? "Labor",
      quantity: labor.hours ?? 1,
      unitPrice: (labor.rateCents ?? 0) / 100,
      extendedPrice: (labor.totalCents ?? 0) / 100,
    });
  }
  for (const part of raw.parts ?? []) {
    lines.push({
      id: `part-${part.id}`,
      lineType: "part",
      description: part.name ?? part.description ?? "Part",
      partNumber: part.partNumber ?? undefined,
      quantity: part.quantity ?? 1,
      unitPrice: (part.retailCents ?? 0) / 100,
      extendedPrice: (part.totalCents ?? 0) / 100,
    });
  }

  return {
    id: String(raw.id),
    code: raw.code ?? String(raw.id),
    title: raw.name ?? "Canned Service",
    lines,
    sourceSystem: "shopmonkey",
  };
}
