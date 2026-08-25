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

/**
 * Returns the amount Protractor actually recorded for a package. This differs
 * from summarizeProtractorPackage().total for an empty/unpriced package: the
 * summary intentionally uses zero as its arithmetic default, while callers
 * repairing historical prices need to distinguish "recorded $0" from "no
 * price was recorded".
 */
export function getRecordedProtractorPackageTotal(
  servicePackage: any,
): number | null {
  const priceSummary =
    servicePackage?.PriceSummary &&
    typeof servicePackage.PriceSummary === "object"
      ? servicePackage.PriceSummary
      : {};
  const packagePriceFields = [
    priceSummary.SellTotal,
    priceSummary.SellSubtotal,
    servicePackage?.Total,
    servicePackage?.GrandTotal,
    servicePackage?.TotalAmount,
    servicePackage?.Subtotal,
    servicePackage?.Price,
  ];
  const linePriceFields = getProtractorPackageLines(servicePackage).flatMap(
    (line) => {
      const linePriceSummary =
        line?.PriceSummary && typeof line.PriceSummary === "object"
          ? line.PriceSummary
          : {};
      const lineType = String(
        line?.Type ?? line?.LineType ?? line?.lineType ?? "",
      ).toLowerCase();
      return [
        linePriceSummary.SellPrice,
        linePriceSummary.SellTotal,
        linePriceSummary.SellSubtotal,
        line?.Price,
        line?.UnitPrice,
        line?.unitPrice,
        line?.ExtendedTotal,
        line?.ExtendedPrice,
        line?.extendedPrice,
        line?.Total,
        line?.total,
        ...(lineType.includes("labor")
          ? [line?.Rate, line?.LaborRate, line?.laborRate]
          : []),
      ];
    },
  );
  const hasExplicitPrice = [...packagePriceFields, ...linePriceFields].some(
    (value) => toFiniteNumber(value) !== undefined,
  );
  return hasExplicitPrice ? summarizeProtractorPackage(servicePackage).total : null;
}

type MatchableServiceJob = {
  jobNumber?: unknown;
  sequence?: unknown;
  title?: unknown;
};

function normalizedMatchValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim().toLowerCase();
  return normalized || null;
}

export function normalizeProtractorPackageTitle(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  return normalized || null;
}

function getPackageSequence(servicePackage: any): string | null {
  return normalizedMatchValue(
    servicePackage?.Sequence ?? servicePackage?._sourceSequence,
  );
}

function getPackageTitle(servicePackage: any): string | null {
  return normalizeProtractorPackageTitle(
    servicePackage?.ServicePackageHeader?.Title ??
      servicePackage?.Title ??
      servicePackage?.Name ??
      servicePackage?.ServiceDescription ??
      servicePackage?.Description,
  );
}

/**
 * Matches normalized jobs to packages from a cached work-order snapshot only.
 * A package is consumed at most once. ID matches are preferred, followed by a
 * sequence that is unique on both sides, then a normalized title unique on
 * both sides.
 */
export function matchNormalizedServiceJobsToCachedProtractorPackages<
  T extends MatchableServiceJob,
>(serviceJobs: readonly T[], servicePackages: readonly any[]): Map<T, any> {
  const matches = new Map<T, any>();
  const availableJobs = new Set(serviceJobs);
  const availablePackages = new Set(servicePackages);

  const consume = (job: T, servicePackage: any) => {
    matches.set(job, servicePackage);
    availableJobs.delete(job);
    availablePackages.delete(servicePackage);
  };

  for (const job of serviceJobs) {
    const id = normalizedMatchValue(job.jobNumber);
    if (!id) continue;
    const servicePackage = Array.from(availablePackages).find(
      (candidate) =>
        normalizedMatchValue(getProtractorPackageIdentity(candidate)) === id,
    );
    if (servicePackage) consume(job, servicePackage);
  }

  const matchUnique = (
    jobKey: (job: T) => string | null,
    packageKey: (servicePackage: any) => string | null,
  ) => {
    const jobsByKey = new Map<string, T[]>();
    const packagesByKey = new Map<string, any[]>();
    for (const job of availableJobs) {
      const key = jobKey(job);
      if (key) jobsByKey.set(key, [...(jobsByKey.get(key) || []), job]);
    }
    for (const servicePackage of availablePackages) {
      const key = packageKey(servicePackage);
      if (key) {
        packagesByKey.set(key, [
          ...(packagesByKey.get(key) || []),
          servicePackage,
        ]);
      }
    }
    for (const [key, jobs] of jobsByKey) {
      const packages = packagesByKey.get(key);
      if (jobs.length === 1 && packages?.length === 1) {
        consume(jobs[0], packages[0]);
      }
    }
  };

  matchUnique(
    (job) => normalizedMatchValue(job.sequence),
    getPackageSequence,
  );
  matchUnique(
    (job) => normalizeProtractorPackageTitle(job.title),
    getPackageTitle,
  );
  return matches;
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

/**
 * A cached package can carry better deferred/status provenance than an older
 * normalized row, but package snapshots without a status must not overwrite a
 * valid normalized disposition with normalizeProtractorServiceJobStatus's
 * arithmetic default.
 */
export function resolveCachedProtractorPackageStatus(
  servicePackage: any,
  fallbackStatus: ServiceJobStatus | null,
): ServiceJobStatus | null {
  if (servicePackage?._isDeferred === true) {
    return normalizeProtractorServiceJobStatus(servicePackage?.Status, true);
  }
  const cachedStatus = String(servicePackage?.Status ?? "").trim();
  return cachedStatus
    ? normalizeProtractorServiceJobStatus(cachedStatus)
    : fallbackStatus;
}