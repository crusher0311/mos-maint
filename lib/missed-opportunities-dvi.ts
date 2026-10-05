import {
  engagementFromTekmetric, evidenceTimestamp, tekmetricRoId, unknownDviEngagement,
  type DviEngagement, type TekmetricDviRecord,
} from "@/lib/dvi-engagement";
import { withinProviderCacheBudget } from "@/lib/missed-opportunities-provider-cache";

/**
 * Cache-only, one batch, never by VIN or display RO number. Inject the reader so
 * deadline/isolation tests cannot accidentally reach a live database.
 */
export async function loadReportDviEngagement(
  shopId: number,
  rows: Array<{ id: string; provenance: unknown }>,
  read: (shopId: number, roIds: string[], budgetMs: number) => Promise<TekmetricDviRecord[]>,
  budgetMs = 1_000,
): Promise<Map<string, DviEngagement>> {
  const result = new Map(rows.map(row => [row.id, unknownDviEngagement()]));
  const selected = rows.slice(0, 300).map(row => ({ id: row.id, roId: tekmetricRoId(row.provenance) }));
  const roIds = [...new Set(selected.flatMap(row => row.roId ? [row.roId] : []))];
  if (!roIds.length || budgetMs <= 0) return result;
  try {
    const batch = await withinProviderCacheBudget(
      () => read(shopId, roIds, budgetMs), [] as TekmetricDviRecord[], budgetMs,
    );
    const byId = new Map<string, TekmetricDviRecord>();
    for (const record of batch.value) {
      if (!roIds.includes(record.workOrderId)) continue;
      // Mixed string/number legacy keys can yield duplicates. Keep earliest
      // evidence independently, rather than letting cursor order choose it.
      const previous = byId.get(record.workOrderId);
      const merged = { workOrderId: record.workOrderId } as TekmetricDviRecord;
      for (const key of ["dviInspectionSharedAt", "dviInspectionViewReceivedAt", "inspectionShareDate"] as const) {
        const times = [previous?.[key], record[key]].map(evidenceTimestamp)
          .filter((v): v is string => typeof v === "string").sort();
        if (times.length) merged[key] = times[0];
      }
      byId.set(record.workOrderId, merged);
    }
    for (const row of selected) {
      if (row.roId) result.set(row.id, engagementFromTekmetric(byId.get(row.roId)));
    }
  } catch {
    // Optional enrichment must not fail the report or start upstream recovery.
    console.warn("[MissedOpps] DVI evidence unavailable; engagement remains unknown");
  }
  return result;
}
