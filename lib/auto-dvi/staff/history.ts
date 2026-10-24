import {snapshot, currentVisit, type StaffDependencies} from "./service";
import {requireThat} from "@/lib/shop-dispatch/model";
import type {InspectionResultsDoc} from "@/lib/data/repositories/auto-dvi";
import {CATALOG, type VisitRecord} from "../visit-model";

export interface HistoryDependencies {
  staff: StaffDependencies;
  vehicle(shop: number, sourceId: string): Promise<string | null>;
  legacy(shop: number, vin: string): Promise<InspectionResultsDoc | null>;
  intermediate(shop: number, vin: string): Promise<VisitRecord>;
  imported?(shop: number, vin: string): Promise<{vin?: unknown; source?: unknown; fetchedAt?: unknown; categories?: unknown} | null>;
}
export interface HistoricalMedia {id: string; kind: "photo" | "video"; name: string | null; origin: "legacy" | "intermediate"; recordId: string}
export interface HistoricalRow {id: string; source: string; date: string | null; items: {
  id: string; title: string; rating: string | null; notes: string | null; recommendation: string | null;
  values: Record<string, string | number>; media: HistoricalMedia[];
}[]}
/** Compatibility reads only. No cross-shop sharing or evidence promotion. */
export async function inspectionHistory(visitId: string, deps: HistoryDependencies) {
  const access = await deps.staff.access();
  await snapshot(visitId, deps.staff);
  const board = await deps.staff.board.read(access.shopId);
  const visit = currentVisit(board, visitId);
  const vin = visit.provider === "protractor" && visit.sourceId
    ? await deps.vehicle(access.shopId, visit.sourceId) : visit.intake?.details.newVehicle?.vin;
  requireThat(vin && /^[A-HJ-NPR-Z0-9]{17}$/.test(vin), "Canonical VIN unavailable for historical lookup", 409);
  const [legacy, intermediate, imported] = await Promise.all([deps.legacy(access.shopId, vin), deps.intermediate(access.shopId, vin),
    deps.imported?.(access.shopId, vin)]);
  const rows: HistoricalRow[] = [
    ...(legacy ? [{id: "legacy-vin", source: "Legacy VIN-level Auto DVI", date: legacy.updatedAt ? String(legacy.updatedAt) : null,
      items: legacy.items.slice(0, 100).map(i => ({id: i.itemId, title: i.name, rating: i.rating,
        notes: i.notes, recommendation: i.recommendation, values: {}, media: i.media.slice(0, 6).map(m => ({
          id: m.mediaId, kind: m.kind, name: m.filename, origin: "legacy" as const, recordId: "",
        }))}))}] : []),
    ...intermediate.visits.slice(-100).map(v => ({id: v.id, source: "Intermediate inspection · historical reference",
      date: v.completedAt ?? v.createdAt, items: Object.entries(v.results).slice(0, 100).map(([id, i]) => ({
        id, title: CATALOG.find(c => c.id === id)?.name ?? id, rating: i.rating, notes: i.notes,
        recommendation: i.recommendation, values: i.values, media: i.media.slice(0, 6).map(m => ({
          id: m.mediaId, kind: m.kind, name: m.filename, origin: "intermediate" as const, recordId: v.id,
        })),
      }))})),
  ];
  if (imported && imported.vin === vin && Array.isArray(imported.categories)) {
    const text = (v: unknown) => typeof v === "string" || typeof v === "number" ? String(v).slice(0, 2000) : "";
    const items: HistoricalRow["items"] = [];
    for (const category of imported.categories.slice(0, 60)) {
      if (!category || !Array.isArray(category.items)) continue;
      for (const item of category.items.slice(0, 100)) {
        if (!item || items.length >= 100) continue;
        items.push({id: `provider-${items.length}`, title: text(item.name), rating: text(item.status) || null,
          notes: text(item.notes), recommendation: null, values: {}, media: []});
      }
    }
    rows.push({id: "provider-reference", source: `Imported ${text(imported.source) || "provider"} · reference only`,
      date: imported.fetchedAt instanceof Date ? imported.fetchedAt.toISOString() : text(imported.fetchedAt) || null, items});
  }
  const fresh = await deps.staff.access();
  requireThat(fresh.shopId === access.shopId && fresh.actor === access.actor, "History access changed", 403);
  const latest = currentVisit(await deps.staff.board.read(fresh.shopId), visitId);
  requireThat(latest.provider === visit.provider && latest.sourceId === visit.sourceId &&
    latest.intake?.details.newVehicle?.vin === visit.intake?.details.newVehicle?.vin, "Visit identity changed", 409);
  return {rows, notice: "Reference only: retained legacy snapshot, up to 100 intermediate records and the latest retained provider snapshot (up to 100 items per record). This is not a complete inspection archive. These findings do not establish current inspection, repair authorization or service completion."};
}
