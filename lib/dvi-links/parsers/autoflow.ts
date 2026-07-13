// Task #860: AutoFlow microsite parser (best-effort — links expire with
// "Invalid id!"; we already receive AutoFlow DVI data via existing paths).
//
// *.autotext.me/Admin/microsite/ pages embed everything server-side:
//   var defaults = {}; defaults["items"] = {...}; defaults["config"] = {...};
// Item statuses: inspec_status "0"=red, "1"=orange, "2"=green (from
// jquery.atme.customerdvi.js). Item names come from
// defaults["config"].categories[<catId>].items[<inspecId>]. Pure module.
import type { DviParseResult, DviSeverity, ParsedDviItem } from "../types";
import { parseJsonAfterMarker, cleanText, toIntOrNull } from "../parse-utils";

const SEVERITY_BY_STATUS: Record<string, DviSeverity> = {
  "0": "required",
  "1": "suggested",
  "2": "ok",
};

export function parseAutoFlowMicrosite(
  body: string,
  _sourceUrl: string,
): DviParseResult {
  if (/invalid\s+id!?/i.test(body.slice(0, 4000)) && body.length < 20000) {
    return { ok: false, error: "expired microsite (Invalid id!)" };
  }
  if (!body.includes("var defaults")) {
    return { ok: false, error: "defaults block not found (page format change?)" };
  }

  // Assignments use one or two spaces: defaults["items"]  = {...};
  const items = parseDefaultsKey<Record<string, any>>(body, "items");
  const config = parseDefaultsKey<any>(body, "config");
  const customer = parseDefaultsKey<any>(body, "customer");

  if (!items || Object.keys(items).length === 0) {
    return { ok: false, error: "no inspection items embedded in microsite" };
  }

  // inspec_id → { name, section } from config.categories.
  const nameById = new Map<string, { name: string; section: string | null }>();
  const categories = config?.categories;
  if (categories && typeof categories === "object") {
    for (const cat of Object.values<any>(categories)) {
      const section = cleanText(cat?.name);
      const catItems = cat?.items;
      if (!catItems || typeof catItems !== "object") continue;
      for (const [id, label] of Object.entries(catItems)) {
        const name = cleanText(label);
        if (name) nameById.set(String(id), { name, section });
      }
    }
  }

  const counts = { required: 0, suggested: 0, ok: 0, info: 0 };
  const parsed: ParsedDviItem[] = [];
  for (const [id, it] of Object.entries(items)) {
    const severity = SEVERITY_BY_STATUS[String(it?.inspec_status ?? "")];
    if (!severity) continue;
    const known = nameById.get(String(it?.inspec_id ?? id));
    const name = known?.name ?? `Inspection item ${id}`;
    counts[severity]++;
    parsed.push({
      name,
      section: known?.section ?? null,
      severity,
      finding: null,
      recommendation: cleanText(it?.recommendation),
      notes: cleanText(it?.notes),
      photoUrls: [],
    });
  }

  if (parsed.length === 0) {
    return { ok: false, error: "no classifiable inspection items in microsite" };
  }

  const odometer =
    toIntOrNull(customer?.mileage) ?? toIntOrNull(customer?.kilometer);
  const odometerUnit =
    toIntOrNull(customer?.mileage) !== null
      ? "miles"
      : toIntOrNull(customer?.kilometer) !== null
        ? "km"
        : null;

  return {
    ok: true,
    report: {
      provider: "autoflow",
      vin: cleanText(customer?.vin)?.toUpperCase() ?? null,
      odometer,
      odometerUnit,
      roNumber: cleanText(customer?.invoice),
      inspectionName: null,
      inspectionDate: cleanText(customer?.etc),
      technician: null,
      advisor: null,
      shopName: cleanText(parseDefaultsScalar(body, "shop_name")),
      counts,
      items: parsed,
    },
  };
}

function parseDefaultsKey<T>(body: string, key: string): T | null {
  // Tolerate variable whitespace around "=".
  const re = new RegExp(`defaults\\["${key}"\\]\\s*=\\s*`);
  const m = re.exec(body);
  if (!m) return null;
  return parseJsonAfterMarker<T>(body.slice(m.index), `defaults["${key}"]`);
}

function parseDefaultsScalar(body: string, key: string): string | null {
  const re = new RegExp(`defaults\\["${key}"\\]\\s*=\\s*"([^"]*)"`);
  const m = re.exec(body);
  return m ? m[1] : null;
}
