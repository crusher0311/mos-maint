// Narrow backport of invoiceHoursEvidence from the web/callback release.
// No reporting queries, fleet aggregation, or stored-hours fallback belongs here.
import { isFinalProtractorInvoice, protractorInvoiceLaborEvidence } from "./integrations/protractor/labor-evidence";
import { extractProtractorServicePackages, getOccurrenceAwareLineKeys, getProtractorPackageIdentity, getProtractorPackageLines, normalizeProtractorServiceJobStatus, unwrapProtractorCollection } from "./integrations/protractor/package-normalization";
import { recordedNumber } from "./labor-reporting-contract";

export type InvoiceEvidence = {
  version: 1; id: string; date: string; sold: number | null; presented: number | null;
};
const guid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function conflictingPackageHours(raw: any): Set<string> {
  const conflicts = new Set<string>();
  const packages = new Map<string, Map<string, number>>();
  const first = (...values: unknown[]) => values.map(recordedNumber).find(n => n !== null) ?? null;
  for (const job of [
    ...unwrapProtractorCollection(raw.ServicePackages),
    ...unwrapProtractorCollection(raw.DeferredServicePackages),
  ]) {
    const id = getProtractorPackageIdentity(job);
    if (!id) continue;
    let seen = packages.get(id);
    if (!seen) packages.set(id, seen = new Map());
    const observe = (key: string, value: number | null) => {
      if (value === null) return;
      if (seen!.has(key) && seen!.get(key) !== value) conflicts.add(id);
      seen!.set(key, value);
    };
    observe("package-hours", first(job.BilledHours, job.Hours));
    const lines = getProtractorPackageLines(job);
    const keys = getOccurrenceAwareLineKeys(lines);
    lines.forEach((line, index) => {
      if (!/^labor$/i.test(String(line.Type ?? line.LineType ?? ""))) return;
      observe(`line:${keys[index]}`, first(line.BilledHours, line.Hours, line.LaborHours, line.Quantity));
    });
  }
  return conflicts;
}

/** Only current source evidence; never reuse previously repaired hours. */
export function invoiceHoursEvidence(raw: any): InvoiceEvidence | null {
  if (!isFinalProtractorInvoice(raw) || !guid.test(String(raw.ID ?? "")) ||
      !(recordedNumber(raw.InvoiceNumber)! > 0) || typeof raw.InvoiceTime !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T/.test(raw.InvoiceTime) || raw.InvoiceTime.startsWith("0001-")) return null;
  const stamp = /(?:Z|[+-]\d{2}:\d{2})$/.test(raw.InvoiceTime) ? raw.InvoiceTime : `${raw.InvoiceTime}Z`;
  const date = new Date(stamp);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1900) return null;
  const calendar = raw.InvoiceTime.slice(0,10);
  const calendarDate = new Date(`${calendar}T00:00:00Z`);
  if (!Number.isFinite(+calendarDate) || calendarDate.toISOString().slice(0,10) !== calendar) return null;
  const conflicts = conflictingPackageHours(raw);
  const jobs = extractProtractorServicePackages(raw);
  const clean = (job: any) => {
    const lines = getProtractorPackageLines(job);
    const seen = new Map<string, string>();
    let conflict = conflicts.has(getProtractorPackageIdentity(job) ?? "");
    const unique = lines.filter(line => {
      const key = line.ID ?? line.ServicePackageLineID ?? line.LineID;
      if (key == null) return true;
      const signature = JSON.stringify(line);
      if (seen.has(String(key))) {
        if (seen.get(String(key)) !== signature) conflict = true;
        return false;
      }
      seen.set(String(key), signature);
      return true;
    }).map(line => ({ ...line, EstimatedHours: undefined }));
    return { ...job, ...(conflict ? { BilledHours: -1, Hours: -1 } : {}),
      ...(lines.length ? { ServicePackageLines: unique } : {}) };
  };
  const regular = jobs.filter(job => !job._isDeferred).map(clean);
  const deferred = jobs.filter(job => job._isDeferred).map(clean);
  const collection = (v: any) => Array.isArray(v) || Array.isArray(v?.ItemCollection);
  const evidence = protractorInvoiceLaborEvidence({
    ...raw,
    ServicePackages: collection(raw.ServicePackages) ? regular : null,
    DeferredServicePackages: collection(raw.DeferredServicePackages) ? deferred : null,
  });
  let sold = evidence?.sold ?? null, presented = evidence?.presented ?? null;
  for (const job of jobs) {
    const status = normalizeProtractorServiceJobStatus(job.Status, job._isDeferred);
    if (!["completed", "authorized", "declined", "deferred"].includes(status)) continue;
    if (["completed", "authorized"].includes(status) && job.IsInvoicing == null) sold = presented = null;
    if (!getProtractorPackageIdentity(job)) {
      presented = null;
      if (status === "completed" || status === "authorized") sold = null;
    }
  }
  return { version: 1, id: raw.ID.toLowerCase(), date: date.toISOString(), sold, presented };
}
