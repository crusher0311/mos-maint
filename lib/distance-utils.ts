const MILES_TO_KM = 1.60934;
const KM_TO_MILES = 0.621371;

export type DistanceUnit = "miles" | "kilometers";

export function milesToKm(miles: number): number {
  return miles * MILES_TO_KM;
}

export function kmToMiles(km: number): number {
  return km * KM_TO_MILES;
}

export function convertDistance(value: number, toUnit: DistanceUnit): number {
  if (toUnit === "kilometers") {
    return milesToKm(value);
  }
  return value;
}

export function formatDistance(
  value: number | null | undefined,
  unit: DistanceUnit = "miles"
): string {
  if (value == null) return "";
  if (value === 0) return "0";
  
  const converted = unit === "kilometers" ? milesToKm(value) : value;
  return Math.round(converted).toLocaleString();
}

export function getDistanceLabel(unit: DistanceUnit): string {
  return unit === "kilometers" ? "km" : "mi";
}

export function getDistanceLabelFull(unit: DistanceUnit): string {
  return unit === "kilometers" ? "kilometers" : "miles";
}
