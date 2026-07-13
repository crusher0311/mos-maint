// Task #860: AutoVitals share-link parser.
//
// avlink.io short links 302-redirect to tvpx.autovitals.com/InspectionResults.aspx
// whose HTML embeds the full inspection model inline:
//   av.settings = { inspection: { Table..Table19 } }
// Table1 = shop, Table3 = vehicle/customer/RO, Table7 = inspection name/date,
// Table8 = topics (findings), Table9 = statuses, Table10 = sections,
// Table13 = topic photos. Pure module (tsx-testable).
import type { DviParseResult, DviSeverity, ParsedDviItem } from "../types";
import { extractBalancedJson, cleanText, toIntOrNull } from "../parse-utils";

interface AvStatus {
  StatusId: number;
  Name?: string;
  StatusColor?: string;
}

function severityForStatus(status: AvStatus | undefined): DviSeverity | null {
  if (!status) return null;
  const color = (status.StatusColor || "").toUpperCase();
  const name = (status.Name || "").toLowerCase();
  // Colors are shop-configurable in theory; match both color and wording.
  if (color === "FF0A12" || name.includes("immediate")) return "required";
  if (color === "FFFF00" || name.includes("future")) return "suggested";
  if (color === "33CC00" || name === "good" || name.includes("ok")) return "ok";
  if (color === "C47DFF" || name.includes("information")) return "info";
  // Red-ish / yellow-ish fallback by hex heuristic.
  if (/^F{1,2}[0-9A-F]{0,2}0/.test(color)) return "required";
  return "info";
}

export function parseAutoVitalsReport(
  body: string,
  _sourceUrl: string,
): DviParseResult {
  const settingsIdx = body.indexOf("av.settings");
  if (settingsIdx < 0) {
    return { ok: false, error: "av.settings block not found (page format change?)" };
  }
  const inspIdx = body.indexOf("inspection:", settingsIdx);
  if (inspIdx < 0) {
    return { ok: false, error: "inspection JSON not found in av.settings" };
  }
  const raw = extractBalancedJson(body, inspIdx + "inspection:".length);
  if (!raw) return { ok: false, error: "could not brace-match inspection JSON" };
  let insp: any;
  try {
    insp = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `inspection JSON parse failed: ${String(e)}` };
  }

  const shop = insp.Table1?.[0] ?? {};
  const veh = insp.Table3?.[0] ?? {};
  const meta = insp.Table7?.[0] ?? {};
  const topics: any[] = Array.isArray(insp.Table8) ? insp.Table8 : [];
  const statuses = new Map<number, AvStatus>(
    (Array.isArray(insp.Table9) ? insp.Table9 : []).map((s: AvStatus) => [
      s.StatusId,
      s,
    ]),
  );
  const sections = new Map<number, string>(
    (Array.isArray(insp.Table10) ? insp.Table10 : []).map((s: any) => [
      s.SectionId,
      s.Name,
    ]),
  );
  const photosByTopic = new Map<number, string[]>();
  for (const p of Array.isArray(insp.Table13) ? insp.Table13 : []) {
    if (!p?.TopicId || !p?.FileUrl) continue;
    if (p.VisibleToCustomer === false) continue;
    const list = photosByTopic.get(p.TopicId) ?? [];
    list.push(String(p.FileUrl));
    photosByTopic.set(p.TopicId, list);
  }

  const counts = { required: 0, suggested: 0, ok: 0, info: 0 };
  const items: ParsedDviItem[] = [];
  for (const t of topics) {
    const name = cleanText(t?.Name);
    if (!name) continue;
    const severity = severityForStatus(statuses.get(t.StatusId));
    if (!severity) continue; // topic with no assigned status = not inspected
    counts[severity]++;
    items.push({
      name,
      section: cleanText(sections.get(t.SectionId)) ?? null,
      severity,
      finding: null,
      recommendation: null,
      notes:
        cleanText(t.CustomerNotes) ??
        cleanText(t.ShopNotes) ??
        cleanText(t.MeasurementNotes),
      photoUrls: photosByTopic.get(t.TopicId) ?? [],
    });
  }

  if (items.length === 0) {
    return { ok: false, error: "no inspected topics found in report" };
  }

  return {
    ok: true,
    report: {
      provider: "autovitals",
      vin: cleanText(veh.Vin)?.toUpperCase() ?? null,
      odometer: toIntOrNull(veh.Odometer),
      odometerUnit: cleanText(veh.OdometerUnit),
      roNumber: cleanText(veh.RepairOrderId),
      inspectionName: cleanText(meta.Name),
      inspectionDate: cleanText(meta.InspectionDate),
      technician: joinName(veh.TechnicianFirstName, veh.TechnicianLastName),
      advisor: joinName(
        veh.ServiceAdvisorFirstName,
        veh.ServiceAdvisorLastName,
      ),
      shopName: cleanText(shop.ShopName),
      counts,
      items,
    },
  };
}

function joinName(first: unknown, last: unknown): string | null {
  const f = cleanText(first);
  const l = cleanText(last);
  if (!f && !l) return null;
  return [f, l].filter(Boolean).join(" ");
}
