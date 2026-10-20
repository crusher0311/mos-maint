// Offline UI fixture only. NOT an authentication bypass in the application.
import React from "react";
import { createRoot } from "react-dom/client";
import DispatchPilot from "../../components/shop-dispatch/DispatchPilot";
import SheetManager from "../../components/shop-dispatch/SheetManager";
import { createSheetFixture } from "./sheet-fixture";
import { createNewROFixture, NewROPreview, NEW_RO_NUMBER } from "./new-ro-fixture";
import { TechnicianSkills } from "../../components/shop-dispatch/TechnicianSkills";
import { RosterImport } from "../../components/shop-dispatch/RosterImport";
import { CommandForm } from "../../components/shop-dispatch/CommandForm";
import { JobCard } from "../../components/shop-dispatch/JobCard";
import { ScheduleCalendar } from "../../components/shop-dispatch/ScheduleCalendar";
import { OperationsPanel } from "../../components/shop-dispatch/OperationsPanel";
import { availability, assertHeldCapacityPreserved, assertLocalPlanAvailable, localParts } from "../../lib/shop-dispatch/schedule-engine";
import { assertDependencyPlans, assertPlanSkills } from "../../lib/shop-dispatch/operations-scheduling";
import { timelineInstant } from "../../lib/shop-dispatch/timeline";
import styles from "../../components/shop-dispatch/pilot.module.css";
import { actorFor,applyCommand,emptyBoard,type Command } from "../../lib/shop-dispatch/model";
import { paletteFromPixels, resolveWorkflowBranding } from "../../lib/shop-dispatch/branding";
import { STAFF_SHEET_TEMPLATES, initialInspection } from "../../lib/auto-dvi/staff/model";
const sheetParams = new URLSearchParams(location.search);
if (sheetParams.has("newRO")) void import("./new-ro.css");
const sheetFixture = createSheetFixture(sheetParams);
const variant = new URLSearchParams(location.search).get("logo") ?? "colorful";
const canvas = document.createElement("canvas");
canvas.width = 80; canvas.height = 40;
const context = canvas.getContext("2d")!;
context.fillStyle = variant === "pale" ? "#ffdcc8" : variant === "mono" ? "#444444" : "#aa2266";
context.fillRect(0, 0, 80, 40);
context.clearRect(30, 10, 20, 20);
const shared = {
 name: "Synthetic Shop " + variant,
 logo: canvas.toDataURL(),
 colors: paletteFromPixels(context.getImageData(0, 0, 80, 40).data),
};
let board=emptyBoard();
const now=new Date().toISOString(),actor={email:"manager@example.test",manager:true,technicianId:null};
const act=(c:Command)=>{board=applyCommand(board,c,actor,new Date().toISOString());};
function importRo(ro:string,stage="Unassigned"){
 const sourceId=`11111111-1111-4111-8111-${ro.padStart(12,"0")}`;
 board=applyCommand(board,{type:"sync",workOrderId:sourceId},actor,new Date().toISOString(),
 {sourceId,ro,vehicle:"Synthetic imported vehicle",customer:"",sourceStatus:stage,jobs:[]});
}
if (sheetParams.has("newROArrived")) importRo(String(NEW_RO_NUMBER));
if(new URLSearchParams(location.search).has("sources")){importRo("123");importRo("124","VehicleInBay");}
act({type:"technician",id:"tech",name:"Test Technician",email:"tech@example.test",active:true});
act({type:"visit",id:"visit",ro:"TEST-001",vehicle:"Fictional Test Vehicle",customer:"Test customer"});
act({type:"job",id:"job",visitId:"visit",title:"Inspection",bookMinutes:30});
act({type:"plan",jobId:"job",technicianId:"tech",estimatedMinutes:25,plannedStart:now,prerequisites:[],resource:null,authorized:true});
if(new URLSearchParams(location.search).has("assignments")){
 board.technicians[0].sourceId="provider-tech";
 board.jobs[0].sourceId="provider-job";
 board.jobs[0].sourceTechnicians=[{sourceId:"provider-tech",name:"Test Technician"}];
 board.jobs[0].bookMinutes=90;
}
if(new URLSearchParams(location.search).has("schedule")){
 const zone="America/Chicago",date=localParts(Date.now(),zone).date;
 const weekly=Array.from({length:7},(_,day)=>({day,start:"07:30",end:"17:30"}));
 board.technicians[0].name="Example technician 1";
 for(let i=2;i<=9;i++)act({type:"technician",id:`tech-${i}`,name:`Example technician ${i}`,email:"",active:true});
 board.jobs[0].plannedStart=timelineInstant(date,510,zone);
 board.jobs[0].estimatedMinutes=60;
 for(let i=0;i<18;i++){
  const id=`example-${i}`,tech=board.technicians[i%9];
  act({type:"visit",id,ro:`DEMO-${101+i}`,vehicle:["Example SUV","Example sedan","Example pickup"][i%3],customer:"Fictional customer"});
  act({type:"job",id,visitId:id,title:["Oil service","Brake service","Tire rotation","Inspection"][i%4],bookMinutes:[45,90,30,60][i%4]});
  if(i<14)act({type:"plan",jobId:id,technicianId:tech.id,estimatedMinutes:[45,90,30,60][i%4],plannedStart:timelineInstant(date,600+Math.floor(i/9)*150,zone),prerequisites:[],resource:null,authorized:true});
 }
 board.technicians.forEach((t,i)=>{t.sourceId=`example-provider-${i}`;});
 board.schedule={holds:[],settings:{enabled:true,timeZone:zone,weekly,technicians:board.technicians.map(t=>({id:t.id,weekly,timeOff:[]})),resources:[],bufferMinutes:0,leadMinutes:0},
 appointments:{startDate:date,endDate:new Date(Date.parse(date)+7*86400_000).toISOString().slice(0,10),fetchedAt:new Date().toISOString(),complete:true,appointments:[{id:"demo-appointment",ro:"DEMO-ARRIVAL",title:"Fictional appointment vehicle",start:timelineInstant(date,840,zone),end:timelineInstant(date,885,zone),technicianSourceIds:["example-provider-8"]}]}};
 if(new URLSearchParams(location.search).has("usability")){
  board.schedule.settings!.weekly=weekly.filter(w=>w.day!==0);
  board.jobs.find(j=>j.id==="example-14")!.bookMinutes=0;
  const waiting=board.jobs.find(j=>j.id==="example-15")!;
  waiting.operations={parts:"ordered",diagnostics:"ready",requiredSkills:[],blockers:[],checks:[],reviewedAt:now,reviewedBy:actor.email};
 }
  if(new URLSearchParams(location.search).has("resourceTimeline")){
   // Optional synthetic resource coverage; no external services or shared state.
   board.resources=[
    {id:"rack",name:"Alignment rack",active:true},
    {id:"lift-east",name:"East lift",active:true},
    {id:"diagnostic-cart",name:"Diagnostic cart",active:true},
    {id:"lift-retired",name:"Retired lift",active:false},
   ];
   board.schedule.settings!.resources=[
    {id:"rack",weekly,timeOff:[{start:timelineInstant(date,720,zone),end:timelineInstant(date,765,zone)}]},
    {id:"lift-east",weekly:weekly.map(w=>({...w,start:"09:00",end:"16:30"})),timeOff:[]},
   ];
   board.jobs[0].resource="rack";
   const fixtureJob=(id:string)=>board.jobs.find(j=>j.id===id)!;
   fixtureJob("example-0").resource="rack";
   fixtureJob("example-1").resource="rack"; // Different technician, overlapping resource occupancy.
   fixtureJob("example-1").authorized=false;
   fixtureJob("example-2").resource="lift-east";
   fixtureJob("example-3").resource="diagnostic-cart"; // Inherits shop hours.
   fixtureJob("example-4").resource="lift-retired";
   fixtureJob("example-5").resource="missing-equipment";
   fixtureJob("example-6").technicianId=null; // Planned but unassigned work remains visible.
   fixtureJob("example-7").technicianId="missing-technician";
   fixtureJob("example-8").resource="lift-east";
   board.technicians.find(t=>t.id==="tech-9")!.active=false;
   fixtureJob("example-12").resource="diagnostic-cart";
   fixtureJob("example-12").estimatedMinutes=null;
   fixtureJob("example-12").bookMinutes=null;
   fixtureJob("example-13").sourceRemoved=true;
   fixtureJob("example-14").technicianId="tech-6";
   fixtureJob("example-14").plannedStart=timelineInstant(date,930,zone);
   fixtureJob("example-14").estimatedMinutes=40;
   board.schedule.holds=[{
    id:"fixture-rack-hold",technicianId:"tech-4",resourceId:"rack",skillKey:null,
    start:timelineInstant(date,810,zone),end:timelineInstant(date,855,zone),
    expiresAt:new Date(Date.now()+3600000).toISOString(),releasedAt:null,
    owner:"offline-fixture",digest:"synthetic-rack-hold",requestId:"fixture-hold",createdAt:new Date().toISOString(),
   }];
  }
}
if (new URLSearchParams(location.search).has("warnings")) board.jobs[0].sourceRemoved = true;
const realFetch=window.fetch.bind(window);
const newROFixture = createNewROFixture(sheetParams, () => {
  importRo(String(NEW_RO_NUMBER));
  return board.visits.find(visit => visit.ro === String(NEW_RO_NUMBER))!.id;
});
window.fetch=async(input,init)=>{
 const url=String(input);
 if(sheetParams.has("newRO")){
  if(url.startsWith("/api/jobs/search"))return Response.json({results:[]});
  const response=await newROFixture(url,init);
  if(response)return response;
 }
 if(!url.startsWith("/api/shop-dispatch"))throw new Error("Offline fixture blocked unexpected request");
  if(url==="/api/shop-dispatch/inspection/sheets"){
   // Sheets are opt-in; ordinary fixture modes retain their existing UI.
   if(!sheetParams.has("sheets"))return Response.json({error:"Sheets fixture is not enabled."},{status:403});
   return await sheetFixture(init);
  }
 try {
  if(url.startsWith("/api/shop-dispatch/inspection")){
   if(sheetParams.has("newRO")){
    if(url.startsWith("/api/shop-dispatch/inspection/release"))return Response.json({enabled:false,canPublish:false});
    if(url.startsWith("/api/shop-dispatch/inspection/pilot"))return Response.json({enabled:false,operation:null});
    if(init?.method==="POST")return Response.json({error:"Offline fixture only supports read-only initialized inspection."},{status:403});
    const enabled=sheetParams.has("newROArrived");
    return Response.json({enabled,canEdit:enabled,canReview:enabled,record:null,
     inspection:enabled?initialInspection(STAFF_SHEET_TEMPLATES[0]):null,
     catalog:enabled?STAFF_SHEET_TEMPLATES:[],boardRevision:board.revision});
   }
   if(init?.method==="POST")return Response.json({error:"Read-only visual fixture. Persistent writes are covered by the isolated inspection tests."},{status:409});
   const enabled=new URLSearchParams(location.search).has("dvi");
   return Response.json({enabled,canEdit:enabled,canReview:enabled,record:null,inspection:null,
    catalog:enabled?STAFF_SHEET_TEMPLATES:[],boardRevision:board.revision});
  }
  if(url.startsWith("/api/shop-dispatch/schedule")){
   if(init?.method==="POST")return Response.json({error:"Offline preview is read-only."},{status:409});
   const parsed=new URL(url,location.origin),query=Object.fromEntries(parsed.searchParams);
   return Response.json({board,availability:availability(board,{...query,durationMinutes:Number(query.durationMinutes)} as any,Date.now())});
  }
  if(url==="/api/shop-dispatch/roster")return Response.json({source:"history",truncated:false,employees:[
    {id:"recent",name:"Recent Technician",active:true,historical:true,lastSeenAt:new Date().toISOString(),recentActivity:true},
    {id:"past",name:"Earlier Technician",active:true,historical:true,lastSeenAt:"2026-06-01T12:00:00Z",recentActivity:false},
  ]});
  if(url==="/api/shop-dispatch/skills")return Response.json({truncated:false,profiles:[{technicianId:"tech",sourceId:"synthetic",skills:[{key:"brake service",title:"Brake service",count:12,lastCompletedAt:"2026-10-01T12:00:00Z",sharedJobCount:2,evidence:[{ro:"TEST-001",title:"Brake service",completedAt:"2026-10-01T12:00:00Z",shared:true}]}]}]});
  if(init?.method==="POST"){
   const body=JSON.parse(String(init.body));
   const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(body.command)));
   const digest=Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,"0")).join("");
   const receipt=board.receipts.find(r=>r.id===body.requestId);
   if(receipt){
    if(receipt.actor!==actor.email||receipt.digest!==digest)return Response.json({error:"Request ID reused for different work"},{status:409});
    return Response.json({board});
   }
   if(body.revision!==board.revision)return Response.json({error:"Revision conflict"},{status:409});
   if(body.command.type==="syncNumber")importRo(body.command.roNumber);
   else {
    const next=applyCommand(board,body.command,actor,new Date().toISOString());
    assertHeldCapacityPreserved(board,next,Date.now());
    const plannedJobId=body.command.type==="plan"?body.command.jobId:body.command.type==="undo-plan"?board.receipts.find(r=>r.id===body.command.receiptId)?.undoPlan?.jobId:undefined;
    if(plannedJobId){
     assertPlanSkills(next,plannedJobId);
     assertLocalPlanAvailable(board,next,plannedJobId,Date.now());
     assertDependencyPlans(next,plannedJobId,Date.now());
    }
    for(const old of next.receipts)delete old.undoPlan;
    const savedReceipt:typeof board.receipts[number]={id:body.requestId,actor:actor.email,digest};
    if(body.command.type==="plan"){
     const before=board.jobs.find(j=>j.id===body.command.jobId)!;
     if(before.status==="idle"&&before.authorized===body.command.authorized&&JSON.stringify(before.prerequisites)===JSON.stringify(body.command.prerequisites)){
      savedReceipt.undoPlan={revision:next.revision,jobId:before.id,expiresAt:new Date(Date.now()+300000).toISOString(),
       previous:{technicianId:before.technicianId,resource:before.resource,plannedStart:before.plannedStart,estimatedMinutes:before.estimatedMinutes}};
     }
    }
    next.receipts.push(savedReceipt);
    board=next;
   }
  }
  return Response.json({board,branding:resolveWorkflowBranding(board.locationBrand,shared,null),actor:actorFor(board,actor.email,"manager"),shopId:999,serverNow:new Date().toISOString(),enterprise:null});
 }catch(e){return Response.json({error:e instanceof Error?e.message:"Error"},{status:422});}
};
void realFetch;
function RosterPreview(){
 const [failed,setFailed]=React.useState(false);
 React.useEffect(()=>{document.querySelector<HTMLButtonElement>('[data-testid="roster-load"]')?.click();},[]);
 return <main className={styles.root} style={{padding:24,maxWidth:950}}>
  <h1>Technician roster review</h1>
  <CommandForm testId="error-demo" busy={false} label="Save reviewed technician" submit={async()=>{setFailed(true);throw Error("The board changed. Refresh the board and try saving again.");}}>
   <label>Technician name<input name="name" defaultValue="Example technician"/></label>
  </CommandForm>
  {!failed&&<p>Save above to preview the error state.</p>}
  <RosterImport board={board} busy={false} mutate={async()=>{throw Error("The board changed. Refresh the board and try saving again.");}}/>
 </main>;
}
if(new URLSearchParams(location.search).has("operations")){
 board.operationsEnabled=true;
 board.jobs[0].operations={reviewedAt:new Date().toISOString(),reviewedBy:"Synthetic manager",parts:"ordered",diagnostics:"ready",requiredSkills:[],checks:[{id:"road-test",label:"Road test",completedAt:null,completedBy:null}],
 blockers:[{id:"parts",reason:"Confirm delivery window",owner:"Parts desk",resolved:false,openedAt:new Date(Date.now()-7200000).toISOString(),resolvedAt:null}]};
 board.visits[0].promiseAt=new Date(Date.now()+3600000).toISOString();
}
const params=new URLSearchParams(location.search);
createRoot(document.getElementById("root")!).render(<><div style={{padding:12,background:"#ffe6a0",color:"#222"}}>OFFLINE UI TEST FIXTURE · synthetic data · no production connection</div>{params.has("newRO")?<NewROPreview/>:params.has("sheets")?<main className={styles.root} style={{padding:24}}><SheetManager /></main>:params.has("operations")?<main className={styles.root} style={{padding:24}}><OperationsPanel board={board} actor={actor} now={Date.now()} busy={false} mutate={async()=>false} select={()=>{}}/><JobCard board={board} job={board.jobs[0]} actor={actor} now={Date.now()} busy={false} mutate={async()=>false}/></main>:params.has("schedule")?<main className={styles.root} style={{padding:24}}><ScheduleCalendar shopId={999} board={board} busy={false} refresh={async()=>{}} select={()=>{}}/></main>:params.has("assignments")?<main className={styles.root} style={{padding:24,maxWidth:950}}><JobCard job={board.jobs[0]} board={board} actor={actor} now={Date.now()} busy={false} mutate={async()=>false}/></main>:params.has("roster")?<RosterPreview/>:params.has("skills")?<main className={styles.root}><TechnicianSkills board={board} actor={actor} busy={false} mutate={async()=>false}/></main>:<DispatchPilot/>}</>);
