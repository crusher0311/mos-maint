import { createHash } from "node:crypto";
import type { TireDotDefinition } from "./tire-dot-report-contract";

export const PILOT_CONTROL = "heart-october-2026";
export const PILOT_RANGE = { start: "2026-10-01", end: "2026-10-31" };
export const PILOT_PAGE_SIZE = 50;
export const PILOT_MAX_REQUESTS = 1200;
export const PILOT_MAX_INVOICES = 30_000;
export interface TirePilotSelection {
  generation: string; enterpriseId: string; start: string; end: string;
  startedAt: string; finishedAt: string; finalMonth: boolean;
  locations: { shopId: number; providerShopId: number; invoices: number }[];
  warnings: string[];
}
const pick = (obj: any, keys: string[]) => Object.fromEntries(keys
  .filter(k => obj?.[k] !== undefined).map(k => [k, obj[k]]));
/** Retain report evidence, not customer names, contact details, notes or attachments.
 * Omitted collections remain omitted; never manufacture an empty collection. */
export function pilotEvidence(raw: any, providerShopId: number) {
  if (!Number.isSafeInteger(raw?.id) || raw.id <= 0 || raw.shopId !== providerShopId)
    throw new Error("Provider invoice identity mismatch");
  const data = pick(raw, ["id", "shopId", "repairOrderNumber", "repairOrderStatus",
    "postedDate", "updatedDate", "deletedDate", "deleted", "isDeleted", "archived",
    "isArchived", "archivedDate", "milesIn", "milesOut", "mileageIn", "mileageOut",
    "vehicleId", "vin", "year", "make", "model",
    "laborSales", "partsSales", "subletSales", "feeTotal", "discountTotal", "taxes", "totalSales"]);
  if (raw.jobs !== undefined) {
    if (!Array.isArray(raw.jobs)) throw new Error("Invalid provider jobs collection");
    data.jobs = raw.jobs.map((j: any) => {
      const job = pick(j, ["id", "authorized", "archived", "isArchived", "archivedDate",
        "deletedDate", "deleted", "isDeleted", "status", "declined", "deferred"]);
      if (j.parts !== undefined) {
        if (!Array.isArray(j.parts)) throw new Error("Invalid provider parts collection");
        job.parts = j.parts.map((p: any) => pick(p, ["id", "name", "description", "brand",
          "model", "partNumber", "partType", "type", "category", "quantity", "width", "ratio",
          "diameter", "dotNumbers", "deletedDate", "deleted", "isDeleted", "archived",
          "isArchived", "archivedDate", "authorized", "status", "declined", "deferred"]));
      }
      return job;
    });
  }
  if (raw.vehicle) data.vehicle = pick(raw.vehicle, ["id", "vin", "year", "make", "model"]);
  if (Buffer.byteLength(JSON.stringify(data)) > 1_000_000) throw Error("provider_invoice_size_limit");
  return data;
}
export function pilotInRange(data: any) {
  const text = typeof data.postedDate === "string" ? data.postedDate : "";
  const posted = Date.parse(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(text) ? `${text}Z` : text);
  return Number.isFinite(posted) && posted >= Date.parse("2026-10-01T00:00:00Z") &&
    posted < Date.parse("2026-11-01T00:00:00Z");
}
export function pilotHash(data: unknown): string {
  const stable = (v: any): string => Array.isArray(v) ? `[${v.map(stable).join(",")}]`
    : v && typeof v === "object" ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`
      : JSON.stringify(v);
  return createHash("sha256").update(stable(data)).digest("hex");
}
export function assertPilotRange(def: TireDotDefinition, selection: TirePilotSelection) {
  if (def.dateRange.start < selection.start || def.dateRange.end > selection.end ||
      def.locationIds.some(id => !selection.locations.some(s => s.shopId === id)))
    throw new Error("The HEART pilot currently covers October 2026 and its verified locations only.");
}
export function validatePilotPage(page: any, expectedPage: number) {
  if (!Array.isArray(page?.content) || page.content.length > PILOT_PAGE_SIZE ||
      page.number !== expectedPage || page.size !== PILOT_PAGE_SIZE ||
      !Number.isSafeInteger(page.totalElements) || page.totalElements < 0 ||
      page.totalElements > PILOT_MAX_INVOICES || !Number.isSafeInteger(page.totalPages) ||
      page.totalPages !== Math.ceil(page.totalElements / PILOT_PAGE_SIZE) ||
      page.content.length !== Math.min(PILOT_PAGE_SIZE, Math.max(0, page.totalElements - expectedPage * PILOT_PAGE_SIZE)))
    throw new Error("Provider pagination is incomplete or exceeds the pilot limit");
}
