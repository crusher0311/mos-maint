"use client";
import { useState } from "react";
type Visit = {visitId: string; ro: string; vehicle: string; provider: string; closed: boolean};
/** Deliberate selection, including when only one visit matches. */
export function WorkflowDviEntry({vin}: {vin: string}) {
  const [visits, setVisits] = useState<Visit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function load() {
    setBusy(true); setError(""); setVisits(null);
    try {
      const response = await fetch(`/api/shop-dispatch/inspection/visits?${new URLSearchParams({vin})}`, {cache: "no-store"});
      const data = await response.json();
      if (!response.ok) throw Error(data.error || "DVI visit access could not be checked.");
      setVisits(data.visits);
    } catch (cause) {setError(cause instanceof Error ? cause.message : "Visit lookup failed.");}
    finally {setBusy(false);}
  }
  return <section className="rounded-lg border p-4 space-y-3" aria-label="Visit-bound DVI">
    <h3 className="font-semibold">DVI · saved inspection visits</h3>
    <p className="text-sm">Open the same inspection on desktop or phone. Choose the intended visit; previous visits never supply current findings.</p>
    <button type="button" className="rounded border px-4 py-3" disabled={busy} onClick={() => void load()}>{busy ? "Checking access…" : "Choose inspection visit"}</button>
    {error && <p role="alert">{error}</p>}
    {visits && <><ul className="space-y-2">{visits.map(v => <li key={v.visitId}>
      <a className="block rounded border p-3" href={`/dashboard/inspections/${encodeURIComponent(v.visitId)}`}>
        RO {v.ro} · {v.vehicle} · {v.closed ? "Closed · read only" : "Open visit"} · {v.provider}
      </a>
    </li>)}</ul><p className="text-sm">{!visits.length && "No canonically matched visits found. "}Unmapped visits remain in <a className="underline" href="/dashboard/shop-workflow">Shop Workflow</a>. Use the confirmed RO handoff to add an existing ticket; this lookup creates nothing.</p></>}
  </section>;
}
