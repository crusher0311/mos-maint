// Pure helpers for re-hydrating declined-work line items from raw cached
// Tekmetric job payloads. Kept free of server-only / DB imports so smoke
// tests can exercise them directly under tsx.
//
// Background: job_index rows indexed before the May-2026 job-detail fix
// (commit "Fix Tekmetric job retrieval to include shop ID in requests") can
// carry the right totals but degraded lines — no labor line at all and/or
// parts with a $0 unitPrice. Pushing those lines to Tekmetric creates a job
// with zero labor hours and $0 parts. The raw `tekmetric_work_orders` cache
// has the full detail, so callers rebuild lines from it when the indexed
// lines look thin.

export interface DeclinedWorkLine {
  description: string;
  lineType: string;
  quantity: number;
  unitPrice: number;
  partNumber: string;
  manufacturer: string;
  /** Labor hours (labor lines only) — the extension sends this to Tekmetric. */
  hours?: number;
  /** Real per-unit part cost (dollars), when the source knows it. */
  cost?: number;
  extendedCost?: number;
}

/**
 * True when an indexed line set is degraded and should be rebuilt from the
 * raw RO cache: empty, missing labor entirely, or containing $0 parts.
 */
export function linesAreThin(lines: DeclinedWorkLine[]): boolean {
  if (!Array.isArray(lines) || lines.length === 0) return true;
  const hasLabor = lines.some((l) => l.lineType === "labor");
  const hasZeroPart = lines.some((l) => l.lineType === "part" && !(l.unitPrice > 0));
  return !hasLabor || hasZeroPart;
}

/**
 * Rebuilds declined-work lines from a raw cached Tekmetric job (amounts in
 * cents → dollars). Mirrors the line-building rules of
 * lib/integrations/tekmetric/job-index.ts so enriched lines match what a
 * fresh re-index would produce.
 */
export function buildLinesFromRawJob(raw: any): DeclinedWorkLine[] {
  const lines: DeclinedWorkLine[] = [];
  const laborEntries: any[] = Array.isArray(raw?.labor) ? raw.labor : [];
  for (const entry of laborEntries) {
    const hours = Number(entry?.hours) || 0;
    const rateDollars = (Number(entry?.rate) || 0) / 100;
    lines.push({
      description: entry?.name || raw?.name || "",
      lineType: "labor",
      quantity: 1,
      unitPrice: rateDollars,
      partNumber: "",
      manufacturer: "",
      ...(hours > 0 ? { hours } : {}),
    });
  }
  if (laborEntries.length === 0) {
    const laborTotalDollars = (Number(raw?.laborTotal ?? raw?.laborAmount) || 0) / 100;
    if (laborTotalDollars > 0) {
      const hours = Number(raw?.laborHours) || 0;
      lines.push({
        description: raw?.name || "",
        lineType: "labor",
        quantity: 1,
        unitPrice: laborTotalDollars,
        partNumber: "",
        manufacturer: "",
        ...(hours > 0 ? { hours } : {}),
      });
    }
  }

  const parts: any[] = Array.isArray(raw?.parts) ? raw.parts : [];
  const partsTotalDollars = (Number(raw?.partsTotal ?? raw?.partsAmount) || 0) / 100;
  const allPartsZero = parts.every((p) => !(Number(p?.retail) || Number(p?.cost)));
  const totalPartsQty = parts.reduce((s, p) => s + (Number(p?.quantity) || 1), 0);
  for (const part of parts) {
    const qty = Number(part?.quantity) || 1;
    let retailDollars = (Number(part?.retail) || Number(part?.cost) || 0) / 100;
    if (retailDollars === 0 && allPartsZero && partsTotalDollars > 0 && totalPartsQty > 0) {
      retailDollars = Math.round((partsTotalDollars / totalPartsQty) * 100) / 100;
    }
    const costDollars = (Number(part?.cost) || 0) / 100;
    lines.push({
      description: part?.name || part?.description || "",
      lineType: "part",
      quantity: qty,
      unitPrice: retailDollars,
      partNumber: part?.partNumber || "",
      manufacturer: part?.brand || "",
      ...(costDollars > 0 ? { cost: costDollars, extendedCost: qty * costDollars } : {}),
    });
  }
  return lines;
}
