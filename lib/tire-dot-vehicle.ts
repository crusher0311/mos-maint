const text = (v: unknown): string | null => typeof v === "string" && v.trim() ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : null;
/** Structured evidence only; never split the compatibility display label. */
export function tireVehicle(doc: any) {
  const raw = doc?.data ?? {};
  const v = raw.vehicle ?? {};
  return {
    vin: text(v.vin) ?? text(raw.vin) ?? text(doc?.vin),
    year: text(v.year) ?? text(raw.vehicleYear) ?? text(doc?.vehicleYear),
    make: text(v.make) ?? text(raw.vehicleMake) ?? text(doc?.vehicleMake),
    model: text(v.model) ?? text(raw.vehicleModel) ?? text(doc?.vehicleModel),
  };
}
