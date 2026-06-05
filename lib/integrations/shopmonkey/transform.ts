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
  ShopmonkeyServiceItem,
  ShopmonkeyCannedService,
} from "./types";

export interface ShopmonkeyTransformOptions {
  /**
   * Shopmonkey stores odometer values in whatever unit the shop operates in
   * (miles for US shops, kilometers for some CA shops). The normalized record
   * must carry the resolved unit so downstream VHI math doesn't mistake one
   * unit for the other (see lib/shop-distance-unit.ts). The per-vehicle
   * `mileageUnit` field on the live payload takes precedence over this.
   */
  mileageUnit?: "miles" | "kilometers";
}

const centsToDollars = (cents?: number | null): number =>
  cents == null ? 0 : cents / 100;

/**
 * Resolve the odometer unit, preferring the per-vehicle `mileageUnit` the live
 * v3 payload carries ("Mile"/"Kilometer") over the shop-level default.
 */
function resolveMileageUnit(
  raw: ShopmonkeyVehicle,
  options?: ShopmonkeyTransformOptions,
): "miles" | "kilometers" {
  const u = String(raw.mileageUnit ?? "").toLowerCase();
  if (u.startsWith("kilom") || u === "km") return "kilometers";
  if (u.startsWith("mile") || u === "mi") return "miles";
  return options?.mileageUnit ?? "miles";
}

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
    mileageUnit: resolveMileageUnit(raw, options),
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
  // Live v3 returns emails as an array; fall back to the legacy `email` scalar.
  const primaryEmail =
    raw.emails?.find((e) => e.primary)?.email || raw.emails?.[0]?.email || raw.email;

  // Live v3 carries flat address fields; the nested `address` is a fallback.
  const street = raw.address1 ?? raw.address?.address1 ?? undefined;
  const city = raw.city ?? raw.address?.city ?? undefined;
  const state = raw.state ?? raw.address?.state ?? undefined;
  const zip =
    raw.zip ?? raw.postalCode ?? raw.address?.zip ?? raw.address?.postalCode ?? undefined;
  const hasAddress = Boolean(street || city || state || zip);

  return {
    id: String(raw.id),
    firstName: raw.firstName ?? undefined,
    lastName: raw.lastName ?? undefined,
    email: primaryEmail ?? undefined,
    phone: primaryPhone ?? undefined,
    address: hasAddress ? { street, city, state, zip } : undefined,
    sourceId: String(raw.id),
    sourceSystem: "shopmonkey",
  };
}

/**
 * Map a flat live `/service_item` record to a normalized line item. Amounts are
 * in cents (and may be fractional). For labor, the unit price is the hourly
 * rate and the quantity is hours; for parts, the unit price is the per-unit
 * retail price and the quantity is the part count.
 */
export function transformServiceItem(raw: ShopmonkeyServiceItem): NormalizedLineItem {
  const type = String(raw.type ?? "").toLowerCase();
  const isLabor = type === "labor";
  const extended = raw.priceCents != null ? centsToDollars(raw.priceCents) : centsToDollars(raw.subtotalCents);

  let lineType: NormalizedLineItem["lineType"] = "other";
  if (isLabor) lineType = "labor";
  else if (type === "part" || type === "tire") lineType = "part";
  else if (type === "subcontract" || type === "sublet") lineType = "sublet";
  else if (type === "fee") lineType = "fee";

  let quantity: number;
  let unitPrice: number;
  if (isLabor) {
    quantity = raw.hours ?? 1;
    unitPrice = centsToDollars(raw.laborRateCents);
  } else {
    quantity = raw.quantity ?? 1;
    unitPrice =
      raw.retailCostCents != null
        ? centsToDollars(raw.retailCostCents)
        : quantity
          ? extended / quantity
          : extended;
  }

  return {
    id: `${type || "item"}-${raw.id}`,
    lineType,
    description: raw.name || raw.tireModelName || raw.note || (isLabor ? "Labor" : "Item"),
    partNumber: raw.partNumber ?? undefined,
    manufacturer: raw.brand ?? raw.vendor?.name ?? undefined,
    quantity,
    unitPrice,
    extendedPrice: extended,
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

const ORDER_STATUS_MAP: Record<string, string> = {
  Estimate: "estimate",
  estimate: "estimate",
  WorkInProgress: "work_in_progress",
  "Work-In-Progress": "work_in_progress",
  Invoice: "closed",
  invoice: "closed",
  Complete: "closed",
  Posted: "closed",
  Archived: "closed",
};

/**
 * Build the single normalized service job for a Shopmonkey order from its flat
 * `/service_item` line items. Shopmonkey v3 has no service/job grouping under an
 * order, so all line items collapse into one job whose totals come from the
 * order-level cent fields.
 */
function buildServiceJobFromItems(
  raw: ShopmonkeyOrder,
  items: ShopmonkeyServiceItem[],
): NormalizedServiceJob {
  const lines: NormalizedLineItem[] = items.map(transformServiceItem);
  const laborHours = items
    .filter((i) => String(i.type).toLowerCase() === "labor")
    .reduce((sum, i) => sum + (i.hours ?? 0), 0);

  const laborAmount =
    raw.laborCents != null
      ? centsToDollars(raw.laborCents)
      : lines.filter((l) => l.lineType === "labor").reduce((s, l) => s + l.extendedPrice, 0);
  const partsAmount =
    raw.partsCents != null
      ? centsToDollars(raw.partsCents)
      : lines.filter((l) => l.lineType === "part").reduce((s, l) => s + l.extendedPrice, 0);
  const totalAmount =
    raw.totalCostCents != null
      ? centsToDollars(raw.totalCostCents)
      : lines.reduce((s, l) => s + l.extendedPrice, 0);

  return {
    id: String(raw.id),
    title: raw.name ?? raw.generatedName ?? "Service",
    description: raw.complaint ?? raw.customerConcern ?? undefined,
    status: (raw.status && (ORDER_STATUS_MAP[raw.status] ?? raw.status)) || "unknown",
    lines,
    totals: { laborHours, laborAmount, partsAmount, totalAmount },
    sourceId: String(raw.id),
  };
}

export function transformOrder(
  raw: ShopmonkeyOrder,
  options?: ShopmonkeyTransformOptions,
  serviceItems?: ShopmonkeyServiceItem[],
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

  // Prefer flat `/service_item` line items (live v3); fall back to any embedded
  // `services` array (canned/legacy shapes). If neither is present but the order
  // still carries money (e.g. a fee-only order, or one with no vehicle/customer
  // to filter `/service_item` by), build a single job from the order-level
  // totals so the grand total isn't silently dropped.
  const items = serviceItems ?? raw.serviceItems;
  const hasMoney =
    (raw.totalCostCents ?? 0) !== 0 ||
    (raw.laborCents ?? 0) !== 0 ||
    (raw.partsCents ?? 0) !== 0 ||
    (raw.tiresCents ?? 0) !== 0 ||
    (raw.subcontractsCents ?? 0) !== 0 ||
    (raw.feesCents ?? 0) !== 0;
  let serviceJobs: NormalizedServiceJob[];
  if (items && items.length) {
    serviceJobs = [buildServiceJobFromItems(raw, items)];
  } else if (raw.services && raw.services.length) {
    serviceJobs = raw.services.map(transformService);
  } else if (hasMoney) {
    serviceJobs = [buildServiceJobFromItems(raw, [])];
  } else {
    serviceJobs = [];
  }

  const closed =
    raw.invoicedDate ?? raw.completedDate ?? raw.closedDate ?? raw.postedDate ?? undefined;

  return {
    id: String(raw.id),
    workOrderNumber: raw.number ?? raw.invoiceNumber ?? undefined,
    status: (raw.status && (ORDER_STATUS_MAP[raw.status] ?? raw.status)) || "unknown",
    stage: raw.label?.text ?? raw.labels?.[0]?.text ?? undefined,
    vehicle,
    customer,
    serviceJobs,
    createdAt: raw.createdDate ? new Date(raw.createdDate) : undefined,
    updatedAt: raw.updatedDate ? new Date(raw.updatedDate) : undefined,
    closedAt: closed ? new Date(closed) : undefined,
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
