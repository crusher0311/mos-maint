/** Supplemental identity only. Never replace pinned financial or DOT evidence. */
export function enrichTireVin(doc: any, candidates: any[], shopId: number) {
  const raw = doc.data;
  if (!raw || raw.vin || raw.vehicle?.vin || doc.vin || raw.vehicleId == null) return doc;
  const matches = candidates.filter(c => Number(c.shopId) === shopId &&
    String(c.workOrderId) === String(raw.id) &&
    String(c.data?.id) === String(raw.id) &&
    String(c.data?.shopId) === String(raw.shopId) &&
    String(c.data?.vehicleId) === String(raw.vehicleId) &&
    /^[A-HJ-NPR-Z0-9]{17}$/i.test(c.vin || ""));
  const vins = [...new Set(matches.map(c => c.vin.toUpperCase()))];
  if (vins.length !== 1) return doc;
  return { ...doc, vin: vins[0], vinProvenance: "Retained work-order cache; exact shop, invoice and vehicle identity verified" };
}
