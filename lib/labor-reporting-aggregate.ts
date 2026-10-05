import { LABOR_BANDS, LABOR_BAND_LABELS, laborBand, recordedNumber } from "./labor-reporting-contract";
import type { ReportingMetricValues } from "./reporting-kpi-contract";
import { protractorInvoiceLaborEvidence } from "./integrations/protractor/labor-evidence";

export interface LaborFact {
  id: string; shop_id: number; provider: string; business_date: string;
  sold: unknown; presented: unknown; net: unknown;
  cached_source?: any;
  has_refund?: boolean;
  source_ids?: any[];
}
export function aggregateLaborFacts(facts: LaborFact[]) {
  const recovered = facts.map(f => {
    const raw = f.cached_source?.rawPayload ?? f.cached_source?.data;
    const date = raw?.InvoiceTime ? new Date(raw.InvoiceTime) : null;
    // Never apply a current/open or differently dated cache snapshot to an
    // historical terminal invoice. Invalid/missing dates stay unknown.
    if (f.provider !== "protractor" || !date || !Number.isFinite(date.getTime()) ||
        date.toISOString().slice(0,10) !== f.business_date) return f;
    const evidence = protractorInvoiceLaborEvidence(raw);
    return evidence ? { ...f, sold: evidence.sold,
      presented: evidence.presented,
      net: f.has_refund ? null : evidence.net } : f;
  });
  const unique = [...new Map(recovered.map(f => [`${f.shop_id}:${f.id}`, f])).values()];
  const summarize = (rows: LaborFact[]): Partial<ReportingMetricValues> => {
    const values: Partial<ReportingMetricValues> = { laborClosedROCount: rows.length };
    for (const [field, valueKey, coverageKey] of [
      ["sold", "soldLaborHours", "soldLaborCoveredROs"],
      ["presented", "presentedLaborHours", "presentedLaborCoveredROs"],
      ["net", "netLaborSales", "netLaborCoveredROs"],
    ] as const) {
      const supported = rows.filter(r => r.provider === "protractor")
        .map(r => recordedNumber(r[field])).filter((n): n is number => n !== null);
      values[valueKey] = supported.length ? Math.round(supported.reduce((a,b) => a+b,0)*100)/100 : null;
      values[coverageKey] = supported.length;
    }
    return values;
  };
  const by = (key: (f: LaborFact) => string) => {
    const groups = new Map<string, LaborFact[]>();
    for (const row of unique) {
      const k = key(row);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(row);
    }
    return new Map([...groups].map(([k, rows]) => [k, summarize(rows)]));
  };
  return {
    summary: summarize(unique),
    locations: by(f => String(f.shop_id)),
    dates: by(f => f.business_date),
    bands: LABOR_BANDS.map(key => ({
      key, label: LABOR_BAND_LABELS[key],
      metrics: summarize(unique.filter(f => laborBand(f.provider === "protractor" ? recordedNumber(f.sold) : null) === key)),
    })),
  };
}
