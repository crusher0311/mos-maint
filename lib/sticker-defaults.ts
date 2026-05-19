const EUROPEAN_MAKES = [
  "BMW", "Mercedes-Benz", "Mercedes", "Audi", "Volkswagen", "VW", "Porsche",
  "Volvo", "Jaguar", "Land Rover", "Range Rover", "Mini", "Bentley", "Rolls-Royce",
  "Alfa Romeo", "Fiat", "Ferrari", "Lamborghini", "Maserati", "Peugeot", "Renault",
  "Citroën", "Citroen", "Saab", "Opel", "Vauxhall", "Skoda", "SEAT"
];

export type OilType = "diesel" | "euro" | "synthetic" | "conventional";

export interface IntervalConfig {
  mileage: number;
  months: number;
  // Per-shop overrides added in task #439. When `label` is unset we render the
  // built-in display name (Conventional/Synthetic/European/Diesel). When
  // `hidden` is true the bucket is hidden from settings UIs and oil-type
  // pickers; external API callers can still pass the type explicitly.
  label?: string;
  hidden?: boolean;
}

export interface IntervalsConfig {
  diesel: IntervalConfig;
  euro: IntervalConfig;
  synthetic: IntervalConfig;
  conventional: IntervalConfig;
}

export const DEFAULT_INTERVALS: IntervalsConfig = {
  diesel: { mileage: 7500, months: 6 },
  euro: { mileage: 10000, months: 12 },
  synthetic: { mileage: 7500, months: 6 },
  conventional: { mileage: 3000, months: 3 },
};

export const BUILTIN_OIL_TYPE_LABELS: Record<OilType, string> = {
  diesel: "Diesel",
  euro: "European",
  synthetic: "Synthetic",
  conventional: "Conventional",
};

export interface VehicleContext {
  make?: string;
  fuelType?: string;
  jobDescription?: string;
  oilType?: string;
}

// Auto-detect precedence: diesel → euro → synthetic → conventional.
// When the shop has hidden buckets we skip them and fall through to the next
// match. If every bucket is hidden we fall back to `fallbackDefault` (or
// `synthetic` when that is itself hidden).
export function determineOilType(
  context: VehicleContext,
  intervals?: Partial<IntervalsConfig>,
  fallbackDefault?: OilType
): OilType {
  const { make, fuelType, jobDescription, oilType } = context;

  const isHidden = (key: OilType): boolean =>
    intervals?.[key]?.hidden === true;

  // Full precedence order — when the matched bucket is hidden we walk
  // FORWARD from that position rather than jumping to a different "match".
  // e.g. a BMW with `euro` hidden falls to `synthetic` (next in
  // precedence), NOT to `conventional`.
  const precedence: OilType[] = ["diesel", "euro", "synthetic", "conventional"];

  // Default starting index = conventional (3). Promote up the precedence
  // chain based on what the vehicle/job indicates.
  let startIdx = 3;
  const textToCheck = [jobDescription, oilType]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (textToCheck.includes("synthetic") || textToCheck.includes("full syn")) {
    startIdx = 2;
  }
  if (make) {
    const normalizedMake = make.trim().toUpperCase();
    const isEuropean = EUROPEAN_MAKES.some((euroMake) =>
      normalizedMake.includes(euroMake.toUpperCase())
    );
    if (isEuropean) startIdx = 1;
  }
  if (fuelType?.toLowerCase().includes("diesel")) {
    startIdx = 0;
  }

  // Walk forward in precedence from the starting index — return the first
  // visible bucket.
  for (let i = startIdx; i < precedence.length; i++) {
    if (!isHidden(precedence[i])) return precedence[i];
  }

  // All forward buckets are hidden — fall back to any visible bucket in
  // precedence order, then the shop default, then synthetic. Never return
  // a hidden bucket here.
  for (const key of precedence) {
    if (!isHidden(key)) return key;
  }
  if (fallbackDefault && !isHidden(fallbackDefault)) return fallbackDefault;
  return "synthetic";
}

export function getIntervalForOilType(
  oilType: OilType,
  intervals: Partial<IntervalsConfig> | undefined
): IntervalConfig {
  const merged: IntervalsConfig = {
    diesel: intervals?.diesel || DEFAULT_INTERVALS.diesel,
    euro: intervals?.euro || DEFAULT_INTERVALS.euro,
    synthetic: intervals?.synthetic || DEFAULT_INTERVALS.synthetic,
    conventional: intervals?.conventional || DEFAULT_INTERVALS.conventional,
  };

  return merged[oilType];
}

export function getOilTypeLabel(oilType: OilType): string {
  return BUILTIN_OIL_TYPE_LABELS[oilType];
}

// Resolve the user-facing label for a bucket, preferring the shop's custom
// label when set, otherwise falling back to the built-in name.
export function resolveOilTypeLabel(
  oilType: OilType,
  intervals?: Partial<IntervalsConfig>
): string {
  const custom = intervals?.[oilType]?.label?.trim();
  return custom && custom.length > 0 ? custom : BUILTIN_OIL_TYPE_LABELS[oilType];
}

// Returns the ordered list of buckets the shop wants to see in pickers
// (i.e. the four built-in keys minus any marked hidden).
export function getVisibleOilTypes(
  intervals?: Partial<IntervalsConfig>
): OilType[] {
  const order: OilType[] = ["conventional", "synthetic", "euro", "diesel"];
  return order.filter((key) => intervals?.[key]?.hidden !== true);
}
