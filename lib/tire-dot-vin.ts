import { tireVehicle } from "./tire-dot-vehicle";
/** Supplemental identity only. Never replace pinned financial or DOT evidence. */
export function enrichTireVin(doc: any, candidates: any[], shopId: number) {
  const raw = doc.data;
  if (!raw || raw.id == null || raw.shopId == null || raw.vehicleId == null ||
      doc.shopId != null && Number(doc.shopId) !== shopId ||
      doc.workOrderId != null && String(doc.workOrderId) !== String(raw.id)) return doc;
  const matches = candidates.filter(c => Number(c.shopId) === shopId &&
    String(c.workOrderId) === String(raw.id) &&
    String(c.data?.id) === String(raw.id) &&
    String(c.data?.shopId) === String(raw.shopId) &&
    String(c.data?.vehicleId) === String(raw.vehicleId));
  if (!matches.length) return doc;
  const captured = tireVehicle(doc);
  const evidence = matches.map(tireVehicle);
  // Any disagreement, including with pinned fields, vetoes the supplement.
  for (const field of ["vin", "year", "make", "model"] as const) {
    const values = [captured[field], ...evidence.map(v => v[field])].filter((v): v is string => v !== null);
    if (new Set(values.map(v => v.trim().toUpperCase())).size > 1) return doc;
  }
  const patch: any = {};
  const provenance = "Retained work-order cache; exact shop, invoice and vehicle identity verified";
  for (const field of ["vin", "year", "make", "model"] as const) {
    const value = evidence.find(v => v[field] !== null)?.[field];
    if (captured[field] || !value || field === "vin" && !/^[A-HJ-NPR-Z0-9]{17}$/i.test(value)) continue;
    patch[field === "vin" ? "vin" : `vehicle${field[0].toUpperCase()}${field.slice(1)}`] = field === "vin" ? value.toUpperCase() : value;
    patch[field === "vin" ? "vinProvenance" : "vehicleProvenance"] = provenance;
  }
  return Object.keys(patch).length ? { ...doc, ...patch } : doc;
}
