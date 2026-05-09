/**
 * Task #391: Detect when a vehicle's current odometer is lower than a
 * previously reported mileage (shop history or CARFAX). Pure helper —
 * no DB / no IO — so it's trivial to unit test.
 *
 * Reports the worst (largest gap) prior reading. Detect-and-warn only;
 * triage's anchor-selection logic is unchanged.
 */

/** Tolerance below which we ignore the gap (rounding noise / floor-vs-ceil). */
export const MILEAGE_DISCREPANCY_TOLERANCE_MILES = 50;

export interface MileageDiscrepancy {
  /** Current odometer used to evaluate the discrepancy. */
  currentMiles: number;
  /** The conflicting prior reading (always > currentMiles + tolerance). */
  priorMiles: number;
  /** Human-readable label, e.g. "Tekmetric" or "CARFAX". */
  priorSource: string;
  /** ISO date string of the prior record, or null if unknown. */
  priorDate: string | null;
  /** priorMiles - currentMiles (always positive). */
  gapMiles: number;
}

export interface ShopHistoryReading {
  mileage?: number | null;
  date?: Date | string | null;
}

export interface CarfaxReading {
  odometer?: number | null;
  date?: string | null;
}

export interface DetectMileageDiscrepancyInput {
  currentMiles: number | null | undefined;
  shopHistory?: ShopHistoryReading[] | null;
  carfaxRecords?: CarfaxReading[] | null;
  /** Label for shop-history origin, e.g. "Tekmetric". Defaults to "Shop history". */
  shopHistoryLabel?: string;
  /** Override tolerance (miles). Defaults to MILEAGE_DISCREPANCY_TOLERANCE_MILES. */
  toleranceMiles?: number;
}

function toDateOrNull(d: Date | string | null | undefined): Date | null {
  if (!d) return null;
  if (d instanceof Date) return isNaN(d.getTime()) ? null : d;
  // CARFAX dates are M/D/YYYY
  const trimmed = String(d).trim();
  const m = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const dt = new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
    return isNaN(dt.getTime()) ? null : dt;
  }
  const parsed = new Date(trimmed);
  return isNaN(parsed.getTime()) ? null : parsed;
}

export function detectMileageDiscrepancy(
  input: DetectMileageDiscrepancyInput,
): MileageDiscrepancy | null {
  const currentMiles = input.currentMiles;
  if (typeof currentMiles !== "number" || !Number.isFinite(currentMiles) || currentMiles <= 0) {
    return null;
  }
  const tolerance = input.toleranceMiles ?? MILEAGE_DISCREPANCY_TOLERANCE_MILES;
  const shopLabel = input.shopHistoryLabel || "Shop history";

  let worst: MileageDiscrepancy | null = null;
  const consider = (priorMiles: number, source: string, dateRaw: Date | string | null | undefined) => {
    if (!Number.isFinite(priorMiles) || priorMiles <= 0) return;
    const gap = priorMiles - currentMiles;
    if (gap <= tolerance) return;
    if (worst && gap <= worst.gapMiles) return;
    const dt = toDateOrNull(dateRaw);
    worst = {
      currentMiles,
      priorMiles,
      priorSource: source,
      priorDate: dt ? dt.toISOString() : null,
      gapMiles: gap,
    };
  };

  for (const r of input.shopHistory || []) {
    if (typeof r?.mileage === "number") consider(r.mileage, shopLabel, r.date ?? null);
  }
  for (const r of input.carfaxRecords || []) {
    if (typeof r?.odometer === "number") consider(r.odometer, "CARFAX", r.date ?? null);
  }

  return worst;
}

/** Resolve a friendly shop-history source label from an integration provider key. */
export function shopHistoryLabelFromProvider(provider?: string | null): string {
  switch ((provider || "").toLowerCase()) {
    case "tekmetric":
      return "Tekmetric";
    case "shopware":
    case "shop-ware":
      return "Shop-Ware";
    case "protractor":
      return "Protractor";
    case "autoflow":
      return "AutoFlow";
    default:
      return "Shop history";
  }
}

/** Build the partner-facing flag entry from a discrepancy. */
export function buildMileageDiscrepancyFlag(d: MileageDiscrepancy) {
  const datePart = d.priorDate
    ? ` on ${new Date(d.priorDate).toLocaleDateString("en-US")}`
    : "";
  return {
    code: "mileage_discrepancy" as const,
    severity: "warning" as const,
    message:
      `Current odometer (${d.currentMiles.toLocaleString()}) is lower than a prior ` +
      `reading of ${d.priorMiles.toLocaleString()} from ${d.priorSource}${datePart}. ` +
      `Service due dates may be inaccurate.`,
    details: {
      currentMiles: d.currentMiles,
      priorMiles: d.priorMiles,
      priorSource: d.priorSource,
      priorDate: d.priorDate,
    },
  };
}
