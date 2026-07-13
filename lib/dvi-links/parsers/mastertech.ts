// Task #860: MasterTech.ai parser (best-effort — zero live links exist in
// production data today, so this is built defensively from the public page
// format: app.mastertech.ai/vin/<vin> overdue-services reports).
//
// Strategy: prefer an embedded JSON payload (__NEXT_DATA__ or similar);
// fall back to scanning rendered HTML for overdue / up-to-date service
// rows. Failures are loud so a real link exercising this parser surfaces
// on the health page immediately. Pure module (tsx-testable).
import type { DviParseResult, ParsedDviItem } from "../types";
import { parseJsonAfterMarker, cleanText } from "../parse-utils";

export function parseMasterTechReport(
  body: string,
  sourceUrl: string,
): DviParseResult {
  // VIN commonly appears in the URL path: /vin/<VIN>
  const vinMatch = /\/vin\/([A-HJ-NPR-Z0-9]{11,17})/i.exec(sourceUrl);
  const vin = vinMatch ? vinMatch[1].toUpperCase() : null;

  const items: ParsedDviItem[] = [];
  const counts = { required: 0, suggested: 0, ok: 0, info: 0 };

  // 1) Embedded Next.js data blob, if present.
  const nextData = parseJsonAfterMarker<any>(body, '__NEXT_DATA__" type="application/json">');
  const services = findServiceArray(nextData);
  if (services) {
    for (const svc of services) {
      const name = cleanText(svc?.name ?? svc?.service ?? svc?.title);
      if (!name) continue;
      const overdue =
        svc?.overdue === true ||
        String(svc?.status ?? "").toLowerCase().includes("overdue") ||
        String(svc?.status ?? "").toLowerCase() === "due";
      const severity = overdue ? "required" : "ok";
      counts[severity]++;
      items.push({ name, severity, notes: cleanText(svc?.notes) });
    }
  }

  // 2) HTML fallback: rows/badges containing Overdue / Up to date wording.
  if (items.length === 0) {
    const rowRe =
      /([A-Z][A-Za-z /&-]{2,60})\s*(?:<[^>]+>\s*)*?(Overdue|Past Due|Due Now|Up to Date|Up-to-date)/gi;
    let m: RegExpExecArray | null;
    while ((m = rowRe.exec(body)) !== null) {
      const name = cleanText(m[1]);
      if (!name) continue;
      const overdue = !/up.?to.?date/i.test(m[2]);
      const severity = overdue ? "required" : "ok";
      counts[severity]++;
      items.push({ name, severity });
    }
  }

  if (items.length === 0) {
    return {
      ok: false,
      error: "no services recognized in MasterTech report (format unverified — needs a live sample)",
    };
  }

  return {
    ok: true,
    report: {
      provider: "mastertech",
      vin,
      odometer: null,
      roNumber: null,
      inspectionName: "MasterTech maintenance report",
      inspectionDate: null,
      counts,
      items,
    },
  };
}

/** Walks an unknown JSON tree looking for an array of service-ish objects. */
function findServiceArray(node: any, depth = 0): any[] | null {
  if (!node || depth > 6) return null;
  if (Array.isArray(node)) {
    if (
      node.length > 0 &&
      node.every(
        (e) =>
          e &&
          typeof e === "object" &&
          ("overdue" in e || "status" in e) &&
          ("name" in e || "service" in e || "title" in e),
      )
    ) {
      return node;
    }
    for (const child of node) {
      const found = findServiceArray(child, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof node === "object") {
    for (const value of Object.values(node)) {
      const found = findServiceArray(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
}
