"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, ClipboardCheck, FileText, Plus, ShieldCheck } from "lucide-react";
import {
  BUILTIN_SHEETS, CATALOG, EMPTY_RESULT, completionErrors,
  type HistoryEntry, type Result, type Sheet, type Visit,
} from "@/lib/auto-dvi/visit-model";
import { SheetEditor } from "./SheetEditor";
import { useVisitInspection, VisitRequestError } from "./useVisitInspection";
import s from "./VisitInspection.module.css";

type Mode = "technician" | "advisor" | "customer";
const RATINGS = { green: "Good", yellow: "Monitor", red: "Attention" } as const;
const clone = (result?: Result): Result => JSON.parse(JSON.stringify(result || EMPTY_RESULT));
const date = (value: string) => new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

export default function VisitInspectionPanel(props: { vin: string; mileage: number | null }) {
  // A vehicle change must never carry another vehicle's draft or media URLs.
  return <VisitInspection key={props.vin} {...props} />;
}

function VisitInspection({ vin, mileage }: { vin: string; mileage: number | null }) {
  const api = useVisitInspection(vin);
  const [mode, setMode] = useState<Mode>("technician");
  const [selection, setSelection] = useState<{ visitId: string; shopId?: HistoryEntry["shopId"] } | null>(null);
  const [itemId, setItemId] = useState("");
  const [draft, setDraft] = useState<Result>(clone());
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [message, setMessage] = useState("");
  const [actionError, setActionError] = useState("");
  const [validation, setValidation] = useState<string[]>([]);
  const [startOpen, setStartOpen] = useState(false);
  const [roNumber, setRoNumber] = useState("");
  const [startMileage, setStartMileage] = useState(mileage === null ? "" : String(mileage));
  const [sheetEditor, setSheetEditor] = useState<{ sheet: Sheet | null; revision: number } | null>(null);
  const baseRevision = useRef(0);
  const unsaved = useRef(false); unsaved.current = dirty || !!sheetEditor;
  const startRef = useRef<HTMLDivElement>(null);
  const visits = api.data?.record.visits || [];
  const current = visits.find(v => v.status === "in_progress") || [...visits].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const historyEntry = selection?.shopId ? api.history.find(h => h.shopId === selection.shopId && h.visit.id === selection.visitId) : undefined;
  const visit = selection
    ? selection.shopId ? historyEntry?.visit : visits.find(v => v.id === selection.visitId)
    : current;
  const historical = !!selection?.shopId;
  const readOnly = historical || visit?.status === "complete" || mode !== "technician";
  const items = (visit?.sheet.itemIds || []).map(id => CATALOG.find(item => item.id === id)).filter((item): item is typeof CATALOG[number] => !!item);
  const item = items.find(it => it.id === itemId) || items[0];
  const revision = api.data?.record.revision || 0;
  const templates = [...BUILTIN_SHEETS, ...(api.data?.templates || [])].filter((sheet, index, all) => all.findIndex(it => it.id === sheet.id) === index);
  const latest = item && visit ? clone(visit.results[item.id]) : clone();
  const documented = visit ? visit.sheet.itemIds.filter(id => visit.results[id]?.rating !== null && !!visit.results[id]?.rating).length : 0;

  useEffect(() => {
    if (dirty) return;
    setDraft(clone(visit && item ? visit.results[item.id] : undefined));
    baseRevision.current = revision;
    setConflict(false);
  }, [visit, item, revision, dirty]);

  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => { if (unsaved.current) { event.preventDefault(); event.returnValue = ""; } };
    // Native in-app links are protected too. Workflow switches use guard().
    const navigation = (event: MouseEvent) => {
      const anchor = (event.target as HTMLElement)?.closest?.("a");
      if (unsaved.current && anchor && anchor.target !== "_blank" && !window.confirm("Leave this page and discard unsaved inspection changes?")) {
        event.preventDefault(); event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", prevent);
    document.addEventListener("click", navigation, true);
    return () => { window.removeEventListener("beforeunload", prevent); document.removeEventListener("click", navigation, true); };
  }, []);

  useEffect(() => { if (startOpen) startRef.current?.querySelector<HTMLInputElement>("input")?.focus(); }, [startOpen]);

  const guard = () => {
    if (api.busy) return false;
    if (dirty && !window.confirm("Discard unsaved item changes? Save first to keep them.")) return false;
    setDirty(false); setConflict(false); setValidation([]); setActionError(""); return true;
  };
  const patch = (partial: Partial<Result>) => {
    if (readOnly || !api.authorized || api.busy) return;
    if (!dirty) baseRevision.current = revision;
    setDraft(prev => ({ ...prev, ...partial })); setDirty(true); setMessage("");
  };
  const run = async (body: Record<string, unknown> | FormData, success: string) => {
    setActionError(""); setMessage("");
    try { await api.write(body); setMessage(success); return true; }
    catch (cause) {
      if (cause instanceof VisitRequestError && cause.status === 409) setConflict(true);
      setActionError(cause instanceof Error ? cause.message : "The action failed. Try again.");
      return false;
    }
  };
  const save = async () => {
    if (!visit || !item || readOnly || conflict || !dirty) return;
    if (await run({ action: "save", revision: baseRevision.current, visitId: visit.id, itemId: item.id, result: draft }, "Item saved.")) setDirty(false);
  };
  const mediaUrl = (v: Visit, mediaId: string, shopId?: HistoryEntry["shopId"]) => {
    const query = new URLSearchParams({ vin, visitId: v.id, mediaId });
    if (shopId !== undefined) query.set("shopId", String(shopId));
    return `/api/auto-dvi/visit-media?${query}`;
  };
  const evidence = (v: Visit, result: Result, shopId?: HistoryEntry["shopId"]) => <div className={s.media}>{result.media.map(media => <figure key={media.mediaId}>
    {media.kind === "video" ? <video controls preload="none" src={mediaUrl(v, media.mediaId, shopId)} aria-label={media.filename || "Inspection video"} />
      // eslint-disable-next-line @next/next/no-img-element
      : <a href={mediaUrl(v, media.mediaId, shopId)} target="_blank" rel="noopener noreferrer"><img loading="lazy" src={mediaUrl(v, media.mediaId, shopId)} alt={media.filename || "Inspection evidence"} /></a>}
    <figcaption className={s.muted}>{media.filename || "Inspection evidence"}</figcaption>
    {/* No deletion endpoint is defined. Evidence remains server-owned. */}
  </figure>)}</div>;
  const summary = (v: Visit, showResult: Result, id: string, shopId?: HistoryEntry["shopId"]) => {
    const catalogItem = CATALOG.find(it => it.id === id);
    return <section className={s.panel} key={id}>
      <div className={s.panelTitle}><h3>{catalogItem?.name || id}</h3><span className={s.badge}><span className={`${s.dot} ${showResult.rating ? s[showResult.rating] : ""}`} />{showResult.rating ? RATINGS[showResult.rating] : "Not inspected"}</span></div>
      <div className={s.panelBody}>
        <dl className={s.readings}>{(catalogItem?.fields || []).map(field => <div key={field.id}><dt>{field.label}{field.unit ? ` (${field.unit})` : ""}</dt><dd>{String(showResult.values[field.id] ?? "") || "Not recorded"}</dd></div>)}</dl>
        <div><span className={s.eyebrow}>Technician notes</span><p style={{ whiteSpace: "pre-wrap" }}>{showResult.notes || "No notes recorded."}</p></div>
        {showResult.recommendation && <div><span className={s.eyebrow}>Recommendation</span><p style={{ whiteSpace: "pre-wrap" }}>{showResult.recommendation}</p></div>}
        {evidence(v, showResult, shopId)}
      </div>
    </section>;
  };

  return <section className={s.root} aria-label="Visit inspection">
    <header className={s.header}><div><span className={s.eyebrow}>Auto DVI / Shop floor</span><h2>One visit. One clear record.</h2><p className={s.muted}>Measure → review → present. Manual findings, saved to this vehicle.</p></div><span className={s.badge}><ClipboardCheck size={16} />&nbsp; Visit-based inspection</span></header>
    <div className={s.body}>
      {api.loading && <div className={s.stack} role="status" aria-label="Loading inspection"><div className={s.skeleton} /><div className={s.skeleton} /><span>Loading inspection visits…</span></div>}
      {api.error && <div className={s.error} role="alert">{api.error} <button className={s.button} disabled={api.busy} onClick={() => void api.refresh()}>Retry / refresh</button></div>}
      {actionError && <div className={s.error} role="alert">{actionError}</div>}
      {message && <div className={s.notice} role="status">{message}</div>}
      {api.data && !api.loading && <>
        <div className={s.context}>
          <div><span className={s.eyebrow}>Vehicle / VIN</span><strong className={s.mono}>{vin}</strong><span className={s.muted}>Current vehicle only</span></div>
          <div><span className={s.eyebrow}>Repair order / mileage</span><strong>{visit?.roNumber ? `#${visit.roNumber}` : "No repair order recorded"}</strong><span className={s.muted}>{visit?.mileage == null ? "Mileage not recorded" : `${visit.mileage.toLocaleString()} mi`}</span></div>
          <div><span className={s.eyebrow}>Record / rev {revision}</span><strong>{historical ? "Shared history · read-only" : visit?.status === "complete" ? "Completed · locked" : visit ? "Inspection in progress" : "No visit started"}</strong><span className={s.muted}>{visit ? date(visit.completedAt || visit.createdAt) : "Start explicitly below"}</span></div>
        </div>
        <div className={`${s.row} ${s.spread}`}>
          <nav className={s.nav} aria-label="Inspection views">{([
            ["technician", ClipboardCheck, "01 Technician"], ["advisor", FileText, "02 Advisor review"], ["customer", ShieldCheck, "03 Customer report"],
          ] as const).map(([id, Icon, label]) => <button key={id} className={s.button} aria-pressed={mode === id} disabled={api.busy} onClick={() => { if (guard()) setMode(id); }}><Icon />{label}</button>)}</nav>
          <button className={s.button} disabled={api.busy || !api.authorized || visits.some(v => v.status === "in_progress")} onClick={() => { if (guard()) setStartOpen(true); }}><Plus />{visits.length ? "Start next visit" : "Start inspection"}</button>
        </div>
        <label className={s.field}>Visit / history
          <select value={selection ? JSON.stringify(selection) : ""} disabled={api.busy} onChange={e => { if (guard()) { setSelection(e.target.value ? JSON.parse(e.target.value) : null); setItemId(""); } }}>
            <option value="">Current / latest local visit</option>
            {visits.map(v => <option key={v.id} value={JSON.stringify({ visitId: v.id })}>{date(v.createdAt)} · RO {v.roNumber || "not recorded"} · {v.status.replace("_", " ")}</option>)}
            {api.history.map(h => <option key={`${h.shopId}:${h.visit.id}`} value={JSON.stringify({ visitId: h.visit.id, shopId: h.shopId })}>{h.shopName} · {date(h.visit.createdAt)} · shared history</option>)}
          </select>
        </label>
        {api.data.sharingReason && <div className={s.notice}>{api.data.sharingReason}</div>}
        {historical && <div className={s.notice}>Historical findings are reference only. They never fill current measurements or ratings. {historyEntry?.shopName || "Shared visit is unavailable until access is revalidated."}</div>}
        {startOpen && <section ref={startRef} className={s.panel} aria-labelledby="new-visit-heading"><div className={s.panelTitle}><h3 id="new-visit-heading">Start a new inspection visit</h3></div><form className={s.panelBody} onSubmit={async e => {
          e.preventDefault();
          const miles = startMileage.trim() ? Number(startMileage) : null;
          if (!roNumber.trim()) { setActionError("Enter a repair order number or visit reference."); return; }
          if (miles !== null && (!Number.isSafeInteger(miles) || miles < 0 || miles > 2000000)) { setActionError("Mileage must be a whole number between 0 and 2,000,000."); return; }
          if (await run({ action: "start", revision, mileage: miles, roNumber: roNumber.trim() }, "New visit started. No historical findings were copied.")) { setStartOpen(false); setSelection(null); setItemId(""); setMode("technician"); }
        }}><div className={s.fields}><label className={s.field}>Repair order number / visit reference<input required value={roNumber} maxLength={80} onChange={e => setRoNumber(e.target.value)} /></label><label className={s.field}>Mileage (optional)<input type="number" min="0" max="2000000" step="1" value={startMileage} onChange={e => setStartMileage(e.target.value)} /></label></div><p className={s.muted}>A new visit starts with blank findings. Completed visits remain unchanged.</p><div className={s.row}><button type="submit" className={`${s.button} ${s.primary}`} disabled={api.busy || !api.authorized}>Start this visit</button><button type="button" className={s.button} disabled={api.busy} onClick={() => setStartOpen(false)}>Cancel</button></div></form></section>}
        {!visit && !startOpen && <div className={s.empty}><ClipboardCheck size={32} /><h2>{historical ? "Shared visit unavailable" : "Ready when the vehicle is."}</h2><p className={s.muted}>{historical ? "Refresh to revalidate shared-history access." : "Start a visit to record measurements and evidence. Nothing is rated until a technician confirms it."}</p></div>}
        {visit && <>
          <div className={s.heading}><span className={s.eyebrow}>{mode === "technician" ? "01 / Manual inspection" : mode === "advisor" ? "02 / Read-only advisor review" : "03 / Customer report"}</span><h2>{mode === "technician" ? "Good results deserve a record." : mode === "advisor" ? "The findings, without guesswork." : "Your vehicle. Documented."}</h2><p className={s.muted}>{mode === "technician" ? "Actual measurements. Independent ratings. No automatic green results." : "Recorded findings and evidence only. No pricing, provider writes, or messages."}</p></div>
          <div className={`${s.row} ${s.spread}`}><strong>{visit.sheet.name}</strong><span className={s.badge}>{documented} / {visit.sheet.itemIds.length} rated</span></div>
          {!historical && visit.status !== "complete" && mode === "technician" && <div className={s.panel}><div className={s.panelBody}>
            <label className={s.field}>Inspection sheet snapshot<select value="__snapshot__" disabled={api.busy || !api.authorized} onChange={async e => {
              const sheet = templates.find(it => it.id === e.target.value);
              if (sheet && guard() && window.confirm("Select this sheet snapshot? Findings with the exact same item IDs will be reused; other findings stay with this visit.")) {
                if (await run({ action: "selectSheet", revision, visitId: visit.id, sheet }, "Visit sheet snapshot selected.")) setItemId("");
              }
            }}><option value="__snapshot__">{visit.sheet.name} · current snapshot</option>{templates.map(sheet => <option key={sheet.id} value={sheet.id}>{sheet.name}{sheet.id === visit.sheet.id ? " · reapply latest version" : ""}</option>)}</select></label>
            <p className={s.muted}>Templates are reusable. Editing one does not change this visit until you explicitly select its updated snapshot.</p>
            {api.data.canManageSheets && <div className={s.row}><button className={s.button} disabled={api.busy || !api.authorized} onClick={() => { if (guard()) setSheetEditor({ sheet: null, revision: api.data!.templateRevision }); }}>Create custom sheet</button>
              {(api.data.templates || []).map(sheet => <span className={s.row} key={sheet.id}><button className={s.button} disabled={api.busy || !api.authorized} onClick={() => { if (guard()) setSheetEditor({ sheet, revision: api.data!.templateRevision }); }}>Edit {sheet.name}</button><button className={s.button} disabled={api.busy || !api.authorized} onClick={() => {
                if (guard() && window.confirm(`Delete reusable sheet “${sheet.name}”? Existing visit snapshots will remain unchanged.`)) void run({ action: "templateDelete", revision, templateRevision: api.data!.templateRevision, sheetId: sheet.id }, "Template deleted. Existing snapshots unchanged.");
              }}>Delete {sheet.name}</button></span>)}
            </div>}
          </div></div>}
          {mode === "technician" && <div className={s.layout}>
            <aside className={s.panel}><div className={s.panelTitle}><h3>Inspection items</h3></div><div className={s.list}>{items.map(it => <button className={s.item} key={it.id} aria-pressed={item?.id === it.id} disabled={api.busy} onClick={() => { if (guard()) setItemId(it.id); }}><span>{it.name}</span><span className={`${s.dot} ${visit.results[it.id]?.rating ? s[visit.results[it.id].rating!] : ""}`} title={visit.results[it.id]?.rating ? RATINGS[visit.results[it.id].rating!] : "Not inspected"} /></button>)}</div></aside>
            {item ? <section className={s.panel}><div className={s.panelTitle}><h3>{item.name}</h3><span className={s.badge}>{readOnly ? "Read-only" : dirty ? "Unsaved changes" : "Saved record"}</span></div>
              {readOnly ? <div className={s.panelBody}>{dirty && <div className={s.notice}><strong>Your unsaved draft is preserved.</strong><p>This visit was locked elsewhere. It cannot be overwritten. Copy any needed observations before discarding your draft.</p><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(draft, null, 2)}</pre><button className={s.button} onClick={() => { if (guard()) setDraft(latest); }}>Discard unsaved draft</button></div>}{summary(visit, latest, item.id, selection?.shopId)}</div> : <div className={s.panelBody}>
                <p className={s.muted}>Record measurements as observed. Before and after values are independent; blank values make no adjustment claim.</p>
                <fieldset disabled={api.busy || !api.authorized} style={{ border: 0, padding: 0, margin: 0 }}><div className={s.fields}>{item.fields.map(field => {
                  const required = (visit.sheet.requiredFields[item.id] || []).includes(field.id);
                  const label = `${field.label}${field.unit ? ` (${field.unit})` : ""}${required ? " · required" : ""}`;
                  return <label className={s.field} key={field.id}>{label}
                    {field.type === "select" ? <select value={draft.values[field.id] ?? ""} onChange={e => {
                      const values = { ...draft.values, [field.id]: e.target.value };
                      // Never silently reinterpret tread readings after a unit change.
                      if (/unit/i.test(field.id) && item.kind === "tire" && draft.values[field.id] !== e.target.value) {
                        item.fields.filter(f => /tread|inner|center|outer/i.test(f.id) && f.type === "number").forEach(f => { delete values[f.id]; });
                        setMessage("Tread unit changed. Re-enter cleared tread measurements; no conversion was made.");
                      }
                      patch({ values });
                    }}><option value="">Not recorded</option>{field.options?.map(option => <option key={option} value={option}>{option}</option>)}</select>
                      : <input type={field.type} min={field.type === "number" ? 0 : undefined} max={field.type === "number" ? 10000 : undefined} maxLength={field.type === "text" ? 100 : undefined} step={field.type === "number" ? "any" : undefined} value={draft.values[field.id] ?? ""} onChange={e => {
                        const values = { ...draft.values };
                        if (e.target.value === "") delete values[field.id];
                        else values[field.id] = field.type === "number" ? Number(e.target.value) : e.target.value;
                        patch({ values });
                      }} />}
                  </label>;
                })}</div></fieldset>
                <fieldset className={s.ratings} disabled={api.busy || !api.authorized}><legend>Technician-confirmed condition</legend><div className={s.row}>{(Object.keys(RATINGS) as Array<keyof typeof RATINGS>).map(rating => <button className={s.button} key={rating} aria-pressed={draft.rating === rating} onClick={() => patch({ rating: draft.rating === rating ? null : rating })}><span className={`${s.dot} ${s[rating]}`} />{RATINGS[rating]}</button>)}</div></fieldset>
                <label className={s.field}>Condition notes<textarea maxLength={1000} disabled={api.busy || !api.authorized} value={draft.notes} onChange={e => patch({ notes: e.target.value })} placeholder="What did you observe?" /></label>
                <label className={s.field}>Recommendation (optional)<textarea maxLength={1000} disabled={api.busy || !api.authorized} value={draft.recommendation} onChange={e => patch({ recommendation: e.target.value })} placeholder="A technician recommendation, not an automatically generated finding" /></label>
                {evidence(visit, draft)}
                <label className={s.field}><span className={s.row}><Camera size={16} />Add photo / video evidence</span><input type="file" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime" disabled={api.busy || dirty || !api.authorized || conflict} onChange={async e => {
                  const file = e.target.files?.[0]; e.target.value = "";
                  if (!file) return;
                  const form = new FormData(); form.set("vin", vin); form.set("visitId", visit.id); form.set("itemId", item.id); form.set("revision", String(revision)); form.set("file", file);
                  await run(form, "Evidence uploaded and saved.");
                }} /></label><p className={s.muted}>Save item changes before uploading evidence. Uploads are persisted immediately.</p>
                {conflict && <div className={s.notice}><strong>Compare before saving again.</strong><p>Your draft above is unchanged. Latest saved item:</p><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(latest, null, 2)}</pre><div className={s.row}>
                  <button className={s.button} disabled={api.busy || !api.authorized || visit.status !== "in_progress"} onClick={() => {
                    if (window.confirm("Keep your draft against the latest revision? Your next Save will replace this item's latest saved findings.")) { baseRevision.current = revision; setConflict(false); setActionError(""); }
                  }}>Keep draft against latest revision</button>
                  <button className={s.button} onClick={() => { if (guard()) setDraft(latest); }}>Discard draft / use latest</button>
                </div></div>}
                <div className={`${s.row} ${s.spread}`}><span className={s.muted}>Explicit saves only. {dirty ? "This item has unsaved changes." : "No unsaved changes."}</span><button className={`${s.button} ${s.primary}`} disabled={!dirty || api.busy || conflict || !api.authorized} onClick={() => void save()}>{api.busy ? "Saving…" : "Save item"}</button></div>
              </div>}
            </section> : <div className={s.empty}>This sheet has no available catalog items.</div>}
          </div>}
          {mode === "advisor" && <><div className={s.notice}>Read-only review of the persisted record. {visit.status !== "complete" ? "Inspection is still in progress; findings may change." : "Completed findings cannot be edited."}</div><div className={s.stack}>{visit.sheet.itemIds.map(id => summary(visit, clone(visit.results[id]), id, selection?.shopId))}</div></>}
          {mode === "customer" && (visit.status !== "complete" ? <div className={s.empty}><ShieldCheck size={32} /><h2>Report not finalized.</h2><p className={s.muted}>Complete the technician inspection first. A customer report presents only the immutable completed visit.</p><button className={s.button} onClick={() => { if (guard()) setMode("technician"); }}>Back to technician</button></div> : <><div className={s.notice}>Completed {date(visit.completedAt || visit.createdAt)} · Read-only inspection report. Recommendations are observations, not a quote or authorization.</div><div className={s.stack}>{visit.sheet.itemIds.map(id => summary(visit, clone(visit.results[id]), id, selection?.shopId))}</div></>)}
          {!historical && mode === "technician" && visit.status === "in_progress" && <section className={s.panel}><div className={s.panelBody}>
            <div className={`${s.row} ${s.spread}`}><div><h3>Finish the inspection</h3><p className={s.muted}>Completion locks this visit permanently. Start a new visit for the next inspection.</p></div><button className={`${s.button} ${s.primary}`} disabled={api.busy || dirty || conflict || !api.authorized} onClick={async () => {
              const errors = completionErrors(visit); setValidation(errors);
              if (errors.length) return;
              if (window.confirm("Complete and permanently lock this inspection? Findings and evidence can no longer be edited.")) await run({ action: "complete", revision, visitId: visit.id }, "Inspection completed and locked.");
            }}>Complete inspection</button></div>
            {dirty && <p className={s.notice}>Save or discard the current item draft before completing this visit.</p>}
            {!!validation.length && <div className={s.error} role="alert"><strong>Finish these required entries:</strong><ul>{validation.map((text, index) => <li key={index}>{text}</li>)}</ul></div>}
          </div></section>}
        </>}
      </>}
    </div>
    <footer className={s.footer}>This visit-based workflow does not replace the full existing Auto DVI. Vehicle-specific generation, shop custom items, dictation, photo assignment, phone mode, recalls, and repair-order writes remain in the existing-inspection option. Those capabilities are not yet connected to visit records. Shared history is read-only; this surface does not generate findings, send messages, or publish reports.</footer>
    {sheetEditor && <SheetEditor initial={sheetEditor.sheet} busy={api.busy} canSave={!!api.data?.canManageSheets && api.authorized} onClose={() => { setSheetEditor(null); setConflict(false); }} onSave={async sheet => {
      if (!api.data?.canManageSheets || !api.authorized) return false;
      const success = await run({ action: "templateSave", revision, templateRevision: sheetEditor.revision, sheet }, "Reusable sheet saved. Existing visit snapshots unchanged.");
      if (!success) setActionError("Sheet not saved. If it changed elsewhere, close and reopen this editor to load the latest template. Your editor changes are still here.");
      return success;
    }} />}
  </section>;
}
