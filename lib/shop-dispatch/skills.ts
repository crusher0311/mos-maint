import { protractorTechnician } from "@/lib/integrations/protractor/technician";
import type { Technician } from "./model";
import { readArchivedTechnicianHistory } from "./historical-roster";

export interface SkillEvidence {ro:string;title:string;completedAt:string|null;shared:boolean}
export interface HistoricalSkill {key:string;title:string;count:number;lastCompletedAt:string|null;sharedJobCount:number;evidence:SkillEvidence[]}
const list=(v:any):any[]=>Array.isArray(v)?v:Array.isArray(v?.ItemCollection)?v.ItemCollection:[];
const text=(v:unknown)=>typeof v==="string"?v.trim():"";
export function buildSkillProfiles(pages:any[],technicians:Technician[]){
  const byEmployee=new Map<string,Map<string,HistoricalSkill>>();
  const seen=new Set<string>();
  for(const page of pages)for(const invoice of list(page.invoices)){
    const id=text(invoice.ID),when=text(invoice.InvoiceTime);
    // These archived pages come from the Invoice endpoint. Protractor retains
    // Type=WorkOrder and Completed=false on invoiced history; InvoiceTime is
    // the completion evidence, not that workflow checkbox. Exclude credits.
    if(!id||!when||!Number.isFinite(Date.parse(when))||Date.parse(when)<=0||/credit|estimate|quote/i.test(text(invoice.Type)))continue;
    const completedAt=new Date(when).toISOString();
    for(const pkg of list(invoice.ServicePackages)){
      if(/declined|deferred|cancel|not.?author/i.test(text(pkg.Status)))continue;
      const packageId=text(pkg.ID);
      const title=(text(pkg.ServicePackageHeader?.Title)||text(pkg.ServicePackageHeader?.Description)||text(pkg.ServicePackageHeader)||text(pkg.Title)||text(pkg.Description)).slice(0,160);
      if(!packageId||!title)continue;
      const key=title.toLowerCase().replace(/\s+/g," ");
      const employees=new Set<string>();
      for(const line of list(pkg.ServicePackageLines)){
        if(line.Type!=="Labor"||/declined|deferred|cancel|not.?author/i.test(text(line.Status)))continue;
        const tech=protractorTechnician(line.Technician,line.TechnicianName);
        if(tech.technicianId)employees.add(tech.technicianId.toLowerCase());
      }
      for(const employee of employees){
        const identity=JSON.stringify([id,packageId,employee]);
        if(seen.has(identity))continue;
        seen.add(identity);
        const map=byEmployee.get(employee)??new Map<string,HistoricalSkill>();
        const skill=map.get(key)??{key,title,count:0,lastCompletedAt:null,sharedJobCount:0,evidence:[]};
        skill.count++;
        if(!skill.lastCompletedAt||completedAt>skill.lastCompletedAt)skill.lastCompletedAt=completedAt;
        if(employees.size>1)skill.sharedJobCount++;
        skill.evidence.push({ro:String(invoice.WorkOrderNumber??"Unknown RO").slice(0,160),title,completedAt,shared:employees.size>1});
        skill.evidence.sort((a,b)=>(b.completedAt??"").localeCompare(a.completedAt??""));
        skill.evidence=skill.evidence.slice(0,5);
        map.set(key,skill);byEmployee.set(employee,map);
      }
    }
  }
  return technicians.map(t=>({technicianId:t.id,sourceId:t.sourceId??null,
    skills:[...(byEmployee.get(t.sourceId?.toLowerCase()??"")?.values()??[])].sort((a,b)=>b.count-a.count||a.title.localeCompare(b.title))}));
}
export async function loadSkillProfiles(shopId:number,technicians:Technician[]){
  const {getDb}=await import("@/lib/mongo");
  const {pages,truncated}=await readArchivedTechnicianHistory(shopId,await getDb());
  return {profiles:buildSkillProfiles(pages,technicians),truncated};
}
