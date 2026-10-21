"use client";
import {useState} from "react";
import {checkInTransferRequest} from "./ro-shared-draft-client";
import type {useRORecovery} from "./use-ro-recovery";

export function ROCoworkerTransfer({recovery,fields}:{recovery:ReturnType<typeof useRORecovery>;fields:string}){
  const [email,setEmail]=useState(""),[selected,setSelected]=useState(""),[error,setError]=useState(""),[checking,setChecking]=useState(false);
  const pending=recovery.serverDraft?.transfer;
  return <div className="rounded-lg border border-blue-100 bg-white p-3 space-y-2" aria-label="Transfer check-in to coworker">
    <h4 className="text-sm font-semibold">Transfer to another advisor</h4>
    {pending ? <>
      <p className="text-xs text-gray-600" role="status">Waiting for {pending.recipientEmail} to sign in to this shop and accept. Editing is paused.</p>
      <a className="text-xs text-blue-700 underline block" href={`/dashboard/check-in?draft=${recovery.serverDraft!.id}`}>Signed-in acceptance link</a>
      <button type="button" disabled={recovery.busy} onClick={()=>void recovery.transferDraft("cancel",fields)}
        className="text-xs text-blue-700 disabled:opacity-50">Cancel transfer and keep ownership</button>
    </> : <>
      <p className="text-xs text-gray-600">Select a current authorized advisor by account email. They must explicitly accept; sharing a link alone grants no access.</p>
      <label className="block text-xs">Coworker email
        <input type="email" value={email} onChange={e=>{setEmail(e.target.value);setSelected("");setError("");}}
          className="block w-full border rounded px-2 py-2 mt-1" disabled={checking||recovery.busy}/></label>
      <button type="button" disabled={!email||checking||recovery.busy||recovery.sharedBlocked} className="text-xs text-blue-700 disabled:opacity-50"
        onClick={async()=>{
          setChecking(true);setError("");setSelected("");
          try{const result=await checkInTransferRequest(`?email=${encodeURIComponent(email.trim())}`);setSelected(result.coworker.email);}
          catch(e){setError(e instanceof Error?e.message:"Coworker could not be verified.");}finally{setChecking(false);}
        }}>Check coworker access</button>
      {selected&&<div className="space-y-2"><p className="text-xs">Selected advisor: <strong>{selected}</strong></p>
        <button type="button" disabled={recovery.busy||recovery.sharedBlocked} onClick={()=>void recovery.transferDraft("offer",fields,selected)}
          className="rounded bg-blue-600 text-white text-xs px-3 py-2 disabled:opacity-50">Save and offer transfer</button></div>}
    </>}
    {error&&<p role="alert" className="text-xs text-red-700">{error}</p>}
  </div>;
}
