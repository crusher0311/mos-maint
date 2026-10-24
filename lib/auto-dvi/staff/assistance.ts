import { z } from "zod";
import { writeContext, type StaffDependencies } from "./service";
import type { StaffInspection } from "./model";
import { requireThat } from "@/lib/shop-dispatch/model";

/** Pure dependency boundary: only exact current-shop provider IDs reach the
 * cache reader; assistance cannot mutate evidence or choose a visit by VIN. */
export async function prepareVisitAssistance(visitId: unknown, revision: unknown, deps: StaffDependencies,
  readVehicle: (shop: number, sourceId: string) => Promise<{sourceId: string; vin: string} | null>) {
  const id = z.string().min(1).max(100).parse(visitId);
  requireThat(revision !== undefined && revision !== null && revision !== "", "Current inspection revision required", 400);
  const expected = z.coerce.number().int().nonnegative().parse(revision);
  const context = await writeContext(id, deps);
  const inspection = context.record.results.staff as StaffInspection | undefined;
  requireThat(inspection && inspection.revision === expected, "Inspection changed; reload before requesting suggestions", 409);
  const candidates = inspection.sheets.filter(s => s.active).flatMap(s => s.sheet.items.map(item => ({
    itemId: `${s.key}/${item.id}`, name: `${item.name}${item.position ? ` (${item.position})` : ""}`,
    sheet: s.key, item: item.id, serviceKey: null,
  })));
  const targets = candidates.filter(t => candidates.filter(other => other.name.toLowerCase() === t.name.toLowerCase()).length === 1);
  requireThat(targets.length <= 200, "Select fewer active sheets before requesting assistance", 409);
  return {
    shopId: context.access.shopId, visitId: id, revision: expected, targets,
    async vehicle() {
      const visit = context.board.visits.find(v => v.id === id)!;
      let vin = visit.intake?.details.newVehicle?.vin;
      if (visit.provider === "protractor" && visit.sourceId) {
        const row = await readVehicle(context.access.shopId, visit.sourceId);
        requireThat(row && row.sourceId === visit.sourceId, "Canonical vehicle context is unavailable; use manual checks", 409);
        vin = row.vin;
      }
      requireThat(vin && /^[A-HJ-NPR-Z0-9]{17}$/.test(vin.toUpperCase()), "Verified visit VIN unavailable; use manual inspection", 409);
      return {vin: vin.toUpperCase(), mileage: visit.intake?.details.mileage ?? null};
    },
    async revalidate() {
      const latest = await writeContext(id, deps, {...context.access, identity: context.record.identity});
      requireThat((latest.record.results.staff as StaffInspection)?.revision === expected,
        "Inspection changed while suggestions were prepared; request them again", 409);
    },
  };
}
