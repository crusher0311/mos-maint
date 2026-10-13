// Synthetic browser contract fixture. No database or provider modules.
import React,{useState} from "react";
import {createRoot} from "react-dom/client";
import {IntakeForm} from "../../components/shop-dispatch/IntakeForm";
import {VisitIntake} from "../../components/shop-dispatch/VisitIntake";
import {emptyBoard,type Board} from "../../lib/shop-dispatch/model";
import {intakeRequestSchema} from "../../lib/shop-dispatch/intake-types";
import styles from "../../components/shop-dispatch/pilot.module.css";
const appt={id:"appointment-only-id",ro:"501",title:"Synthetic sedan",customer:"Synthetic Customer",contactId:"11111111-1111-4111-8111-111111111111",vehicleId:"22222222-2222-4222-8222-222222222222",concerns:["Inspect noise"],start:new Date().toISOString(),end:null,technicianSourceIds:[]};
const key="offline:intake:board";
let board:Board=JSON.parse(sessionStorage.getItem(key)??"null")??emptyBoard();
let requests:string[]=[];
(window as any).intakeRequests=requests;
window.fetch=async(input,init)=>{
 const url=String(input);
 if(!url.startsWith("/api/shop-dispatch/intake"))throw new Error("Offline fixture blocks unexpected network");
 if(init?.method!=="POST")return Response.json(url.includes("contactId=")?{vehicles:[{id:appt.vehicleId,label:appt.title,vin:"1HGCM82633A004352",mileage:12000}]}:url.includes("roNumber=")?{ticket:{sourceId:"33333333-3333-4333-8333-333333333333",ro:"501",customer:appt.customer,vehicle:appt.title,sourceStatus:"Open"}}:{contacts:[{id:appt.contactId,name:appt.customer}]});
 requests.push(String(init.body));
 const parsed=intakeRequestSchema.safeParse(JSON.parse(String(init.body)));
 if(!parsed.success)return Response.json({error:"Invalid fixture request"},{status:400});
 const body=parsed.data;
 if(body.action!=="reconcile"&&body.revision!==board.revision&&!board.receipts.some(r=>r.id===body.requestId))return Response.json({error:"Revision conflict"},{status:409});
 if(body.action==="checkIn"&&!board.receipts.some(r=>r.id===body.requestId)){
  board.visits.push({id:"checked-in",ro:"Local draft",vehicle:body.details.vehicle,customer:body.details.customer,arrivalAt:new Date().toISOString(),promiseAt:body.details.promiseAt,transport:{customerPlan:body.details.customerPlan,ride:"none",loaner:"none",loanerId:"",notes:"",pickupAt:null},closed:false,provider:"manual",sourceId:null,sourceStatus:null,sourceFetchedAt:null,intake:{appointmentId:body.appointmentId,checkedInAt:new Date().toISOString(),checkedInBy:"offline-manager",details:body.details}});
  board.visits[0].intake!.requestId=body.requestId;
  board.revision++;board.receipts.push({id:body.requestId,actor:"offline",digest:"fixture"});
  sessionStorage.setItem(key,JSON.stringify(board));
  if(new URLSearchParams(location.search).has("timeout"))return Response.json({error:"Synthetic accepted timeout"},{status:503});
 }
 if(body.action==="create"){
  const visit=board.visits[0];
  board.ticketIntents=[{id:body.requestId,visitId:visit.id,actor:"offline",digest:"",createdAt:new Date().toISOString(),status:"uncertain",message:"Synthetic provider outcome uncertain",payload:visit.intake!.details,contactId:appt.contactId,vehicleId:appt.vehicleId,workOrderId:"33333333-3333-4333-8333-333333333333",attempted:["workOrder"]}];board.revision++;
 }
 if(body.action==="reconcile"){
  board.ticketIntents![0].status="confirmed";board.ticketIntents![0].message="Exact-ID verification completed";
  Object.assign(board.visits[0],{sourceId:board.ticketIntents![0].workOrderId,provider:"protractor",ro:"501"});board.revision++;
 }
 if(body.action==="link"){Object.assign(board.visits[0],{sourceId:body.expectedSourceId,provider:"protractor",ro:body.roNumber});board.revision++;}
 sessionStorage.setItem(key,JSON.stringify(board));
 return Response.json({board});
};
function Preview(){
 const [value,setValue]=useState(structuredClone(board)),[selected,select]=useState(new URLSearchParams(location.search).has("visit"));
 const refresh=async()=>{setValue(structuredClone(board));};
 return <main className={styles.root}><h1>Offline workflow intake verification</h1><small>Fictional fixtures only · no production requests</small>
 {selected&&value.visits[0]?<VisitIntake board={value} visit={value.visits[0]} manager shopId={999} busy={false} refresh={refresh}/>:
 <IntakeForm board={value} shopId={999} busy={false} appointment={new URLSearchParams(location.search).has("appointment")?appt:undefined} refresh={refresh} select={()=>select(true)}/>}</main>;
}
createRoot(document.getElementById("root")!).render(<Preview/>);
