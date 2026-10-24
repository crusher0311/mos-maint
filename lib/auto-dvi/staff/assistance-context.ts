import { createHash } from "node:crypto";
import { staffDependencies } from "./runtime";
import { findCachedWorkOrderById } from "@/lib/data/repositories/protractor-work-orders";
import { prepareVisitAssistance } from "./assistance";

/** No VIN-authorized edits, caller checklist, or provider probe. This context
 * is revalidated after assistance and the ordinary command CAS fences acceptance. */
export async function visitAssistanceContext(visitId: unknown, revision: unknown) {
  return prepareVisitAssistance(visitId, revision, staffDependencies, async (shop, sourceId) => {
    const row = await findCachedWorkOrderById(shop, sourceId);
    return row && typeof row.vin === "string" && typeof row.workOrderId === "string"
      ? {sourceId: row.workOrderId, vin: row.vin} : null;
  });
}
export function suggestionId(source: string, reference: string) {
  return createHash("sha256").update(`${source}|${reference}`).digest("hex").slice(0, 40);
}
