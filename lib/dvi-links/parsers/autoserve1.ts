// Task #860: AutoServe1 share-link parser.
//
// app.autoserve1.com/report/<id> pages are server-rendered with the full
// report JSON inline: riot.mount("report", {...}). The findings live in
// inspectionOrder.results as { ok: [...], warning: [...], critical: [...] }.
// NOTE: links can expire server-side (HTTP 500, empty body) — the fetcher
// classifies that before this parser ever runs. Pure module (tsx-testable).
import type {
  DviParseResult,
  DviSeverity,
  ParsedDviItem,
  DviMeasurement,
} from "../types";
import { extractBalancedJson, cleanText, toIntOrNull, decamel } from "../parse-utils";

const SEVERITY_BY_BUCKET: Record<string, DviSeverity> = {
  ok: "ok",
  okay: "ok",
  warning: "suggested",
  critical: "required",
};

export function parseAutoServe1Report(
  body: string,
  _sourceUrl: string,
): DviParseResult {
  const marker = 'riot.mount("report"';
  const i = body.indexOf(marker);
  if (i < 0) {
    return { ok: false, error: "riot.mount(\"report\") not found (page format change?)" };
  }
  const raw = extractBalancedJson(body, i + marker.length);
  if (!raw) return { ok: false, error: "could not brace-match report JSON" };
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `report JSON parse failed: ${String(e)}` };
  }

  const io = data.inspectionOrder ?? {};
  const results = io.results ?? {};
  const vehicle = io.vehicle ?? {};
  const counts = { required: 0, suggested: 0, ok: 0, info: 0 };
  const items: ParsedDviItem[] = [];

  for (const bucket of Object.keys(results)) {
    const severity = SEVERITY_BY_BUCKET[bucket.toLowerCase()];
    if (!severity) continue;
    const entries = Array.isArray(results[bucket]) ? results[bucket] : [];
    for (const entry of entries) {
      // Two shapes observed: flat result objects (ok bucket) and wrappers
      // { itemKey, i18n, result: [...] } (warning/critical buckets).
      const inner = Array.isArray(entry?.result) ? entry.result : [entry];
      const i18n = entry?.i18n ?? {};
      for (const r of inner) {
        if (!r || typeof r !== "object") continue;
        const name =
          cleanText(r?.text?.itemKey) ??
          cleanText(i18n?.itemKey) ??
          (r.itemKey ? decamel(String(r.itemKey)) : null);
        if (!name) continue;
        const finding =
          cleanText(r?.text?.finding) ??
          cleanText(i18n?.finding) ??
          (r.finding ? decamel(String(r.finding)) : null);
        const recommendation =
          cleanText(r?.text?.recommendation) ??
          cleanText(i18n?.recommendation) ??
          (r.recommendation ? decamel(String(r.recommendation)) : null);
        const photoUrls = (Array.isArray(r.pictures) ? r.pictures : [])
          .map((p: any) => cleanText(p?.url))
          .filter((u: string | null): u is string => !!u);
        const measurements: DviMeasurement[] = (
          Array.isArray(r.measurements) ? r.measurements : []
        )
          .map((m: any) => ({
            name: cleanText(m?.name ?? m?.itemKey ?? m?.key) ?? "",
            value: cleanText(m?.value ?? m?.measurement) ?? "",
            unit: cleanText(m?.unit),
          }))
          .filter((m: DviMeasurement) => m.name && m.value);
        counts[severity]++;
        items.push({
          name,
          section: cleanText(r.group) ? decamel(String(r.group)) : null,
          severity,
          finding,
          recommendation,
          notes: cleanText(r.note),
          measurements,
          photoUrls,
        });
      }
    }
  }

  if (items.length === 0) {
    return { ok: false, error: "no inspection results found in report JSON" };
  }

  return {
    ok: true,
    report: {
      provider: "autoserve1",
      vin: cleanText(vehicle.vin)?.toUpperCase() ?? null,
      odometer: toIntOrNull(vehicle.mileage),
      odometerUnit: null,
      roNumber: cleanText(data.roNumber) ?? cleanText(io.orderNumber),
      inspectionName: cleanText(data.inspection?.name),
      inspectionDate: cleanText(io.inspectionFinishedDate) ?? cleanText(io.date),
      technician: cleanText(io.technician?.name),
      advisor: cleanText(io.advisor?.name),
      shopName: cleanText(data.store?.name),
      counts,
      items,
    },
  };
}
