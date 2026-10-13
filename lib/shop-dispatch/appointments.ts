import { localParts, APPOINTMENT_FRESH_MS, validateDateRange } from "./schedule-engine";
import { storeAppointmentSnapshot, type ScheduleDependencies } from "./schedule-service";
import { packageTechnicians } from "./provider-technicians";
import type { AppointmentSnapshot, CalendarAppointment } from "./schedule-types";
import { requireThat, type Board } from "./model";

export function providerInstant(raw:unknown,timeZone:string):string|null{
  if(typeof raw!=="string")return null;
  if(/(?:Z|[+-]\d{2}:\d{2})$/i.test(raw)){
    const n=Date.parse(raw);return Number.isFinite(n)?new Date(n).toISOString():null;
  }
  const match=/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(raw);
  if(!match)return null;
  const naive=Date.parse(`${raw}Z`);if(!Number.isFinite(naive))return null;
  const matches:number[]=[];
  for(let offset=-840;offset<=840;offset+=15){
    const candidate=naive+offset*60_000,p=localParts(candidate,timeZone);
    if(p.date===match[1]&&p.minute===Number(match[2])*60+Number(match[3]))matches.push(candidate);
  }
  // Ambiguous fall-back wall times and nonexistent spring-forward times are unknown.
  return matches.length===1?new Date(matches[0]).toISOString():null;
}
export function mapAppointments(rows:any[],timeZone:string):CalendarAppointment[]{
  const found=new Map<string,CalendarAppointment>();
  for(const row of rows){
    if(row.Completed||/^(cancelled|canceled|deleted|closed|invoiced)$/i.test(row.Status??""))continue;
    requireThat(typeof row.ID==="string"&&row.ID.length<=100,"Appointment identity missing",502);
    const start=providerInstant(row.ScheduledTime,timeZone);
    const duration=typeof row.Duration==="number"?row.Duration:typeof row.Duration==="string"&&row.Duration.trim()?Number(row.Duration):NaN;
    const end=start&&Number.isFinite(duration)&&duration>0&&duration<=1440?new Date(Date.parse(start)+duration*60_000).toISOString():null;
    const raw=row.ServicePackages,packages=Array.isArray(raw)?raw:raw?.ItemCollection??[];
    const ids=[typeof row.TechnicianID==="string"?row.TechnicianID.toLowerCase():null,...packages.flatMap((pkg:any)=>packageTechnicians(pkg).map(t=>t.sourceId))].filter((id):id is string=>!!id);
    const title=[row.ServiceItem?.Year,row.ServiceItem?.Make,row.ServiceItem?.Model].filter(v=>typeof v==="string"||typeof v==="number").join(" ").slice(0,160);
    const guid=(value:unknown)=>typeof value==="string"&&/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value)?value.toLowerCase():undefined;
    found.set(row.ID,{id:row.ID,ro:String(row.WorkOrderNumber??"").slice(0,30),title:title||"Protractor appointment",start,end,technicianSourceIds:[...new Set(ids)],
      customer:[row.Contact?.Name?.FirstName,row.Contact?.Name?.LastName].filter(v=>typeof v==="string").join(" ").slice(0,160),
      contactId:guid(row.Contact?.ID),vehicleId:guid(row.ServiceItem?.ID),
      concerns:packages.map((p:any)=>p.ServicePackageHeader?.Description||p.ServicePackageHeader?.Title||p.Title).filter((v:unknown)=>typeof v==="string"&&!!v.trim()).slice(0,20).map((v:string)=>v.slice(0,160)),
      mileage:typeof row.InUsage==="number"&&Number.isInteger(row.InUsage)&&row.InUsage>=0?row.InUsage:undefined});
  }
  return [...found.values()];
}
export interface AppointmentDeps extends ScheduleDependencies {
  fetchPage:(shopId:number,startDate:string,endDate:string,skip:number,deadline:number)=>Promise<{ok:boolean;appointments?:unknown[];rawCount?:number}>;
}
const inFlight=new Map<number,Promise<Board>>();
export async function refreshAppointments(shopId:number,startDate:string,endDate:string,deps:AppointmentDeps,force=false):Promise<Board>{
  validateDateRange(startDate,endDate);
  const before=await deps.read(shopId),cached=before.schedule?.appointments,now=deps.now();
  const timezone=before.schedule?.settings?.timeZone;
  if(!timezone)return before;
  requireThat(Date.parse(`${startDate}T00:00:00Z`)>=now-32*86400_000&&Date.parse(`${endDate}T00:00:00Z`)<=now+91*86400_000,"Calendar range must be within the previous 31 or next 90 days.",400);
  if(!force&&cached?.complete&&cached.startDate<=startDate&&cached.endDate>=endDate&&now-Date.parse(cached.fetchedAt)<APPOINTMENT_FRESH_MS&&Date.parse(cached.fetchedAt)<=now)return before;
  if(inFlight.has(shopId)){await inFlight.get(shopId);return deps.read(shopId);}
  const run=(async()=>{
    const snapshot:AppointmentSnapshot={startDate,endDate,fetchedAt:new Date(now).toISOString(),complete:false,appointments:[]};
    const rows:any[]=[],seen=new Set<string>(),deadline=now+12_000;
    try{
      for(let page=0;page<4;page++){
        requireThat(deps.now()<deadline,"Appointment lookup timed out",503);
        const result=await deps.fetchPage(shopId,startDate,endDate,page*100,deadline);
        requireThat(result.ok&&Array.isArray(result.appointments)&&Number.isInteger(result.rawCount),"Could not verify appointment coverage",503);
        for(const item of result.appointments as any[]){requireThat(!seen.has(item.ID),"Appointment pagination repeated a page",503);seen.add(item.ID);}
        rows.push(...result.appointments);
        if(result.rawCount!<100){snapshot.complete=true;break;}
      }
      snapshot.appointments=mapAppointments(rows,timezone);
      if(!snapshot.complete)snapshot.warning="Appointment results reached the safety limit; availability is closed until coverage can be verified.";
    }catch{
      snapshot.complete=false;snapshot.warning="Protractor appointments could not be fully refreshed. No open capacity will be advertised.";
      // Keep previous arrivals visible as stale evidence, never as verified availability.
      snapshot.appointments=cached?.appointments??[];
    }
    return storeAppointmentSnapshot(shopId,snapshot,deps);
  })();
  inFlight.set(shopId,run);
  try{return await run;}finally{if(inFlight.get(shopId)===run)inFlight.delete(shopId);}
}
