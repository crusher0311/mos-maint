import type { TireDotResult } from "./tire-dot-report-contract";

export type TireAdvisor = { id: string | null; name: string | null; provenance: string };
const text = (v: unknown) => typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" && Number.isSafeInteger(v) ? String(v) : null;
/** Only service-writer fields; never technicians, customers or guessed names. */
export function capturedTireAdvisor(raw: any): TireAdvisor | undefined {
  if (!raw) return;
  const id = text(raw.serviceWriter?.id) ?? text(raw.serviceWriterId);
  if (raw.serviceWriter?.id != null && raw.serviceWriterId != null &&
      String(raw.serviceWriter.id) !== String(raw.serviceWriterId)) return;
  const name = text(raw.serviceWriter?.name) ?? text(raw.serviceWriter?.fullName) ?? text(raw.serviceWriterName)
    ?? ([text(raw.serviceWriterAccountFirstName), text(raw.serviceWriterAccountLastName)].filter(Boolean).join(" ") || null);
  return id || name ? { id, name, provenance: "Captured invoice service writer" } : undefined;
}

/** Current cache assignments are not historical truth. Only supplement when the
 * exact shop/RO/vehicle AND provider revision match the pinned invoice. */
export function enrichTireAdvisor(doc: any, candidates: any[], shopId: number) {
  const raw = doc.data;
  if (!raw || capturedTireAdvisor(raw) || !raw.updatedDate || raw.id == null || raw.shopId == null || raw.vehicleId == null ||
      doc.shopId != null && Number(doc.shopId) !== shopId ||
      doc.workOrderId != null && String(doc.workOrderId) !== String(raw.id)) return doc;
  // Do not "repair" conflicting pinned identities using another snapshot.
  if (raw.serviceWriter?.id != null || raw.serviceWriterId != null) return doc;
  const matches = candidates.filter(c => Number(c.shopId) === shopId &&
    String(c.workOrderId) === String(raw.id) && String(c.data?.id) === String(raw.id) &&
    String(c.data?.shopId) === String(raw.shopId) && String(c.data?.vehicleId) === String(raw.vehicleId) &&
    c.data?.updatedDate === raw.updatedDate);
  if (matches.length !== 1) return doc;
  const advisor = capturedTireAdvisor(matches[0].data);
  return advisor ? { ...doc, tireAdvisor: { ...advisor, provenance: "Retained cache; exact shop, invoice, vehicle and provider revision matched" } } : doc;
}

export function tireAdvisorAnalysis(result: TireDotResult) {
  const groups = new Map<string, {
    key: string; location: string; shopId: number; advisor: string; invoices: number;
    assessed: number; missing: number; invalid: number; review: number; shortage: number;
    flagged: number; unassessed: number; inherited: number; invoiceNumbers: string[];
  }>();
  const details = new Map<string, typeof result.details>();
  for (const d of result.details) {
    const key = `${d.shopId}:${d.providerRoId}`;
    const rows = details.get(key) ?? []; rows.push(d); details.set(key, rows);
  }
  for (const invoice of result.invoices) {
    // Unknown-authorization-only exceptions are not sold tire invoices.
    if (invoice.tireQuantity <= 0) continue;
    const a = invoice.advisor;
    const key = JSON.stringify([invoice.shopId, a?.id ? ["id", a.id] : a?.name ? ["name", a.name] : ["unavailable"]]);
    const g = groups.get(key) ?? { key, location: invoice.location, shopId: invoice.shopId,
      advisor: a?.name || (a?.id ? `Advisor ID ${a.id}` : "Advisor unavailable"),
      invoices: 0, assessed: 0, missing: 0, invalid: 0, review: 0, shortage: 0,
      flagged: 0, unassessed: 0, inherited: 0, invoiceNumbers: [] };
    const rows = details.get(`${invoice.shopId}:${invoice.providerRoId}`) ?? [];
    const assessed = invoice.usableDotEntries !== undefined && rows.length > 0 && rows.every(r => r.dotQuality);
    g.invoices++;
    if (!assessed) g.unassessed++;
    else {
      g.assessed++;
      const missing = rows.some(r => r.dot === null || r.dot.trim() === "");
      const invalid = rows.some(r => r.dot !== null && r.dot.trim() !== "" && r.dotQuality?.status === "invalid");
      const review = rows.some(r => r.dotQuality?.status === "needs-review");
      const shortage = rows.some(r => r.exceptions.includes("Structurally usable DOT entry count differs from part quantity"));
      if (missing) g.missing++;
      if (invalid) g.invalid++;
      if (review) g.review++;
      if (shortage) g.shortage++;
      if (rows.some(r => r.exceptions.some(e => e.includes("retained from an earlier payload")))) g.inherited++;
      if (missing || invalid || review || shortage) {
        g.flagged++; g.invoiceNumbers.push(invoice.invoiceNumber ?? `RO ${invoice.providerRoId}`);
      }
    }
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.flagged - a.flagged || b.invoices - a.invoices || a.key.localeCompare(b.key));
}
