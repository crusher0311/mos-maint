import type { ProtractorWorkOrder } from "@/lib/integrations/protractor/client";
import { intakeSchema, requireThat, type Intake } from "./model";
import { normalizeRoNumber, terminalSourceStatus } from "./source-preferences";
import { protractorBookMinutes } from "./labor-time";
import { packageTechnicians } from "./provider-technicians";

/** Pure, allowlisted mapping. Upstream packages do not imply authorization or
 * actual time. No clock/assignment/customer transportation is inferred. */
export function mapProtractorWorkOrder(workOrder:ProtractorWorkOrder,expectedId:string):Intake{
  requireThat(typeof workOrder.ID==="string"&&workOrder.ID.toLowerCase()===expectedId.toLowerCase(),"Upstream returned a different repair order",502);
  const status=workOrder.WorkflowStage ?? workOrder.Status ?? workOrder.Type ?? "Unknown";
  requireThat(!workOrder.Completed && ![workOrder.Type,workOrder.Status,workOrder.WorkflowStage].some(terminalSourceStatus),"Closed, invoiced or canceled orders cannot be imported",409);
  const packages=Array.isArray(workOrder.ServicePackages)?workOrder.ServicePackages:(workOrder.ServicePackages as any)?.ItemCollection;
  requireThat(Array.isArray(packages),"Provider response omitted service packages; existing work was not changed",502);
  const vehicle=workOrder.ServiceItem;
  const contact=workOrder.Contact;
  const jobs=(packages as NonNullable<ProtractorWorkOrder["ServicePackages"]>).filter(pkg=>!/^(declined|cancelled|canceled|rejected|deleted)$/i.test(pkg.Status ?? "")).map(pkg=>({
    sourceId:pkg.ID,title:((pkg as any).ServicePackageHeader?.Title || pkg.Title || pkg.Description || "Untitled service package").slice(0,160),
    bookMinutes:protractorBookMinutes(pkg),
    sourceTechnicians:packageTechnicians(pkg),
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

export async function fetchDispatchWorkOrderByNumber(shopId:number,value:string):Promise<Intake>{
  const number=normalizeRoNumber(value);
  requireThat(/^\d{1,15}$/.test(number)&&Number.isSafeInteger(Number(number)),"Enter a valid RO number",400);
  const {findCachedWorkOrderByRoNumber}=await import("@/lib/data/repositories/protractor-work-orders");
  const cached=await findCachedWorkOrderByRoNumber(shopId,Number(number));
  let id=cached?.workOrderGuid || cached?.workOrderId || cached?.data?.ID;
  if(!id){
    const {findActiveWorkOrderByNumber}=await import("@/lib/integrations/protractor/client");
    const result=await findActiveWorkOrderByNumber(shopId,Number(number));
    requireThat(result.ok&&result.workOrderId,result.error||"Could not find this RO at the current location",502);
    id=result.workOrderId;
  }
  requireThat(typeof id==="string"&&/^[0-9a-f-]{36}$/i.test(id),
    "RO not found in this location's synced orders. Save the order in Protractor to send an update, then try again.",404);
  const intake=await fetchDispatchWorkOrder(shopId,id);
  requireThat(Number(intake.ro)===Number(number),"The provider returned a different RO number. No workflow data was changed.",409);
  return intake;
}

export async function fetchDispatchWorkOrder(shopId:number,id:string):Promise<Intake>{
  // Dynamic import keeps pure mapping tests isolated from providers and DBs.
  const {fetchWorkOrderById}=await import("@/lib/integrations/protractor/client");
  // Existing client resolves only this shop's credentials and enforces provider routing.
  const result=await fetchWorkOrderById(shopId,id,{priority:true,timeoutMs:12000,maxRetries:0});
  requireThat(result.ok&&result.workOrder,"Repair-order intake failed. Verify this location's Protractor connection and try again. No local workflow was changed.",502);
  return mapProtractorWorkOrder(result.workOrder,id);
}
