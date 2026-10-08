import type { ProtractorWorkOrder } from "@/lib/integrations/protractor/client";
import { intakeSchema, requireThat, type Intake } from "./model";

/** Pure, allowlisted mapping. Upstream packages do not imply authorization or
 * actual time. No clock/assignment/customer transportation is inferred. */
export function mapProtractorWorkOrder(workOrder:ProtractorWorkOrder,expectedId:string):Intake{
  requireThat(typeof workOrder.ID==="string"&&workOrder.ID.toLowerCase()===expectedId.toLowerCase(),"Upstream returned a different repair order",502);
  const status=workOrder.Status ?? workOrder.WorkflowStage ?? workOrder.Type ?? "Unknown";
  requireThat(!workOrder.Completed && !/^(invoice|closed|posted|cancelled|canceled|completed)$/i.test(workOrder.Type ?? "") && !/^(closed|posted|cancelled|canceled|completed)$/i.test(status),"Closed, invoiced or canceled orders cannot be imported",409);
  requireThat(Array.isArray(workOrder.ServicePackages),"Provider response omitted service packages; existing work was not changed",502);
  const vehicle=workOrder.ServiceItem;
  const contact=workOrder.Contact;
  const jobs=workOrder.ServicePackages.filter(pkg=>!/^(declined|cancelled|canceled|rejected|deleted)$/i.test(pkg.Status ?? "")).map(pkg=>({
    sourceId:pkg.ID,title:(pkg.Title || pkg.Description || "Untitled service package").slice(0,160),
    // Do not assume line Quantity or Technician Hours equals book labor.
    bookMinutes:null,
  }));
  requireThat(new Set(jobs.map(j=>j.sourceId?.toLowerCase())).size===jobs.length,"Provider returned duplicate service-package identities",502);
  const mapped=intakeSchema.safeParse({
    sourceId:workOrder.ID,ro:String(workOrder.WorkOrderNumber ?? workOrder.ID),
    vehicle:[vehicle?.Year,vehicle?.Make,vehicle?.Model].filter(Boolean).join(" ") || "Vehicle details unavailable",
    customer:[contact?.Name?.FirstName,contact?.Name?.LastName].filter(Boolean).join(" ") || contact?.Company || "",
    sourceStatus:status,jobs,
  });
  requireThat(mapped.success,"Provider response is incomplete or exceeds pilot capacity",502);
  return mapped.data;
}

export async function fetchDispatchWorkOrder(shopId:number,id:string):Promise<Intake>{
  // Dynamic import keeps pure mapping tests isolated from providers and DBs.
  const {fetchWorkOrderById}=await import("@/lib/integrations/protractor/client");
  // Existing client resolves only this shop's credentials and enforces provider routing.
  const result=await fetchWorkOrderById(shopId,id,{priority:true,timeoutMs:12000,maxRetries:0});
  requireThat(result.ok&&result.workOrder,"Repair-order intake failed. Verify this location's Protractor connection and try again. No local workflow was changed.",502);
  return mapProtractorWorkOrder(result.workOrder,id);
}
