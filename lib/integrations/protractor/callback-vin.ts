import type { ProtractorVehicle, ProtractorWorkOrder } from "./client";

/** Modern VIN validation; Lookup is only usable when it is actually a VIN. */
export function normalizeCallbackVin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const vin = value.trim().toUpperCase();
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(vin) ? vin : null;
}

export function extractCallbackVehicleVin(vehicle: ProtractorVehicle | undefined): string | null {
  if (!vehicle) return null;
  return normalizeCallbackVin(vehicle.VIN) ??
    normalizeCallbackVin(vehicle.Lookup) ??
    normalizeCallbackVin(vehicle.LookUp);
}

export function extractCallbackWorkOrderVin(workOrder: ProtractorWorkOrder): string | null {
  const topLevelVin = (workOrder as ProtractorWorkOrder & { VIN?: unknown }).VIN;
  return extractCallbackVehicleVin(workOrder.ServiceItem) ??
    normalizeCallbackVin(topLevelVin);
}