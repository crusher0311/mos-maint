import type { ServiceJobStatus } from "@/lib/normalized-schema";
import { extractProtractorLineCost } from "./part-cost";

export interface NormalizedProtractorPackageLine {
  description: string;
  lineType: string;
  quantity: number;
  unitPrice: number;
  extendedPrice: number;
  partNumber: string;
  manufacturer: string;
  rank?: number;
  cost?: number;
  extendedCost?: number;
}

export interface ProtractorPackagePricingSummary {
  lines: NormalizedProtractorPackageLine[];
  laborTotal: number;
  partsTotal: number;
  subletTotal: number;
  feesTotal: number;
  discountTotal: number;
  total: number;
  laborHours?: number;
}

function toFiniteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function firstFinite(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = toFiniteNumber(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function unwrapProtractorCollection(value: any): any[] {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.ItemCollection)) return value.ItemCollection;
  return [];
}

export function getProtractorPackageLines(servicePackage: any): any[] {
  return unwrapProtractorCollection(
    servicePackage?.ServicePackageLines ??
      servicePackage?.Lines ??
      servicePackage?.LineItems ??
      servicePackage?.lines,
  );
}

export function getProtractorPackageIdentity(servicePackage: any): string | null {
  const value =
    servicePackage?.ID ??
    servicePackage?.id ??
    servicePackage?.ServicePackageID ??
    servicePackage?.ServicePackageId ??
    servicePackage?.ServicePackageHeader?.ID ??
    servicePackage?.ServicePackageHeader?.id;
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergeDefined(existing: any, incoming: any): any {
  if (incoming === null || incoming === undefined) return existing;
  if (Array.isArray(existing) && Array.isArray(incoming)) {
    return incoming.length > 0 ? incoming : existing;
  }
  if (isRecord(existing) && isRecord(incoming)) {
    const merged: Record<string, any> = { ...existing };
    for (const [field, value] of Object.entries(incoming)) {
      merged[field] = mergeDefined(existing[field], value);
    }
    return merged;
  }
  return incoming;
}

function getLineBaseIdentity(line: any): string {
  const id =
    line?.ID ??
    line?.id ??
    line?.ServicePackageLineID ??
    line?.ServicePackageLineId ??
    line?.LineID ??
    line?.LineId;
  if (id !== null && id !== undefined && id !== "") return `id:${String(id)}`;
  const signature = [
    line?.Type ?? line?.LineType ?? line?.lineType,
    line?.PartNumber ?? line?.partNumber,
    line?.Description ?? line?.description ?? line?.Name,
    line?.Rank ?? line?.rank,
  ]
    .map((value) => String(value ?? "").trim().toLowerCase())
    .join("|");
  return signature.replace(/\|/g, "") ? `sig:${signature}` : "anonymous";
}

function getOccurrenceAwareLineKeys(lines: any[]): string[] {
  const occurrences = new Map<string, number>();
  return lines.map((line) => {
    const base = getLineBaseIdentity(line);
    if (base.startsWith("id:")) return base;
    const occurrence = occurrences.get(base) || 0;
    occurrences.set(base, occurrence + 1);
    return `${base}#${occurrence}`;
  });
}

function mergePackageLines(existingPackage: any, incomingPackage: any): any[] {
  const existingLines = getProtractorPackageLines(existingPackage);
  const incomingLines = getProtractorPackageLines(incomingPackage);
  if (incomingLines.length === 0) return existingLines;
  if (existingLines.length === 0) return incomingLines;

  const merged = new Map<string, any>();
  const existingKeys = getOccurrenceAwareLineKeys(existingLines);
  existingLines.forEach((line, index) => {
    merged.set(existingKeys[index], line);
  });
  const incomingKeys = getOccurrenceAwareLineKeys(incomingLines);
  incomingLines.forEach((line, index) => {
    const key = incomingKeys[index];
    merged.set(key, mergeDefined(merged.get(key), line));
  });
  return Array.from(merged.values());
}

/**
 * Return every invoice package exactly once. Protractor can repeat a package
 * in ServicePackages and DeferredServicePackages; the deferred copy wins
 * because container membership is the authoritative disposition signal.
 */
export function extractProtractorServicePackages(sourceData: any): any[] {
  const regular = unwrapProtractorCollection(sourceData?.ServicePackages);
  const deferred = unwrapProtractorCollection(sourceData?.DeferredServicePackages);
  const parentClosedAt =
    sourceData?.InvoiceTime ??
    sourceData?.ClosedDate ??
    sourceData?.InvoiceDate ??
    sourceData?.Header?.LastModifiedTime ??
    sourceData?.Header?.CreationTime;
  const byIdentity = new Map<string, any>();

  const add = (servicePackage: any, isDeferred: boolean, sourceSequence: number) => {
    if (!servicePackage || typeof servicePackage !== "object") return;
    const identity = getProtractorPackageIdentity(servicePackage);
    const key = identity ?? `${isDeferred ? "deferred" : "regular"}:${sourceSequence}`;
    const existing = byIdentity.get(key);
    const merged = mergeDefined(existing || {}, servicePackage);
    if (existing) {
      // Deferred list rows can be thinner than the regular copy. Deferred
      // membership must win disposition without erasing richer pricing,
      // headers, or lines with null/empty placeholders from the thin copy.
      const lines = mergePackageLines(existing, servicePackage);
      if (lines.length > 0) {
        merged.ServicePackageLines = { ItemCollection: lines };
      }
    }
    if (identity && merged.ID == null) merged.ID = identity;
    merged._isDeferred = Boolean(existing?._isDeferred) || isDeferred;
    merged._sourceSequence = existing?._sourceSequence ?? sourceSequence;
    if (parentClosedAt != null && merged._parentClosedAt == null) {
      merged._parentClosedAt = parentClosedAt;
    }
    byIdentity.set(key, merged);
  };

  regular.forEach((servicePackage, index) => add(servicePackage, false, index));
  deferred.forEach((servicePackage, index) =>
    add(servicePackage, true, regular.length + index),
  );
  return Array.from(byIdentity.values());
}

/**
 * Canonical Protractor line pricing shared by canned-job reads, normalized
 * service jobs/line items, embedded snapshots, and historical job indexing.
 */
export function normalizeProtractorPackageLine(
  line: any,
): NormalizedProtractorPackageLine {
  const lineType = line?.Type ?? line?.LineType ?? line?.lineType ?? "Labor";
  const isLabor = String(lineType).toLowerCase().includes("labor");
  const priceSummary =
    line?.PriceSummary && typeof line.PriceSummary === "object"
      ? line.PriceSummary
      : {};

  let quantity = firstFinite(line?.Quantity, line?.quantity);
  if (quantity === undefined || quantity <= 0) quantity = 1;
  if (isLabor) {
    const hours = firstFinite(
      line?.EstimatedHours,
      line?.Hours,
      line?.LaborHours,
      line?.laborHours,
    );
    if (hours !== undefined && hours > 0) quantity = hours;
  }

  let unitPrice = firstFinite(
    priceSummary.SellPrice,
    line?.Price,
    line?.UnitPrice,
    line?.unitPrice,
    ...(isLabor
      ? [line?.Rate, line?.LaborRate, line?.laborRate]
      : []),
  );
  const explicitExtendedPrice = firstFinite(
    priceSummary.SellTotal,
    priceSummary.SellSubtotal,
    line?.ExtendedTotal,
    line?.ExtendedPrice,
    line?.extendedPrice,
    line?.Total,
    line?.total,
  );
  if ((unitPrice === undefined || unitPrice === 0) && explicitExtendedPrice !== undefined) {
    unitPrice = quantity > 0 ? explicitExtendedPrice / quantity : explicitExtendedPrice;
  }
  if (unitPrice === undefined) unitPrice = 0;
  const extendedPrice =
    explicitExtendedPrice !== undefined
      ? explicitExtendedPrice
      : quantity * unitPrice;

  const cost = isLabor ? {} : extractProtractorLineCost(line);
  return {
    description: line?.Description ?? line?.description ?? line?.Name ?? "",
    lineType: String(lineType),
    quantity,
    unitPrice: roundMoney(unitPrice),
    extendedPrice: roundMoney(extendedPrice),
    partNumber: line?.PartNumber ?? line?.partNumber ?? "",
    manufacturer: line?.Manufacturer ?? line?.manufacturer ?? line?.Brand ?? "",
    rank: line?.Rank ?? line?.rank ?? undefined,
    ...(cost.cost !== undefined ? { cost: cost.cost } : {}),
    ...(cost.extendedCost !== undefined
      ? { extendedCost: cost.extendedCost }
      : {}),
  };
}

export function summarizeProtractorPackage(
  servicePackage: any,
): ProtractorPackagePricingSummary {
  const lines = getProtractorPackageLines(servicePackage).map(
    normalizeProtractorPackageLine,
  );
  let laborTotal = 0;
  let partsTotal = 0;
  let subletTotal = 0;
  let feesTotal = 0;
  let discountTotal = 0;
  let lineTotal = 0;
  let laborHours = 0;

  for (const line of lines) {
    const type = line.lineType.toLowerCase();
    const amount = line.extendedPrice;
    lineTotal += amount;
    if (type.includes("labor")) {
      laborTotal += amount;
      laborHours += line.quantity;
    } else if (type.includes("part") || type.includes("material")) {
      partsTotal += amount;
    } else if (type.includes("sublet")) {
      subletTotal += amount;
    } else if (
      type.includes("fee") ||
      type.includes("shop") ||
      type.includes("supply")
    ) {
      feesTotal += amount;
    } else if (type.includes("discount")) {
      discountTotal += Math.abs(amount);
    }
  }

  const priceSummary =
    servicePackage?.PriceSummary &&
    typeof servicePackage.PriceSummary === "object"
      ? servicePackage.PriceSummary
      : {};
  return {
    lines,
    laborTotal: roundMoney(
      firstFinite(
        servicePackage?.LaborTotal,
        servicePackage?.Labor,
        priceSummary.LaborTotal,
      ) ?? laborTotal,
    ),
    partsTotal: roundMoney(
      firstFinite(
        servicePackage?.PartsTotal,
        servicePackage?.Parts,
        priceSummary.PartsTotal,
      ) ?? partsTotal,
    ),
    subletTotal: roundMoney(
      firstFinite(servicePackage?.SubletTotal, priceSummary.SubletTotal) ??
        subletTotal,
    ),
    feesTotal: roundMoney(
      firstFinite(
        servicePackage?.FeesTotal,
        servicePackage?.ShopSupplies,
        priceSummary.FeesTotal,
      ) ?? feesTotal,
    ),
    discountTotal: roundMoney(
      firstFinite(
        servicePackage?.DiscountTotal,
        servicePackage?.Discount,
        priceSummary.DiscountTotal,
      ) ?? discountTotal,
    ),
    total: roundMoney(
      firstFinite(
        priceSummary.SellTotal,
        priceSummary.SellSubtotal,
        servicePackage?.Total,
        servicePackage?.GrandTotal,
        servicePackage?.TotalAmount,
        servicePackage?.Subtotal,
        servicePackage?.Price,
      ) ?? lineTotal,
    ),
    laborHours: laborHours > 0 ? Math.round(laborHours * 100) / 100 : undefined,
  };
}

export function normalizeProtractorServiceJobStatus(
  status: unknown,
  isDeferred = false,
): ServiceJobStatus {
  if (isDeferred) return "deferred";
  const normalized =
    typeof status === "string"
      ? status.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
      : "";
  const compact = normalized.replace(/_/g, "");
  if (["pending", "estimate", "estimated"].includes(compact)) return "pending";
  if (["authorized", "approved"].includes(compact)) return "authorized";
  if (["declined", "rejected"].includes(compact)) return "declined";
  if (["deferred", "postponed"].includes(compact)) return "deferred";
  if (["inprogress", "workinprogress", "working"].includes(compact)) {
    return "in_progress";
  }
  if (["completed", "complete", "performed", "done"].includes(compact)) {
    return "completed";
  }
  if (["cancelled", "canceled", "voided"].includes(compact)) {
    return "cancelled";
  }
  if (compact === "warranty") return "warranty";
  return "completed";
}