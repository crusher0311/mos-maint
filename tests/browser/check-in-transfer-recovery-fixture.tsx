import React from "react";
import {createRoot} from "react-dom/client";
import {useRORecovery} from "../../components/use-ro-recovery";
import {ROCoworkerTransfer} from "../../components/ROCoworkerTransfer";
import {ROTransferInbox} from "../../components/ROTransferInbox";
import {readROSession} from "../../components/ro-session-store";

function Fixture(){
  const recovery=useRORecovery(true);
  // Test-only observation surface: all mutations still run through the real hook.
  Object.assign(window,{recovery,readROSession});
  return <main>
    <h1>Offline two-advisor check-in recovery</h1>
    <p>Synthetic cookie sessions and isolated Mongo only. No provider connection.</p>
    <p data-testid="ready">{String(recovery.ready)}</p>
    <p role="alert">{recovery.error}</p>
    <pre>{JSON.stringify({id:recovery.session?.handoffRequestId,blocked:recovery.sharedBlocked,
      status:recovery.sharedStatus,photos:recovery.session?.photos.length})}</pre>
    <button onClick={()=>void recovery.resumeSharedDraft()}>Resume server draft</button>
    <button onClick={()=>void recovery.discardDraft()}>Discard local draft</button>
    <ROCoworkerTransfer recovery={recovery} fields={recovery.session?.draft?.fields??"{}"}/>
    <ROTransferInbox onChecked={()=>{}} onAccepted={()=>recovery.reload()}/>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
