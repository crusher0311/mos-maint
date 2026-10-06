/** Labor contract v1. Separate from legacy KPI meanings. */
export const LABOR_METRIC_KEYS = [
  "laborClosedROCount", "soldLaborHours", "presentedLaborHours", "netLaborSales",
] as const;
export const LABOR_BANDS = ["under1", "1to2", "2to4", "over4", "unknown"] as const;
export type LaborBand = typeof LABOR_BANDS[number];
export const LABOR_BAND_LABELS: Record<LaborBand, string> = {
  under1: "Under 1 hour", "1to2": "1 to under 2 hours",
  "2to4": "2 to 4 hours", over4: "Over 4 hours", unknown: "Unknown hours",
};
export function laborBand(hours: number | null): LaborBand {
  if (hours == null || !Number.isFinite(hours) || hours < 0) return "unknown";
  return hours < 1 ? "under1" : hours < 2 ? "1to2" : hours <= 4 ? "2to4" : "over4";
}
export function recordedNumber(value: unknown): number | null {
  if (value == null || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Explicit source line evidence, never normalized quantity's default of one.
 * Hours are billed before estimated; technician time is NOT sold hours.
 * ExtendedTotal is accepted only when its arithmetic proves discount treatment.
 */
export function protractorLaborLineEvidence(line: any) {
  const first = (...values: unknown[]) => values.map(recordedNumber).find(v => v !== null) ?? null;
  const hours = first(line.BilledHours, line.Hours, line.LaborHours, line.Quantity, line.EstimatedHours);
  const gross = first(line.Total);
  const discount = first(line.DiscountAmount, line.Discount);
  const extended = first(line.ExtendedTotal);
  const net = gross != null && discount != null && discount >= 0 && extended != null &&
    Math.abs(gross - discount - extended) < 0.011 ? extended : null;
  return { version: 1, hours: hours != null && hours >= 0 ? hours : null, net,
    discount, costMeaning: "unverified-provider-cost" };
}

export const LABOR_REPORTING_NOTES = [
  "Labor v1 uses distinct non-deleted terminal closed/invoiced/paid ROs; it does not change legacy Repair orders or Billed revenue.",
  "Business dates use normalized closed_date (completed_date fallback), UTC calendar days. Provider offset timestamps are converted to UTC; this is not a local shop-day report. Import dates are never used.",
  "Labor values are supported subtotals. Each measure includes its covered-RO count; missing ROs are excluded, not valued at zero. No records does not prove complete history.",
  "Protractor only is supported. Presented hours include sold plus explicitly declined/deferred jobs once, excluding drafts. Historical missing decline ingestion makes presented hours unverified.",
  "Verified invoicing packages can establish sold hours without a declined-work collection. Missing declined-work evidence leaves presented hours and net labor unavailable; it does not imply zero declined work.",
  "Net labor excludes non-labor lines and subtracts verified line discounts exactly once. Missing/unallocated discounts or unallocated refunds make net unavailable. Credits remain signed on the original close date; refunds are not allocated proportionally.",
  "Provider-recorded labor costs are unverified, not loaded technician cost. Fully loaded cost and GP are unavailable; ADP is deferred. Results are not reconciled to native reports.",
] as const;
