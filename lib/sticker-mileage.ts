/**
 * Shared mileage-input coercion for sticker/keytag entry points.
 *
 * Callers (the Chrome extension especially) sometimes send mileage as a
 * string ("71378" or "71,378"). Naive `currentMileage + interval` then
 * string-concatenates ("71378" + 5000 = "713785000") and prints a broken
 * sticker. Every server route that does mileage math on caller-supplied
 * values must coerce through here first.
 */

/** No real road vehicle plausibly exceeds this odometer reading. */
export const MAX_PLAUSIBLE_MILEAGE = 2_000_000;

/**
 * Parse a caller-supplied mileage-like value into a positive integer.
 * Accepts numbers and numeric strings (commas and surrounding whitespace
 * stripped). Returns null for anything non-numeric, non-finite, zero,
 * or negative.
 */
export function parseMileageInput(value: unknown): number | null {
  let n: number;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "string") {
    const cleaned = value.replace(/,/g, "").trim();
    if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
    n = Number(cleaned);
  } else {
    return null;
  }
  if (!Number.isFinite(n)) return null;
  const int = Math.floor(n);
  if (int <= 0) return null;
  return int;
}

/** Like parseMileageInput but for month counts (same rules). */
export function parseMonthsInput(value: unknown): number | null {
  return parseMileageInput(value);
}

/**
 * True when a current or computed next-service mileage is beyond any
 * plausible odometer reading and must not print.
 */
export function isAbsurdMileage(value: number): boolean {
  return !Number.isFinite(value) || value > MAX_PLAUSIBLE_MILEAGE;
}
