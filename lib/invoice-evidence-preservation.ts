import { isFinalProtractorInvoice } from "./integrations/protractor/labor-evidence";

/** An incomplete snapshot may retain a verified identity/date, never stale hours. */
export function preserveInvoiceIdentity(shopId: number, raw: any, previous: any, mapped: any) {
  if (mapped?.invoiceHours || !previous || Number(previous.shopId) !== shopId) return mapped;
  const old = previous.customFields?.invoiceHours;
  if (old?.version !== 1 || typeof old.id !== "string" ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(old.id) ||
      typeof old.date !== "string" || !Number.isFinite(Date.parse(old.date)) ||
      new Date(old.date).getUTCFullYear() < 1900 ||
      new Date(old.date).toISOString() !== old.date ||
      String(raw?.ID ?? "").toLowerCase() !== old.id.toLowerCase() ||
      !isFinalProtractorInvoice(raw) ||
      !previous.provenance?.sourceIds?.some((s: any) => s.system === "protractor" &&
        ["invoice_id", "work_order_id"].includes(s.idType) &&
        String(s.idValue).toLowerCase() === old.id.toLowerCase())) return mapped;
  if (raw.InvoiceTime != null) {
    if (typeof raw.InvoiceTime !== "string") return mapped;
    const stamp = /(?:Z|[+-]\d{2}:\d{2})$/.test(raw.InvoiceTime) ? raw.InvoiceTime : raw.InvoiceTime + "Z";
    if (Date.parse(stamp) !== Date.parse(old.date)) return mapped;
  }
  return { ...mapped, invoiceHours: { version: 1, id: old.id.toLowerCase(), date: old.date,
    sold: null, presented: null } };
}
