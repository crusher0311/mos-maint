import { protractorTechnician } from "@/lib/integrations/protractor/technician";
import { idSchema } from "./model";

/** Keep all explicit package/labor-line identities; never infer an RO-wide owner. */
export function packageTechnicians(pkg: any): {sourceId:string|null;name:string}[] {
  const raw=pkg.ServicePackageLines;
  const lines=Array.isArray(raw)?raw:Array.isArray(raw?.ItemCollection)?raw.ItemCollection:[];
  const candidates=[pkg,...lines.filter((line:any)=>
    /^labor$/i.test(String(line?.Type??line?.LineType??"")) &&
    !/^(declined|cancelled|canceled|rejected|deleted)$/i.test(String(line?.Status??"")))];
  const found=new Map<string,{sourceId:string|null;name:string}>();
  for(const item of candidates){
    const tech=protractorTechnician(item.Technician,item.TechnicianName);
    const id=tech.technicianId?.toLowerCase();
    const sourceId=id&&idSchema.safeParse(id).success?id:null;
    const name=tech.technicianName?.slice(0,160)??"";
    if(!sourceId&&!name)continue;
    const key=sourceId?`id:${sourceId}`:`name:${name.toLowerCase()}`;
    const previous=found.get(key);
    if(!previous||(!previous.name&&name))found.set(key,{sourceId,name});
  }
  return [...found.values()];
}
