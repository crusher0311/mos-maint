import React from "react";
import {createRoot} from "react-dom/client";
import {useRORecovery} from "../../components/use-ro-recovery";
function Fixture() {
  const [confirmed,setConfirmed] = React.useState(0);
  const api = useRORecovery(true, () => setConfirmed(n=>n+1));
  const [note,setNote] = React.useState("Synthetic waiting customer");
  return <main><h1>Isolated Protractor recovery check</h1>
    <textarea value={note} onChange={e=>setNote(e.target.value)}/>
    <button disabled={!api.ready || api.busy || !!api.session?.payload} onClick={()=>api.create({
      clientRequestId:crypto.randomUUID(), contactId:"synthetic-contact", vehicleId:"synthetic-vehicle", note,
      concerns:["Synthetic rattle"], servicePackages:[],
    })}>Create</button>
    <button disabled={!api.ready || api.busy || !api.session?.payload} onClick={()=>api.verify()}>Verify</button>
    <pre id="state">{JSON.stringify({ready:api.ready,busy:api.busy,error:api.error,session:api.session,confirmed})}</pre>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
