"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Smartphone, ShieldCheck } from "lucide-react";
import NewWorkOrderModal from "@/components/NewWorkOrderModal";
import {ROTransferInbox} from "@/components/ROTransferInbox";

/** Uses the dashboard's existing signed-in layout and the exact same wizard.
 * The opaque URL id is only a selector. It is never an authentication grant.
 */
export default function CheckInPage() {
  const router = useRouter();
  const [draftId, setDraftId] = useState<string | undefined>();
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState(false);
  const [checked,setChecked]=useState(false);
  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get("draft");
    setDraftId(value || undefined); setReady(true);
  }, []);
  return <main className="min-h-[100dvh] bg-slate-50 px-4 py-10 sm:px-8">
    <section className="max-w-xl mx-auto border border-blue-100 bg-white rounded-xl p-6 space-y-4">
      <Smartphone className="w-7 h-7 text-blue-600" />
      <div><p className="text-xs uppercase tracking-wider text-blue-600">Guided check-in</p>
        <h1 className="text-2xl font-semibold text-gray-900 mt-2">Pick up where you left off.</h1>
        <p className="text-sm text-gray-600 mt-3">Resume your own check-in across devices, or accept a transfer explicitly offered to your advisor account in this shop. A link never grants access.</p></div>
      {ready&&<ROTransferInbox draftId={draftId} onChecked={hasOffers=>{if(!checked){setChecked(true);setOpen(!hasOffers);}}}
        onAccepted={id=>{setDraftId(id);setOpen(true);}}/>}
      <p className="text-xs text-gray-500 flex items-start gap-2"><ShieldCheck className="w-4 h-4 shrink-0" />Opening this page does not create a customer, vehicle or repair order.</p>
      <div className="flex flex-wrap gap-3">
        <button disabled={!ready} onClick={() => setOpen(true)} className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg disabled:opacity-50">Open guided check-in</button>
        <button onClick={() => router.push("/dashboard")} className="border border-gray-200 text-sm text-gray-700 px-4 py-2 rounded-lg">Return to dashboard</button>
      </div>
    </section>
    {ready && <NewWorkOrderModal isOpen={open} onClose={() => setOpen(false)} requestedDraftId={draftId} requireSharedDraft />}
  </main>;
}
