"use client";
import {useEffect, useState} from "react";
import type {StaffCommand, StaffInspection} from "@/lib/auto-dvi/staff/model";
import type {InspectionResponse} from "./use-staff-inspection";
import styles from "./pilot.module.css";
type Draft = {id: string; title: string; hours: string; rate: string; basis: "history" | "default" | "manual"; revision: number; note: string};
export function StaffProposedWork({visitId, inspection, disabled, command, onLockChange}: {
  visitId: string; inspection: StaffInspection; disabled: boolean;
  command: (command: StaffCommand) => Promise<InspectionResponse | null>;
  onLockChange: (locked: boolean) => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => {onLockChange(!!draft || busy); return () => onLockChange(false);}, [!!draft, busy, onLockChange]);
  const recommendations = inspection.sheets.filter(s => s.active).flatMap(s => s.sheet.items.flatMap(i =>
    s.results[i.id]?.recommendation ? [{id: `${s.key}/${i.id}`, title: s.results[i.id].recommendation}] : []));
  const stale = !!draft && draft.revision !== inspection.revision;
  async function suggest(id: string) {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/shop-dispatch/inspection/proposals", {method: "POST", credentials: "include",
        headers: {"Content-Type": "application/json"}, body: JSON.stringify({visitId, revision: inspection.revision, id})});
      const result = await response.json();
      if (!response.ok || result.visitId !== visitId || result.revision !== inspection.revision) throw Error(result.error || "Pricing suggestion unavailable.");
      setDraft({id, title: result.title, hours: String(result.hours), rate: String(result.rate),
        basis: result.basis, revision: result.revision, note: `Hours: ${result.basis}; rate: ${result.rateSource}. ${result.notice}`});
    } catch (cause) {setError(cause instanceof Error ? cause.message : "Pricing suggestion failed.");}
    finally {setBusy(false);}
  }
  return <details className={styles.panel}><summary>Proposed work · optional labor pricing</summary>
    <p>Proposals are internal suggestions, never authorized or performed. Customer releases contain findings only. No taxes, fees, parts estimates or provider job writes are created here.</p>
    {recommendations.map(r => <div key={r.id} className={styles.panel}><p>{r.title}</p>
      <button disabled={disabled || busy} onClick={() => setDraft({id: r.id, title: r.title, hours: "", rate: "", basis: "manual", revision: inspection.revision, note: "Enter proposed labor, not an authoritative estimate."})}>Enter proposed labor</button>{" "}
      <button disabled={disabled || busy} onClick={() => void suggest(r.id)}>Suggest labor from existing pricing tools</button>
    </div>)}
    {!recommendations.length && <p>Save an item recommendation before proposing paid work.</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {draft && <form className={styles.form} onSubmit={async e => {
      e.preventDefault();
      if (stale || draft.hours.trim() === "" || draft.rate.trim() === "") return;
      if (await command({type: "proposal", id: draft.id, title: draft.title, hours: Number(draft.hours),
        rate: Number(draft.rate), basis: draft.basis, remove: false})) setDraft(null);
    }}>
      <p>{draft.note}</p>{stale && <p role="alert">Inspection changed. Discard this proposal draft and reopen it against the current saved revision.</p>}
      <fieldset disabled={disabled || busy || stale}>
        <label>Proposed service title<input required maxLength={500} value={draft.title} onChange={e => setDraft({...draft, title: e.target.value, basis: "manual"})} /></label>
        <label>Proposed labor hours<input required type="number" min={0} max={100} step="any" value={draft.hours} onChange={e => setDraft({...draft, hours: e.target.value, basis: "manual"})} /></label>
        <label>Proposed hourly rate<input required type="number" min={0} max={10000} step="0.01" value={draft.rate} onChange={e => setDraft({...draft, rate: e.target.value, basis: "manual"})} /></label>
        <button type="submit">Confirm and save proposal</button>
      </fieldset><button type="button" onClick={() => setDraft(null)}>Discard proposal draft</button>
    </form>}
    {(inspection.proposals ?? []).map(p => <div className={styles.panel} key={p.id}><h4>{p.title}</h4>
      <p>Proposed only · {p.hours} hours × {p.rate.toFixed(2)} = {(Math.round(p.hours * Math.round(p.rate * 100)) / 100).toFixed(2)} labor subtotal.</p>
      <p>Pricing basis: {p.basis} · {p.evidenceRevision === inspection.evidenceRevision ? "Current evidence" : "Evidence changed — reconfirm proposal"}.</p>
      <button disabled={disabled || busy} onClick={() => setDraft({id: p.id, title: p.title, hours: String(p.hours), rate: String(p.rate), basis: p.basis, revision: inspection.revision, note: "Review proposed pricing against current evidence."})}>Edit / reconfirm proposal</button>{" "}
      <button disabled={disabled || busy} onClick={() => {
        if (window.confirm("Remove this proposed work? No inspection evidence or provider work is deleted."))
          void command({type: "proposal", id: p.id, title: p.title, hours: p.hours, rate: p.rate, basis: p.basis, remove: true});
      }}>Remove proposal</button>
    </div>)}
    <p><small>Proposal edits clear advisor review. Provider export below is inspection-only; priced work export is unavailable.</small></p>
  </details>;
}
