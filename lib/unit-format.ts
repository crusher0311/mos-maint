export const GAL_TO_L = 3.785411784;
export const LBS_TO_KG = 0.45359237;

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

export function formatGallonsDual(value: unknown): string | null {
  const n = toNum(value);
  if (n === null) return null;
  const liters = n * GAL_TO_L;
  return `${fmtDecimal(n, 1)} gal / ${fmtDecimal(liters, 1)} L`;
}

export function formatPoundsDual(value: unknown): string | null {
  const n = toNum(value);
  if (n === null) return null;
  const kg = n * LBS_TO_KG;
  return `${fmtInt(n)} lbs / ${fmtInt(kg)} kg`;
}
