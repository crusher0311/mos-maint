import { z } from "zod";
import type { Board } from "@/lib/shop-dispatch/model";
import { requireThat } from "@/lib/shop-dispatch/model";
import type { StaffAccess } from "./access";
import { terminalSourceStatus } from "@/lib/shop-dispatch/source-preferences";

const vinSchema = z.string().trim().toUpperCase().regex(/^[A-HJ-NPR-Z0-9]{17}$/);
export interface VisitVehicleReference { sourceId: string; vin: string }
export interface VisitSelectionDependencies {
  access(): Promise<StaffAccess>;
  read(shop: number): Promise<Board>;
  references(shop: number, ids: string[]): Promise<VisitVehicleReference[]>;
}
/** VIN narrows a read-only list; it never selects or creates an inspection.
 * Missing/ambiguous canonical references are not inferred from displayed text. */
export async function listInspectionVisits(rawVin: unknown, deps: VisitSelectionDependencies) {
  const vin = vinSchema.parse(rawVin), access = await deps.access();
  const board = await deps.read(access.shopId);
  requireThat(board.visits.length <= 500, "Visit list exceeds safe selection capacity", 409);
  const ids = board.visits.filter(v => v.provider === "protractor" && v.sourceId).map(v => v.sourceId!);
  const references = await deps.references(access.shopId, ids);
  const visits = board.visits.filter(v => {
    if (v.provider === "manual") return v.intake?.details.newVehicle?.vin === vin;
    const matches = references.filter(r => r.sourceId === v.sourceId);
    return matches.length > 0 && matches.every(r => r.vin.toUpperCase() === vin);
  }).map(v => ({
    visitId: v.id, ro: v.ro, vehicle: v.vehicle, provider: v.provider,
    closed: v.closed || v.provider === "protractor" && terminalSourceStatus(v.sourceStatus),
  }));
  const fresh = await deps.access();
  requireThat(fresh.shopId === access.shopId && fresh.actor === access.actor, "Access changed", 403);
  return {visits, enabled: fresh.enabled,
    notice: "Choose the intended visit explicitly. Unmapped visits are available through Shop Workflow; a VIN or displayed RO number never selects saved evidence."};
}
