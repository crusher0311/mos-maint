// Task #860: expose parsed DVI share-link findings to VHI plan-build.
//
// Findings only ever BUMP severity (required → red "0", suggested →
// yellow "1") through the existing dviFindings channel — they are never
// used as history anchors, so an inspect-only finding can never reset a
// replace clock (same verb-guard discipline as CARFAX anchoring).
//
// All three plan-build paths (dashboard API route, dashboard page, and the
// extension's on-demand branch) call this one helper so they can never
// disagree.
import { findParsedDviReportsByVin } from "@/lib/data/repositories/dvi-links";

/** Ignore findings from inspections older than this. */
const MAX_FINDING_AGE_DAYS = 365;

export interface DviLinkFinding {
  name?: string;
  /** "0" = red/required, "1" = yellow/suggested (plan-build convention). */
  status?: string | number;
  /** Provider id — becomes the item's dviSource. */
  source?: string;
  finding?: string;
  notes?: string | null;
  inspectionDate?: string | null;
}

/**
 * Returns red/yellow findings from parsed DVI share-link reports for this
 * shop + VIN, newest report per provider only, deduped by item name.
 * Read-only; returns [] on any failure (plan-build must never break on a
 * DVI-link hiccup) but logs loudly.
 */
export async function gatherDviLinkFindings(
  shopId: string | number,
  vin: string,
): Promise<DviLinkFinding[]> {
  try {
    const docs = await findParsedDviReportsByVin(String(shopId), vin, 10);
    if (docs.length === 0) return [];
    const out = selectDviLinkFindings(docs);
    if (out.length > 0) {
      console.log(
        `[PlanBuild] DVI share-link findings for ${vin}: ${out.length} item(s)`,
      );
    }
    return out;
  } catch (e: any) {
    console.warn(
      `[PlanBuild] DVI share-link finding lookup failed for ${vin}: ${e?.message || e}`,
    );
    return [];
  }
}

/** Minimal doc shape `selectDviLinkFindings` needs (matches DviLinkDoc). */
export interface DviReportDocLike {
  parsedAt?: Date | null;
  report?: {
    provider: string;
    inspectionDate?: string | null;
    items: Array<{
      name: string;
      severity: string;
      finding?: string | null;
      notes?: string | null;
      recommendation?: string | null;
    }>;
  } | null;
}

/**
 * Pure selection logic (exported for tests): newest report per provider,
 * ≤365d old, only required/suggested items, deduped by name.
 */
export function selectDviLinkFindings(
  docs: DviReportDocLike[],
  now = Date.now(),
): DviLinkFinding[] {
  {
    const cutoff = now - MAX_FINDING_AGE_DAYS * 24 * 60 * 60 * 1000;
    // Newest report per provider wins (an older report's findings are
    // superseded by the shop's newer inspection on the same platform).
    const newestByProvider = new Map<string, (typeof docs)[number]>();
    for (const doc of docs) {
      const report = doc.report;
      if (!report) continue;
      const t = reportTime(report.inspectionDate, doc.parsedAt ?? null);
      if (t !== null && t < cutoff) continue;
      const existing = newestByProvider.get(report.provider);
      if (!existing) {
        newestByProvider.set(report.provider, doc);
        continue;
      }
      const existingT = reportTime(
        existing.report?.inspectionDate ?? null,
        existing.parsedAt ?? null,
      );
      if ((t ?? 0) > (existingT ?? 0)) newestByProvider.set(report.provider, doc);
    }

    const out: DviLinkFinding[] = [];
    const seenNames = new Set<string>();
    for (const doc of Array.from(newestByProvider.values())) {
      const report = doc.report!;
      for (const item of report.items) {
        if (item.severity !== "required" && item.severity !== "suggested") {
          continue;
        }
        const nameKey = item.name.toLowerCase().trim();
        if (!nameKey || seenNames.has(nameKey)) continue;
        seenNames.add(nameKey);
        out.push({
          name: item.name,
          status: item.severity === "required" ? "0" : "1",
          source: report.provider,
          finding: item.finding ?? undefined,
          notes: item.notes ?? item.recommendation ?? null,
          inspectionDate: report.inspectionDate ?? null,
        });
      }
    }
    return out;
  }
}

function reportTime(
  inspectionDate: string | null | undefined,
  fallback: Date | null,
): number | null {
  if (inspectionDate) {
    const t = Date.parse(inspectionDate);
    if (Number.isFinite(t)) return t;
  }
  return fallback ? fallback.getTime() : null;
}
