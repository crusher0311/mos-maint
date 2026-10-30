/** Tire registration is retained line evidence, not a numeric KPI or inspection. */
export const TIRE_DOT_VERSION = 1;
export const TIRE_DOT_LIMITS = { documents: 100_000, rows: 5_000, bytes: 4_000_000, page: 25 } as const;
export type TireDotRange = { start: string; end: string };
export type TireDotScope = { kind: "shop" | "enterprise"; shopId?: number; enterpriseId?: string };
export interface TireDotDefinition {
  kind: "tekmetric-tire-dot";
  version: 1;
  dateRange: TireDotRange;
  locationIds: number[];
}
export interface TireDotInvoice {
  key: string;
  shopId: number;
  location: string;
  providerRoId: string;
  invoiceNumber: string | null;
  postedDate: string;
  vin: string | null;
  vehicle: string | null;
  mileage: number | null;
  partLines: number;
  tireQuantity: number;
  dotEntries: number;
  exceptions: string[];
}
export interface TireDotDetail extends Omit<TireDotInvoice, "partLines" | "tireQuantity" | "dotEntries"> {
  jobId: string;
  partId: string;
  entryIndex: number | null;
  description: string | null;
  brand: string | null;
  quantity: number;
  dot: string | null;
}
export interface TireDotResult {
  generatedAt: string;
  dateRange: TireDotRange;
  shopIds: number[];
  locations: Array<{ shopId: number; name: string }>;
  details: TireDotDetail[];
  invoices: TireDotInvoice[];
  coverage: {
    status: "stored-evidence-only" | "incomplete";
    scanned: number;
    missingRaw: number;
    missingPostedDate: number;
    reasons: string[];
  };
  counts: { invoices: number; partLines: number; tireQuantity: number; dotEntries: number };
  limited: boolean;
}
