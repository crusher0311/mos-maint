"use client";
import { useEffect, useRef, useState } from "react";
import { blankFinding, type FindingInput, type StaffCommand, type StaffInspection } from "@/lib/auto-dvi/staff/model";
import type { InspectionResponse } from "./use-staff-inspection";
import styles from "./pilot.module.css";

type Check = {id: string; name: string; source: "vhi" | "shop" | "recall" | "voice"; reference: string; context?: string};
type Voice = {itemId: string; name: string; rating: "green" | "yellow" | "red" | null; notes: string | null; recommendation: string | null; newCheck?: Check};
type Assignment = {index: number; itemId: string | null; label: string | null};
type Target = {itemId: string; sheet: string; item: string; name: string};
type Suggestions = {revision: number; items?: Check[]; findings?: Voice[]; targets?: Target[]; assignments?: Assignment[]; transcript?: string; hidden?: unknown[]};
export function StaffAssistance({visitId, inspection, disabled, command, upload, onDraft}: {
  visitId: string; inspection: StaffInspection; disabled: boolean;
  command: (command: StaffCommand) => Promise<InspectionResponse | null>;
  upload: (sheet: string, item: string, file: File, provenance: "upload") => Promise<InspectionResponse | null>;
  onDraft: (sheet: string, item: string, value: FindingInput) => void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestions | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [recording, setRecording] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const files = useRef<File[]>([]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {mounted.current = false; if (recorder.current?.state === "recording") recorder.current.stop(); stream.current?.getTracks().forEach(t => t.stop());};
  }, []);
  const stale = suggestions && suggestions.revision !== inspection.revision;
  async function request(action: "generate" | "voice" | "photo-assign", payload?: FormData) {
    setBusy(true); setError(""); setSuggestions(null);
    try {
      let body: FormData | string;
      if (payload) {payload.set("visitId", visitId); payload.set("revision", String(inspection.revision)); body = payload;}
      else body = JSON.stringify({visitId, revision: inspection.revision});
      const response = await fetch(`/api/auto-dvi/${action}`, {method: "POST", credentials: "include",
        ...(typeof body === "string" ? {headers: {"Content-Type": "application/json"}} : {}), body});
      const result = await response.json();
      if (!response.ok || !result.ok || result.visitId !== visitId || result.revision !== inspection.revision)
        throw Error(result.error || "Suggestions unavailable or stale. Nothing was saved.");
      if (mounted.current) {setSuggestions(result); setSelected({});}
    } catch (cause) {if (mounted.current) setError(cause instanceof Error ? cause.message : "Assistance failed.");}
    finally {if (mounted.current) setBusy(false);}
  }
  async function record() {
    setError("");
    try {
      const media = await navigator.mediaDevices.getUserMedia({audio: true});
      stream.current = media;
      const rec = new MediaRecorder(media); recorder.current = rec;
      const chunks: Blob[] = [];
      rec.ondataavailable = e => {if (e.data.size) chunks.push(e.data);};
      rec.onstop = () => {
        media.getTracks().forEach(t => t.stop());
        if (!mounted.current) return;
        setRecording(false);
        const form = new FormData();
        form.set("audio", new File(chunks, "inspection-dictation.webm", {type: rec.mimeType || "audio/webm"}));
        void request("voice", form);
      };
      rec.start(); setRecording(true);
    } catch {setError("Microphone unavailable. You can upload an audio file or enter findings manually.");}
  }
  const locked = disabled || busy || recording || !!stale;
  return <details className={styles.panel}><summary>Inspection assistance · review before accepting</summary>
    <p>Suggestions are not inspected findings. Confirm scope checks, review dictated findings, and approve each photo assignment. No historical rating or maintenance urgency is saved as an inspection.</p>
    <div className={styles.actions}>
      <button disabled={disabled || busy || recording} onClick={() => void request("generate")}>Suggest VHI, custom checks and recalls</button>
      <button disabled={disabled || busy} onClick={() => recording ? recorder.current?.stop() : void record()}>{recording ? "Stop and review dictation" : "Record voice findings"}</button>
    </div>
    <div className={styles.form}>
      <label>Upload dictation for review<input type="file" accept="audio/*" disabled={disabled || busy || recording} onChange={event => {
        const file = event.target.files?.[0]; event.target.value = "";
        if (!file) return;
        if (file.size > 25 * 1024 * 1024) {setError("Audio must be at most 25MB."); return;}
        const form = new FormData(); form.set("audio", file); void request("voice", form);
      }} /></label>
      <label>Suggest photo assignments (up to 8 JPEG/PNG/WebP photos)<input type="file" multiple accept="image/jpeg,image/png,image/webp" disabled={disabled || busy || recording} onChange={event => {
        const incoming = Array.from(event.target.files ?? []); event.target.value = "";
        if (!incoming.length) return;
        if (incoming.length > 8 || incoming.some(f => f.size > 4 * 1024 * 1024)) {setError("Choose at most 8 photos, each at most 4MB."); return;}
        files.current = incoming;
        const form = new FormData(); incoming.forEach(file => form.append("photos", file)); void request("photo-assign", form);
      }} /></label>
    </div>
    {busy && <p role="status">Preparing reviewable suggestions. No findings are being saved.</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    {stale && <p role="alert">Evidence changed. Discard these suggestions and request a fresh review.</p>}
    {suggestions && <>
      <button disabled={busy} onClick={() => {setSuggestions(null); files.current = [];}}>Discard suggestions</button>
      {suggestions.items && <>
        <p>{suggestions.hidden?.length ?? 0} overlapping custom checks suppressed by the existing generation rules.</p>
        {suggestions.items.map(item => <label className={styles.check} key={item.id}>
          <input type="checkbox" disabled={locked} checked={!!selected[item.id]} onChange={e => setSelected({...selected, [item.id]: e.target.checked})} />
          {item.name} · {item.source} · {item.context}
        </label>)}
        <button disabled={locked || !suggestions.items.some(i => selected[i.id])} onClick={async () => {
          const items = suggestions.items!.filter(i => selected[i.id]).map(({context: _, ...item}) => item);
          if (await command({type: "add-checks", items})) setSuggestions(null);
        }}>Confirm selected checks · leave findings blank</button>
      </>}
      {suggestions.transcript && <details><summary>Dictation transcript</summary><p>{suggestions.transcript}</p></details>}
      {suggestions.findings?.map((finding, index) => {
        const target = suggestions.targets?.find(t => t.itemId === finding.itemId);
        const sheet = inspection.sheets.find(s => s.key === target?.sheet);
        const saved = target ? sheet?.results[target.item] : undefined;
        return <section className={styles.panel} key={index}><h4>{finding.name}</h4>
          <p>Suggested rating: {finding.rating || "Not evaluated"}</p><p>{finding.notes}</p><p>Proposed next step: {finding.recommendation || "None"}</p>
          {target ? <button disabled={locked} onClick={() => {
            if (!window.confirm("Confirm this dictated suggestion as your observation? Review the draft and save it explicitly.")) return;
            const base = saved ? {rating: saved.rating, notes: saved.notes, recommendation: saved.recommendation, naReason: saved.naReason, values: {...saved.values}} : blankFinding();
            onDraft(target.sheet, target.item, {...base, rating: finding.rating ?? base.rating,
              notes: [base.notes, finding.notes].filter(Boolean).join("\n").slice(0, 2000),
              recommendation: finding.recommendation ?? base.recommendation});
            setSuggestions(null);
          }}>Confirm into unsaved item draft</button> : <>
            <p>No unambiguous matching visit item. Nothing was applied.</p>
            {finding.newCheck && <button disabled={locked} onClick={async () => {
              if (!window.confirm("Add this dictated check to this visit, then review and explicitly save its finding?")) return;
              const check = finding.newCheck!;
              const result = await command({type: "add-checks", items: [check]});
              const newSheet = result?.inspection?.sheets.find(s => s.sheet.items.some(i => i.id === check.id));
              if (!newSheet) return;
              onDraft(newSheet.key, check.id, {...blankFinding(), rating: finding.rating,
                notes: finding.notes ?? "", recommendation: finding.recommendation ?? ""});
              setSuggestions(null);
            }}>Confirm new dictated check and review draft</button>}
          </>}
        </section>;
      })}
      {suggestions.assignments?.map(assignment => {
        const target = suggestions.targets?.find(t => t.itemId === assignment.itemId);
        const saved = target && inspection.sheets.find(s => s.key === target.sheet)?.results[target.item];
        return <div className={styles.panel} key={assignment.index}>
          <p>{files.current[assignment.index]?.name} → {target?.name ?? "Unassigned"} · {assignment.label}</p>
          {!saved && <p>Save the evaluated item first, or assign this photo manually using the item’s upload control.</p>}
          <button disabled={locked || !target || !saved} onClick={async () => {
            const file = files.current[assignment.index];
            if (!target || !file || !window.confirm(`Attach this photo to ${target.name}?`)) return;
            const result = await upload(target.sheet, target.item, file, "upload");
            if (result?.inspection) setSuggestions({...suggestions, revision: result.inspection.revision,
              assignments: suggestions.assignments!.filter(a => a.index !== assignment.index)});
          }}>Confirm assignment and upload</button>
        </div>;
      })}
    </>}
    <p><small>Video analysis is not available here. Arrival photos remain internal context, separate from inspection evidence and customer release selection.</small></p>
  </details>;
}
