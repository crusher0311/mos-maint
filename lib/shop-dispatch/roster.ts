import { idSchema, requireThat } from "./model";
import type { ProtractorEmployee } from "@/lib/integrations/protractor/client";

export function mapRoster(employees:ProtractorEmployee[]){
  const seen=new Set<string>();
  return employees.flatMap(employee=>{
    const id=String(employee.ID??"").toLowerCase();
    const name=(employee.FileAs||[employee.Name?.FirstName??employee.FirstName,employee.Name?.LastName??employee.LastName].filter(Boolean).join(" ")).trim();
    if(!idSchema.safeParse(id).success||!name||name.length>160||seen.has(id))return [];
    seen.add(id);
    return [{id,name,active:employee.Active!==false&&employee.IsActive!==false&&!/^(inactive|terminated|deleted|disabled)$/i.test(employee.Status??"")}];
  });
}
export async function loadDispatchRoster(shopId:number){
  const {getProtractorEmployees}=await import("@/lib/integrations/protractor/client");
  const result=await getProtractorEmployees(shopId,{top:100,timeoutMs:8000,maxRetries:0,priority:true});
  requireThat(result.ok&&Array.isArray(result.employees),"Could not read this location's Protractor staff. No roster entries changed.",502);
  return {employees:mapRoster(result.employees),truncated:result.employees.length>=100};
}
export async function fetchDispatchEmployee(shopId:number,id:string){
  const {employees}=await loadDispatchRoster(shopId);
  const employee=employees.find(e=>e.id===id);
  requireThat(employee,"Employee not found in this location's current Protractor roster",404);
  return employee;
}
