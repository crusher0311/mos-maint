import React,{useState} from "react";
import {createRoot} from "react-dom/client";
import {ROCoworkerTransfer} from "../../components/ROCoworkerTransfer";
import {ROTransferInbox} from "../../components/ROTransferInbox";
import type {useRORecovery} from "../../components/use-ro-recovery";
import {checkInTransferRequest} from "../../components/ro-shared-draft-client";
const id="14850000-0000-4000-8000-000000000001";
function Fixture(){
  const [pending,setPending]=useState(false),[accepted,setAccepted]=useState(""),[revision,setRevision]=useState(1);
  const recovery={
    busy:false,sharedBlocked:pending,serverDraft:{id,transfer:pending?{recipientEmail:"recipient@example.invalid"}:null},
    transferDraft:async(action:string,_fields:string,email?:string)=>{
      const response=await checkInTransferRequest("",{action,id,revision,deviceId:"14850000-0000-4000-8000-000000000002",email});
      setRevision(response.draft.revision);setPending(action==="offer");
    },
  } as unknown as ReturnType<typeof useRORecovery>;
  return <main>
    <h1>Shared check-in · advisor transfer</h1>
    <p>Offline synthetic preview. No live shop, customer or provider connection.</p>
    <section><h2>Sending advisor</h2><ROCoworkerTransfer recovery={recovery} fields="{}"/></section>
    <section><h2>Selected receiving advisor</h2><ROTransferInbox onChecked={()=>{}} onAccepted={setAccepted}/></section>
    {accepted&&<p role="status">Accepted ownership. Original check-in identity: {accepted}</p>}
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
