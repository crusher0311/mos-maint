"use client";
import {useEffect,useState} from "react";
import {checkInTransferRequest} from "./ro-shared-draft-client";
type Offer={id:string;revision:number;from:string;offeredAt:string};
export function ROTransferInbox({draftId,onChecked,onAccepted}:{draftId?:string;onChecked:(hasOffers:boolean)=>void;onAccepted:(id:string)=>void}){
  const [offers,setOffers]=useState<Offer[]>([]),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  async function refresh(){
    setBusy(true);setError("");
    try{const data=await checkInTransferRequest();const found=(data.offers as Offer[]).filter(o=>!draftId||o.id===draftId);
      setOffers(found);onChecked(found.length>0);}
    catch(e){setError(e instanceof Error?e.message:"Transfer availability could not be checked.");onChecked(false);}
    finally{setBusy(false);}
  }
  useEffect(()=>{void refresh();},[draftId]);
  return <section aria-label="Incoming check-in transfers" className="space-y-3">
    {offers.map(offer=><div key={offer.id} className="border rounded-lg p-3 space-y-2">
      <h2 className="font-semibold text-sm">An advisor offered you this check-in</h2>
      <p className="text-xs text-gray-600">Offered {new Date(offer.offeredAt).toLocaleString()}. Accepting moves ownership to your account and blocks the previous advisor’s devices. Finish or discard any check-in you already own first.</p>
      <button type="button" disabled={busy} className="rounded-lg bg-blue-600 text-white text-sm px-3 py-2 disabled:opacity-50" onClick={async()=>{
        setBusy(true);setError("");
        try{await checkInTransferRequest("",{action:"accept",id:offer.id,revision:offer.revision,deviceId:crypto.randomUUID()});onAccepted(offer.id);}
        catch(e){setError(e instanceof Error?e.message:"Acceptance is not confirmed. Refresh availability before retrying.");}
        finally{setBusy(false);}
      }}>Accept ownership and open check-in</button>
    </div>)}
    <button type="button" disabled={busy} className="text-xs text-blue-700" onClick={()=>void refresh()}>Refresh incoming transfers</button>
    {error&&<p role="alert" className="text-xs text-red-700">{error}</p>}
  </section>;
}
