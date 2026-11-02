/** Policy v1: format screening only, never manufacturer/physical-tire verification.
 * Accept 8–13 alphanumeric characters with a 01–53 week + two-digit year suffix.
 * Optional DOT prefix and spacing are ignored for assessment, never for storage.
 * Older three-digit dates, partial TINs and other formats require human review. */
export type TireDotQuality = { status: "invalid" | "needs-review" | "structurally-plausible"; reason: string };
export function assessTireDot(value: unknown): TireDotQuality {
  const invalid = (reason: string): TireDotQuality => ({ status: "invalid", reason });
  const review = (reason: string): TireDotQuality => ({ status: "needs-review", reason });
  if (typeof value !== "string") return invalid("Non-string or absent DOT evidence");
  const token = value.trim().toUpperCase().replace(/^DOT\s*/, "").replace(/\s+/g, "");
  if (!token) return invalid("Blank DOT evidence");
  if (/^(N\/?A|NONE|NULL|UNKNOWN|UNK|NOTAVAILABLE|NOTAPPLICABLE|TBD|TEST|PLACEHOLDER|-+|\?+|X+)$/.test(token) ||
      /^(.)\1+$/.test(token) || token === "0" || token === "1") return invalid("Obvious filler or placeholder");
  if (/^\d{4}$/.test(token)) return review("Date-only code is not a complete tire identifier");
  if (!/^[A-Z0-9]{8,13}$/.test(token)) return review("Incomplete or uncertain identifier format, including possible legacy format");
  if (!/\d{4}$/.test(token) || Number(token.slice(-4, -2)) < 1 || Number(token.slice(-4, -2)) > 53)
    return review("Missing or uncertain four-digit manufacture date");
  return { status: "structurally-plausible", reason: "Complete-looking format only; manufacturer and physical tire identity not verified" };
}
export const legacyDotQuality = { status: "not-assessed", reason: "Validation was not captured in this saved execution" } as const;
