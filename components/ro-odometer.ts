export type DistanceUnit = "miles" | "kilometers";
export type OdometerSuggestion = {
  reading: number | null;
  unit: DistanceUnit | "unknown";
  confidence: "high" | "medium" | "low";
  kind: "odometer" | "trip" | "unreadable";
};
export type OdometerCapture = {
  photoRequestId: string; suggestion: OdometerSuggestion;
  selectedUnit: DistanceUnit | "";
  confirmed: null | { value: number; unit: DistanceUnit; sourceUnit: DistanceUnit; at: string };
};
/** Deliberately strict: never fish digits from malformed model prose. */
export function parseOdometerSuggestion(value: unknown): OdometerSuggestion {
  const result = value as OdometerSuggestion;
  if (!result || typeof result !== "object" || Array.isArray(result) ||
      Object.keys(result).sort().join(",") !== "confidence,kind,reading,unit" ||
      !["miles", "kilometers", "unknown"].includes(result.unit) ||
      !["high", "medium", "low"].includes(result.confidence) ||
      !["odometer", "trip", "unreadable"].includes(result.kind) ||
      (result.reading !== null && (!Number.isSafeInteger(result.reading) || result.reading < 0 || result.reading > 9_999_999)) ||
      (result.kind === "odometer" ? result.reading === null : result.reading !== null))
    throw new Error("The photo reading was not valid. Your previous mileage is unchanged. Read the total odometer manually or try another photo.");
  return { reading: result.reading, unit: result.unit, confidence: result.confidence, kind: result.kind };
}
export function convertOdometer(reading: number, from: DistanceUnit, to: DistanceUnit) {
  if (!Number.isSafeInteger(reading) || reading < 0 || reading > 9_999_999) throw new Error("Invalid odometer reading.");
  const converted = Math.round(from === to ? reading : from === "miles" ? reading * 1.609344 : reading / 1.609344);
  if (converted > 9_999_999) throw new Error("Converted odometer is outside the supported range. Enter the reading manually.");
  return converted;
}
