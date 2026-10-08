// Offline UI fixture only. NOT an authentication bypass in the application.
import React from "react";
import { createRoot } from "react-dom/client";
import DispatchPilot from "../../components/shop-dispatch/DispatchPilot";
import { actorFor,applyCommand,emptyBoard,type Command } from "../../lib/shop-dispatch/model";
let board=emptyBoard();
const now=new Date().toISOString(),actor={email:"manager@example.test",manager:true,technicianId:null};
const act=(c:Command)=>{board=applyCommand(board,c,actor,new Date().toISOString());};
act({type:"technician",id:"tech",name:"Test Technician",email:"tech@example.test",active:true});
act({type:"visit",id:"visit",ro:"TEST-001",vehicle:"Fictional Test Vehicle",customer:"Test customer"});
act({type:"job",id:"job",visitId:"visit",title:"Inspection",bookMinutes:30});
act({type:"plan",jobId:"job",technicianId:"tech",estimatedMinutes:25,plannedStart:now,prerequisites:[],resource:null,authorized:true});
const realFetch=window.fetch.bind(window);
window.fetch=async(input,init)=>{
 const url=String(input);
 if(!url.startsWith("/api/shop-dispatch"))throw new Error("Offline fixture blocked unexpected request");
 try {
  if(init?.method==="POST"){const body=JSON.parse(String(init.body));if(body.revision!==board.revision)return Response.json({error:"Revision conflict"},{status:409});act(body.command);}
  return Response.json({board,actor:actorFor(board,actor.email,"manager"),shopId:999,serverNow:new Date().toISOString(),enterprise:null});
 }catch(e){return Response.json({error:e instanceof Error?e.message:"Error"},{status:422});}
};
void realFetch;
createRoot(document.getElementById("root")!).render(<><div style={{padding:12,background:"#ffe6a0",color:"#222"}}>OFFLINE UI TEST FIXTURE · synthetic data · no production connection</div><DispatchPilot/></>);
