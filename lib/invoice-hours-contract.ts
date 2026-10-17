import { isFinalProtractorInvoice, protractorInvoiceLaborEvidence } from "./integrations/protractor/labor-evidence";
import { extractProtractorServicePackages, getOccurrenceAwareLineKeys, getProtractorPackageIdentity, getProtractorPackageLines, normalizeProtractorServiceJobStatus, unwrapProtractorCollection } from "./integrations/protractor/package-normalization";
import { recordedNumber } from "./labor-reporting-contract";
import type { ReportingMetricValues } from "./reporting-kpi-contract";
import { knownUninvoiced } from "./invoice-status-policy";

export const INVOICE_HOURS_METRICS = ["averagePresentedHoursPerInvoice", "averageSoldHoursPerInvoice"] as const;
export const INVOICE_HOURS_NOTES = [
  "Invoice hours use verified invoice identities and invoice dates, in UTC calendar days. Open uninvoiced work is excluded; close, completion and modification dates are not invoice-date substitutes.",
  "Presented hours are sold plus explicitly declined or deferred labor on the same invoices. Each average requires complete hours evidence for every eligible invoice; missing hours are not zero.",
  "Coverage describes stored evidence, not a reconciliation to the provider or a guarantee that all history was imported. Unverified invoice identities or dates are disclosed separately.",
  "Protractor is currently supported. Separate credit documents and zero-number invoices without independent verification remain unverified. Corrections to the same invoice replace its evidence, not its denominator; payment refunds do not invent negative labor hours.",
] as const;

export type InvoiceEvidence = {
  version: 1; id: string; date: string; sold: number | null; presented: number | null;
};
const guid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/**
 * Inspect raw copies BEFORE the canonical richer-copy merge discards competing
 * values. Missing values may be enriched; contradictory recorded hours may not.
 * Use the merge's own line identities, including occurrence-aware fallback keys.
 */
function conflictingPackageHours(raw: any): Set<string> {
  const conflicts = new Set<string>();
  const packages = new Map<string, Map<string, number>>();
  const first = (...values: unknown[]) => values.map(recordedNumber).find(n => n !== null) ?? null;
  for (const job of [
    ...unwrapProtractorCollection(raw.ServicePackages),
    ...unwrapProtractorCollection(raw.DeferredServicePackages),
  ]) {
    const id = getProtractorPackageIdentity(job);
    if (!id) continue; // Missing identities are handled as unavailable below.
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

/** Only source invoice evidence; deliberately stricter than legacy labor v1. */
export function invoiceHoursEvidence(raw: any): InvoiceEvidence | null {
  if (!isFinalProtractorInvoice(raw) || !guid.test(String(raw.ID ?? "")) ||
      !(recordedNumber(raw.InvoiceNumber)! > 0) || typeof raw.InvoiceTime !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T/.test(raw.InvoiceTime) || raw.InvoiceTime.startsWith("0001-")) return null;
  // Offset-less provider timestamps have historically been interpreted as UTC.
  const stamp = /(?:Z|[+-]\d{2}:\d{2})$/.test(raw.InvoiceTime) ? raw.InvoiceTime : `${raw.InvoiceTime}Z`;
  const date = new Date(stamp);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1900) return null;
  const calendar = raw.InvoiceTime.slice(0,10);
  const calendarDate = new Date(`${calendar}T00:00:00Z`);
  if (!Number.isFinite(+calendarDate) || calendarDate.toISOString().slice(0,10) !== calendar) return null;
  const conflicts = conflictingPackageHours(raw);
  const jobs = extractProtractorServicePackages(raw);
  // Do not accept estimated-only hours, nor sum repeated line IDs twice.
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
  // Full final invoices omit this property when there is no deferred work
  // (list/detail parity plus native-UI confirmation). Do not extend this to
  // explicit null/malformed collections, missing regular jobs, or legacy labor
  // evidence: identity/date/finality were verified above and hours below.
  const omittedDeferred = !Object.hasOwn(raw, "DeferredServicePackages") &&
    collection(raw.ServicePackages);
  const evidence = protractorInvoiceLaborEvidence({
    ...raw,
    ServicePackages: collection(raw.ServicePackages) ? regular : null,
    DeferredServicePackages: collection(raw.DeferredServicePackages) || omittedDeferred ? deferred : null,
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

export interface InvoiceHoursFact {
  id: string; shop_id: number; provider: string; status: string;
  source_ids?: any[]; invoice_evidence?: InvoiceEvidence | null; cached_source?: any;
}

export function aggregateInvoiceHours(facts: InvoiceHoursFact[], start: Date, end: Date) {
  const locations = new Map<number, {
    invoices: Map<string, InvoiceEvidence>;
    unknown: Map<string, string[]>;
    conflictingDates: Set<string>;
  }>();
  for (const fact of facts) {
    let location = locations.get(fact.shop_id);
    if (!location) locations.set(fact.shop_id, location = { invoices: new Map(), unknown: new Map(), conflictingDates: new Set() });
    const ids = (fact.source_ids ?? []).filter(s => s.system === fact.provider &&
      ["invoice_id", "work_order_id"].includes(s.idType)).map(s => String(s.idValue).toLowerCase());
    let evidence = fact.invoice_evidence;
    const raw = fact.cached_source?.rawPayload ?? fact.cached_source?.data;
    if (!evidence && Number(fact.cached_source?.shopId) === fact.shop_id &&
        ids.includes(String(raw?.ID).toLowerCase())) evidence = invoiceHoursEvidence(raw);
    if (fact.provider !== "protractor" || !evidence || evidence.version !== 1 ||
        !guid.test(evidence.id) || !ids.includes(evidence.id.toLowerCase()) ||
        !Number.isFinite(Date.parse(evidence.date))) {
      // A terminal label cannot establish an invoice, even when its fallback
      // close date is outside the period. Unknown dates cannot be period-filtered.
      // Known uninvoiced work is excluded regardless of provider. A verified
      // final invoice above can still override a stale normalized open label.
      if (knownUninvoiced(fact.provider,fact.status) || ["cancelled","voided"].includes(fact.status)) continue;
      const candidates = ids.map(id => `${fact.provider}:${id}`);
      location.unknown.set(candidates[0] ?? `${fact.provider}:row:${fact.id}`, candidates);
      continue;
    }
    const key = `${fact.provider}:${evidence.id.toLowerCase()}`;
    const old = location.invoices.get(key);
    if (old && Date.parse(old.date) !== Date.parse(evidence.date)) {
      location.conflictingDates.add(key);
      location.invoices.set(key, { ...old, sold: null, presented: null });
    } else if (old) {
      location.invoices.set(key, { ...old,
        sold: old.sold === evidence.sold ? old.sold : null,
        presented: old.presented === evidence.presented ? old.presented : null });
    } else location.invoices.set(key, evidence);
  }
  // Reconcile only missing evidence, after all representations are examined.
  // Date conflicts remain uncertain even when another copy is fully populated.
  const resolved = new Map([...locations].map(([id, location]) => [id, {
    invoices: [...location.invoices].filter(([key]) => !location.conflictingDates.has(key)).map(([, value]) => value),
    unknown: location.conflictingDates.size + [...location.unknown.values()]
      .filter(candidates => !candidates.some(key => location.invoices.has(key))).length,
  }]));
  const summarize = (invoices: InvoiceEvidence[], unknown: number): Partial<ReportingMetricValues> => {
    const rows = invoices.filter(r => Date.parse(r.date) >= +start && Date.parse(r.date) <= +end);
    const value: Partial<ReportingMetricValues> = { invoiceCount: rows.length, invoicePopulationUnknown: unknown };
    for (const [field, sumKey, coveredKey, averageKey] of [
      ["sold", "invoiceSoldHours", "invoiceSoldCovered", "averageSoldHoursPerInvoice"],
      ["presented", "invoicePresentedHours", "invoicePresentedCovered", "averagePresentedHoursPerInvoice"],
    ] as const) {
      const hours = rows.map(r => recordedNumber(r[field])).filter((n): n is number => n !== null && n >= 0);
      const sum = hours.reduce((a, b) => a + b, 0);
      value[sumKey] = sum;
      value[coveredKey] = hours.length;
      value[averageKey] = !unknown && rows.length && hours.length === rows.length ? sum / rows.length : null;
    }
    return value;
  };
  return {
    summary: summarize([...resolved.values()].flatMap(v => v.invoices), [...resolved.values()].reduce((n,v) => n + v.unknown, 0)),
    locations: new Map([...resolved].map(([id,v]) => [String(id), summarize(v.invoices, v.unknown)])),
    empty: summarize([], 0),
  };
}
