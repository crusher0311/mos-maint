import { readDispatchBoard, saveDispatchBoard } from "@/lib/data/repositories/shop-dispatch";
import { runWithProtractorInteractiveTransport } from "@/lib/integrations/protractor/interactive-context";
import type { AppointmentDeps } from "./appointments";

export const scheduleDependencies:AppointmentDeps={
  read:readDispatchBoard,save:saveDispatchBoard,now:()=>Date.now(),
  fetchPage:async(shopId,startDate,endDate,skip,deadline)=>{
    const {getProtractorAppointments}=await import("@/lib/integrations/protractor/client");
    return runWithProtractorInteractiveTransport(shopId,()=>getProtractorAppointments(shopId,{startDate,endDate,skip,top:100},{priority:true,maxRetries:0,timeoutMs:Math.max(1,Math.min(8000,deadline-Date.now())),deadlineAtMs:deadline}));
  },
};
