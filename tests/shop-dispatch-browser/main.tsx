// Offline UI fixture only. NOT an authentication bypass in the application.
import React from "react";
import { createRoot } from "react-dom/client";
import DispatchPilot from "../../components/shop-dispatch/DispatchPilot";
import { TechnicianSkills } from "../../components/shop-dispatch/TechnicianSkills";
import { RosterImport } from "../../components/shop-dispatch/RosterImport";
import { CommandForm } from "../../components/shop-dispatch/CommandForm";
import styles from "../../components/shop-dispatch/pilot.module.css";
import { actorFor,applyCommand,emptyBoard,type Command } from "../../lib/shop-dispatch/model";
import { paletteFromPixels, resolveWorkflowBranding } from "../../lib/shop-dispatch/branding";
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
if(new URLSearchParams(location.search).has("sources")){importRo("123");importRo("124","VehicleInBay");}
act({type:"technician",id:"tech",name:"Test Technician",email:"tech@example.test",active:true});
act({type:"visit",id:"visit",ro:"TEST-001",vehicle:"Fictional Test Vehicle",customer:"Test customer"});
act({type:"job",id:"job",visitId:"visit",title:"Inspection",bookMinutes:30});
act({type:"plan",jobId:"job",technicianId:"tech",estimatedMinutes:25,plannedStart:now,prerequisites:[],resource:null,authorized:true});
if (new URLSearchParams(location.search).has("warnings")) board.jobs[0].sourceRemoved = true;
const realFetch=window.fetch.bind(window);
window.fetch=async(input,init)=>{
 const url=String(input);
 if(!url.startsWith("/api/shop-dispatch"))throw new Error("Offline fixture blocked unexpected request");
 try {
  if(url==="/api/shop-dispatch/roster")return Response.json({source:"history",truncated:false,employees:[
    {id:"recent",name:"Recent Technician",active:true,historical:true,lastSeenAt:new Date().toISOString(),recentActivity:true},
    {id:"past",name:"Earlier Technician",active:true,historical:true,lastSeenAt:"2026-06-01T12:00:00Z",recentActivity:false},
  ]});
  if(url==="/api/shop-dispatch/skills")return Response.json({truncated:false,profiles:[{technicianId:"tech",sourceId:"synthetic",skills:[{key:"brake service",title:"Brake service",count:12,lastCompletedAt:"2026-10-01T12:00:00Z",sharedJobCount:2,evidence:[{ro:"TEST-001",title:"Brake service",completedAt:"2026-10-01T12:00:00Z",shared:true}]}]}]});
  if(init?.method==="POST"){const body=JSON.parse(String(init.body));if(body.revision!==board.revision)return Response.json({error:"Revision conflict"},{status:409});if(body.command.type==="syncNumber")importRo(body.command.roNumber);else act(body.command);}
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
createRoot(document.getElementById("root")!).render(<><div style={{padding:12,background:"#ffe6a0",color:"#222"}}>OFFLINE UI TEST FIXTURE · synthetic data · no production connection</div>{new URLSearchParams(location.search).has("roster")?<RosterPreview/>:new URLSearchParams(location.search).has("skills")?<main className={styles.root}><TechnicianSkills board={board} actor={actor} busy={false} mutate={async()=>false}/></main>:<DispatchPilot/>}</>);
