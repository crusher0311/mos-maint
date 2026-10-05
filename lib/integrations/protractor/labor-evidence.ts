import { protractorLaborLineEvidence, recordedNumber } from "../../labor-reporting-contract";
import { extractProtractorServicePackages, getProtractorPackageLines, normalizeProtractorServiceJobStatus } from "./package-normalization";

/** Sold evidence and complete presentation evidence have independent coverage. */
export function protractorInvoiceLaborEvidence(invoice: any) {
  const collection = (x: any) => Array.isArray(x) || Array.isArray(x?.ItemCollection);
  if (!collection(invoice.ServicePackages)) return null;
  const completeDispositions = collection(invoice.DeferredServicePackages);
  let sold: number | null = 0, presented: number | null = completeDispositions ? 0 : null,
    net: number | null = completeDispositions ? 0 : null;
  for (const job of extractProtractorServicePackages(invoice)) {
    const sourceStatus = String(job.Status ?? "").trim().toLowerCase().replace(/[^a-z]/g,"");
    if (!job._isDeferred && !["","pending","estimate","estimated","authorized","approved",
      "declined","rejected","deferred","postponed","inprogress","workinprogress","working",
      "completed","complete","performed","done","cancelled","canceled","voided","warranty"].includes(sourceStatus)) {
      sold = presented = net = null;
      continue;
    }
    const status = normalizeProtractorServiceJobStatus(job.Status, job._isDeferred);
    if (!["completed", "authorized", "declined", "deferred"].includes(status)) continue;
    const declined = status === "declined" || status === "deferred";
    // Explicitly non-invoicing, non-declined work is not sold or presented.
    // Missing deferred evidence must not turn a status-less draft into a sale.
    if (!declined && job.IsInvoicing === false) continue;
    if (!completeDispositions && !declined && job.IsInvoicing !== true) {
      sold = null;
      continue;
    }
    const lines = getProtractorPackageLines(job);
    const hasLines = collection(job.ServicePackageLines ?? job.Lines ?? job.LineItems ?? job.lines) &&
      lines.every(l => /^(labor|material|part|sublet|fee|fees|shop supplies|discount)$/i.test(String(l.Type ?? l.LineType ?? "")));
    const labor = lines.filter(l => /^labor$/i.test(String(l.Type ?? l.LineType ?? "")));
    const evidence = labor.map(protractorLaborLineEvidence);
    const explicitHours = recordedNumber(job.BilledHours ?? job.Hours);
    const hours = explicitHours !== null ? (explicitHours >= 0 ? explicitHours : null) : (hasLines && evidence.every(e => e.hours !== null)
      ? evidence.reduce((n,e) => n + e.hours!,0) : null);
    if (hours === null) presented = null;
    else if (presented !== null) presented += hours;
    if (!declined) {
      if (hours === null) sold = null;
      else if (sold !== null) sold += hours;
      // Header/package discounts cannot be silently allocated to labor.
      const discount = recordedNumber(job.DiscountTotal ?? job.Discount ?? job.PriceSummary?.DiscountTotal);
      if (!hasLines || discount !== 0 || evidence.some(e => e.net === null) ||
          lines.some(l => /discount/i.test(String(l.Type ?? l.LineType)))) net = null;
      else if (net !== null) net += evidence.reduce((n,e) => n + e.net!,0);
    }
  }
  if (recordedNumber(invoice.DiscountTotal ?? invoice.Discount) !== 0) net = null;
  return { version: 2, sold, presented, net };
}
