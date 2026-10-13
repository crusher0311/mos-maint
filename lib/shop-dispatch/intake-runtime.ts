import { z } from "zod";
import { readDispatchBoard, saveDispatchBoard } from "../data/repositories/shop-dispatch";
import { requireThat } from "./model";
import { fetchDispatchWorkOrderByNumber, mapProtractorWorkOrder } from "./protractor";
import type { IntakeDependencies } from "./intake-service";
import type { IntakeDetails, TicketIntent } from "./intake-types";

// Dynamic provider import keeps the service and its tests entirely offline.
async function provider(){return import("../integrations/protractor/client");}
async function exact(shop:number,kind:"Contact"|"ServiceItem"|"WorkOrder",id:string):Promise<any|null>{
  const api=await provider(),config=await api.resolveProtractorConfig(shop);
  requireThat(config.configured,"This shop has no verified Protractor connection",409);
  const result=await api.protractorFetch<any>(`/${kind}/${z.string().uuid().parse(id)}`,config,{},0,shop,{priority:true,maxRetries:0,timeoutMs:10000});
  if(!result.ok&&result.error?.startsWith("HTTP 404:"))return null;
  requireThat(result.ok&&result.data,"Provider identity could not be verified",503);
  requireThat(result.data.ID?.toLowerCase()===id.toLowerCase(),"Provider returned another identity",409);
  return result.data;
}
function owned(vehicle:any,contactId:string){
  return String(vehicle?.OwnerID??vehicle?.Owner?.ID??"").toLowerCase()===contactId.toLowerCase();
}
async function verifyIdentity(shop:number,d:IntakeDetails){
  if(d.contactId)requireThat(await exact(shop,"Contact",d.contactId),"Customer no longer exists in this shop",409);
  if(d.vehicleId){
    requireThat(d.contactId,"Select the existing vehicle's customer",409);
    requireThat(owned(await exact(shop,"ServiceItem",d.vehicleId),d.contactId),"Vehicle ownership is not verified for the selected customer",409);
  }
}
async function confirmEntity(shop:number,op:TicketIntent,stage:"contact"|"vehicle"){
  const entity=await exact(shop,stage==="contact"?"Contact":"ServiceItem",stage==="contact"?op.contactId:op.vehicleId);
  if(!entity)return false;
  if(stage==="contact"){
    const expected=op.payload.newCustomer!;
    requireThat(entity.Name?.FirstName===expected.firstName&&entity.Name?.LastName===expected.lastName,"Created customer does not match saved intent",409);
  }else{
    requireThat(owned(entity,op.contactId)&&String(entity.VIN??"").toUpperCase()===op.payload.newVehicle?.vin,"Created vehicle does not match saved intent",409);
  }
  return true;
}
async function confirm(shop:number,op:TicketIntent){
  const wo=await exact(shop,"WorkOrder",op.workOrderId);if(!wo)return null;
  requireThat(wo.Contact?.ID?.toLowerCase()===op.contactId.toLowerCase()&&wo.ServiceItem?.ID?.toLowerCase()===op.vehicleId.toLowerCase(),"Created ticket identity mismatch",409);
  const api=await provider(),expected=api.buildConcernServicePackages({concerns:op.payload.concerns,workOrderId:op.workOrderId});
  const packages=Array.isArray(wo.ServicePackages)?wo.ServicePackages:wo.ServicePackages?.ItemCollection;
  if(!Array.isArray(packages)||!expected.every(p=>packages.some((r:any)=>r.ID?.toLowerCase()===p.ID.toLowerCase()&&r.ServicePackageHeader?.Description===p.ServicePackageHeader.Description)))return null;
  return {intake:mapProtractorWorkOrder(wo,op.workOrderId),packages:expected.map((p,index)=>({jobId:`${op.visitId}:intake:${index}`,sourceId:p.ID}))};
}
async function write(shop:number,op:TicketIntent,stage:"contact"|"vehicle"|"workOrder"){
  const api=await provider();let result:{ok:boolean};
  if(stage==="contact")result=await api.createContact(shop,op.payload.newCustomer!,{contactId:op.contactId,priority:true,maxRetries:0});
  else if(stage==="vehicle")result=await api.createServiceItem(shop,{...op.payload.newVehicle!,ownerId:op.contactId,odometer:op.payload.mileage??undefined},{vehicleId:op.vehicleId,soapTimeoutMs:15000,maxRetries:0});
  else{
    // Revalidate authoritative ownership immediately before the ticket write.
    await verifyIdentity(shop,{...op.payload,contactId:op.contactId,vehicleId:op.vehicleId});
    result=await api.createProtractorWorkOrder(shop,{contactId:op.contactId,vehicleId:op.vehicleId,concerns:op.payload.concerns,mileage:op.payload.mileage??undefined},
      {interactive:true,workOrderId:op.workOrderId,maxRetries:0});
  }
  requireThat(result.ok,"Provider write has not been confirmed; recover the saved operation",503);
}
export const intakeDependencies:IntakeDependencies={
  read:readDispatchBoard,save:saveDispatchBoard,now:()=>new Date().toISOString(),
  verifyIdentity,byNumber:fetchDispatchWorkOrderByNumber,confirm,confirmEntity,write,
};
export async function intakeLookup(shop:number,url:URL){
  const roNumber=url.searchParams.get("roNumber");
  if(roNumber){
    const ticket=await fetchDispatchWorkOrderByNumber(shop,z.string().regex(/^\d{1,15}$/).parse(roNumber));
    return {ticket};
  }
  const api=await provider();
  const contactId=url.searchParams.get("contactId");
  if(contactId){
    const id=z.string().uuid().parse(contactId);
    requireThat(await exact(shop,"Contact",id),"Customer not found",404);
    const result=await api.fetchVehiclesByOwner(shop,id);
    requireThat(result.ok&&result.vehicles,"Vehicle lookup unavailable",503);
    return {vehicles:result.vehicles.slice(0,100).map((v:any)=>({id:v.ID,label:[v.Year,v.Make,v.Model].filter(Boolean).join(" ")||"Vehicle details missing",vin:v.VIN??"",mileage:v.Usage??null}))};
  }
  const q=z.string().trim().min(2).max(100).parse(url.searchParams.get("q"));
  const result=await api.searchContacts(shop,q);
  requireThat(result.ok&&result.contacts,"Customer lookup unavailable",503);
  return {contacts:result.contacts.slice(0,100).map((c:any)=>({id:c.ID,name:[c.Name?.FirstName,c.Name?.LastName].filter(Boolean).join(" ")||c.Company||c.FileAs||"Name missing"}))};
}
