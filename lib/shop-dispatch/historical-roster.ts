import { protractorTechnician } from "@/lib/integrations/protractor/technician";
import { idSchema } from "./model";
import type { Db } from "mongodb";

const list=(v:any):any[]=>Array.isArray(v)?v:Array.isArray(v?.ItemCollection)?v.ItemCollection:[];
export function historicalCandidates(pages:any[]){
  const names=new Map<string,Set<string>>();
  for(const page of pages)for(const invoice of list(page.invoices))
    for(const pkg of list(invoice.ServicePackages))for(const line of list(pkg.ServicePackageLines)){
      const tech=protractorTechnician(line.Technician,line.TechnicianName);
      const id=tech.technicianId?.toLowerCase(),name=tech.technicianName;
      if(!id||!idSchema.safeParse(id).success||!name||name.length>160)continue;
      const values=names.get(id)??new Set<string>();values.add(name);names.set(id,values);
    }
  // Conflicting names need manual resolution, not an arbitrary identity merge.
  return [...names].filter(([,values])=>values.size===1).map(([id,values])=>({
    id,name:[...values][0],active:true,historical:true as const,
  })).sort((a,b)=>a.name.localeCompare(b.name));
}

export async function loadHistoricalRoster(shopId:number){
  const {getDb}=await import("@/lib/mongo");
  return readHistoricalRoster(shopId,await getDb());
}
export async function readHistoricalRoster(shopId:number,db:Pick<Db,"collection">){
  const {pages,truncated}=await readArchivedTechnicianHistory(shopId,db);
  return {employees:historicalCandidates(pages),truncated};
}
export async function readArchivedTechnicianHistory(shopId:number,db:Pick<Db,"collection">){
  if(!Number.isSafeInteger(shopId)||shopId<=0)throw Error("Invalid history shop");
  const jobs=await db.collection<{_id:string;shopId:number;status:string}>("operator_history_import_jobs")
    .find({shopId,status:"completed"},{projection:{_id:1,shopId:1},limit:6}).maxTimeMS(3000).toArray();
  const pages:any[]=[];
  let truncated=jobs.length>5;
  const deadline=Date.now()+5000;
  for(const job of jobs.slice(0,5)){
    if(job.shopId!==shopId||typeof job._id!=="string")continue;
    const prefix=job._id+":";
    const remaining=501-pages.length;
    if(remaining<=0||Date.now()>=deadline){truncated=true;break;}
    const rows=await db.collection("operator_history_import_pages").find(
      {_id:{$gte:prefix,$lt:prefix+"\uffff"}} as any,
      {projection:{"invoices.ServicePackages":1,"invoices.ID":1,"invoices.Type":1,"invoices.InvoiceTime":1,"invoices.WorkOrderNumber":1,"invoices.Completed":1},limit:remaining},
    ).maxTimeMS(Math.max(1,deadline-Date.now())).toArray();
    pages.push(...rows);
    if(pages.length>500){truncated=true;break;}
  }
  return {pages:pages.slice(0,500),truncated};
}
