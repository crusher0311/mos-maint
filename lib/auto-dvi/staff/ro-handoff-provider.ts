import { fetchWorkOrderById } from "@/lib/integrations/protractor/client";
import { runWithProtractorInteractiveTransport } from "@/lib/integrations/protractor/interactive-context";
import { upsertProtractorWorkOrderSnapshot } from "@/lib/integrations/protractor";
import { touchDashboardUpdate } from "@/lib/data/repositories/shopware-cache";
import { mapProtractorWorkOrder } from "@/lib/shop-dispatch/protractor";
import { requireThat } from "@/lib/shop-dispatch/model";

/** A handoff retry reads the existing native ID; it never submits an RO. */
export async function fetchGuidedROIntake(shopId: number, id: string) {
  return runWithProtractorInteractiveTransport(shopId, async () => {
    const result = await fetchWorkOrderById(shopId,id,{priority:true,timeoutMs:12000,maxRetries:0});
    requireThat(result.ok && result.workOrder,
      "RO is confirmed, but Protractor could not be read for DVI. Wait briefly, then retry Continue to DVI; do not create another RO.",503);
    const intake = mapProtractorWorkOrder(result.workOrder,id);
    // Validate native identity and open status before updating the shop's cache.
    await upsertProtractorWorkOrderSnapshot(shopId,result.workOrder);
    await touchDashboardUpdate();
    return intake;
  });
}
