export const GAL_TO_L = 3.785411784;
export const LBS_TO_KG = 0.45359237;
export const IN_TO_CM = 2.54;
export const CUFT_TO_L = 28.316846592;

export type UnitDisplay = "imperial" | "metric" | "both";

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString();
}

function fmtDecimal(n: number, decimals: number): string {
  const rounded = Number(n.toFixed(decimals));
  return rounded.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

export function formatGallons(value: unknown, mode: UnitDisplay = "both"): string | null {
  const n = toNum(value);
  if (n === null) return null;
  const liters = n * GAL_TO_L;
  if (mode === "imperial") return `${fmtDecimal(n, 1)} gal`;
  if (mode === "metric") return `${fmtDecimal(liters, 1)} L`;
  return `${fmtDecimal(n, 1)} gal / ${fmtDecimal(liters, 1)} L`;
}

export function formatPounds(value: unknown, mode: UnitDisplay = "both"): string | null {
  const n = toNum(value);
  if (n === null) return null;
  const kg = n * LBS_TO_KG;
  if (mode === "imperial") return `${fmtInt(n)} lbs`;
  if (mode === "metric") return `${fmtInt(kg)} kg`;
  return `${fmtInt(n)} lbs / ${fmtInt(kg)} kg`;
}

export function formatGallonsDual(value: unknown): string | null {
  return formatGallons(value, "both");
}

export function formatPoundsDual(value: unknown): string | null {
  return formatPounds(value, "both");
}

export function formatInches(value: unknown, mode: UnitDisplay = "both"): string | null {
  const n = toNum(value);
  if (n === null) return null;
  const cm = n * IN_TO_CM;
  if (mode === "imperial") return `${fmtDecimal(n, 1)}"`;
  if (mode === "metric") return `${fmtDecimal(cm, 1)} cm`;
  return `${fmtDecimal(n, 1)}" / ${fmtDecimal(cm, 1)} cm`;
}

export function formatCubicFeet(value: unknown, mode: UnitDisplay = "both"): string | null {
  const n = toNum(value);
  if (n === null) return null;
  const liters = n * CUFT_TO_L;
  if (mode === "imperial") return `${fmtDecimal(n, 1)} cu ft`;
  if (mode === "metric") return `${fmtInt(liters)} L`;
  return `${fmtDecimal(n, 1)} cu ft / ${fmtInt(liters)} L`;
}
