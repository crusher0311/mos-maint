"use client";
import { useEffect, useRef, useState } from "react";
import { blankFinding, instanceKey, missingFor, missingRequirements, type FindingInput, type Finding, type StaffItem, type SheetInstance } from "@/lib/auto-dvi/staff/model";
import { useStaffInspection } from "./use-staff-inspection";
import { ReleasePanel } from "./ReleasePanel";
import { PilotInspectionPanel } from "./PilotInspectionPanel";
import { ArrivalPhotoDocumentation } from "./ArrivalPhotoDocumentation";
import { StaffAssistance } from "./StaffAssistance";
import { StaffProposedWork } from "./StaffProposedWork";
import { StaffCaptureEditor, captureKind } from "./StaffCaptureEditor";
import { StaffAdvisorView } from "./StaffAdvisorView";
import { StaffInspectionHistory } from "./StaffInspectionHistory";
import styles from "./pilot.module.css";
import ui from "./StaffInspectionPanel.module.css";

type Drafts = Record<string, FindingInput>;
const draftKey = (sheet: string, item: string) => `${sheet}/${item}`;
function inputOf(finding?: Finding): FindingInput {
  return finding ? { rating: finding.rating, notes: finding.notes, recommendation: finding.recommendation, naReason: finding.naReason, values: { ...finding.values } } : blankFinding();
}
function stamp(value: { actor: string; at: string; revision: number } | null, evidence: number) {
  return value ? `${value.revision === evidence ? "Current" : "Stale — evidence changed"} · ${value.actor} · ${new Date(value.at).toLocaleString()} · evidence ${value.revision}` : "Not recorded";
}
export function StaffInspectionPanel({ visitId, shopId, closed = false, onLockChange, startRequested = false }: { visitId: string; shopId?: number; closed?: boolean; onLockChange?: (locked: boolean) => void; startRequested?: boolean }) {
  return <InspectionEditor key={`${shopId}:${visitId}`} visitId={visitId} shopId={shopId} closed={closed} onLockChange={onLockChange} startRequested={startRequested} />;
}
function InspectionEditor({ visitId, shopId, closed, onLockChange, startRequested }: { visitId: string; shopId?: number; closed: boolean; onLockChange?: (locked: boolean) => void; startRequested: boolean }) {
  const api = useStaffInspection(visitId, shopId);
  const startConsumed = useRef(false);
  const commandRef = useRef(api.command);
  commandRef.current = api.command;
  useEffect(() => {
    const data = api.data;
    if (!startRequested || startConsumed.current || !data || api.loading) return;
    startConsumed.current = true;
    if (closed || data.record?.closed || data.inspection || data.bindingRequest || api.pending || api.conflict) return;
    // Only the explicit Start DVI entry requests initialization. Ordinary visit
    // navigation is read-only until the advisor presses Start DVI in this panel.
    // command rechecks current server access: this panel may predate ticket creation.
    void commandRef.current({ type: "initialize", boardRevision: data.boardRevision });
  }, [startRequested, api.data, api.loading, api.pending, api.conflict, closed]);
  const [drafts, setDrafts] = useState<Drafts>({});
  const [proposalDirty, setProposalDirty] = useState(false);
  const [view, setView] = useState<"editor" | "advisor">("editor");
  const [sheetChoice, setSheetChoice] = useState("");
  const [keepActive, setKeepActive] = useState(false);
  const [retryFile, setRetryFile] = useState<File | undefined>();
  const dirty = Object.keys(drafts).length > 0;
  const shouldWarnBeforeLeave = dirty || proposalDirty || !!api.pending || api.busy;
  const lockCallback = useRef(onLockChange);
  lockCallback.current = onLockChange;
  useEffect(() => {
    lockCallback.current?.(shouldWarnBeforeLeave);
    return () => lockCallback.current?.(false);
  }, [shouldWarnBeforeLeave]);
  useEffect(() => {
    if (!shouldWarnBeforeLeave) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [shouldWarnBeforeLeave]);
  function update(key: string, value: FindingInput) {
    const next = { ...drafts, [key]: value };
    setDrafts(next);
  }
  function acknowledge(sheet?: string, item?: string) {
    const next = { ...drafts };
    if (sheet && item) delete next[draftKey(sheet, item)];
    setDrafts(next);
  }
  async function retry() {
    const request = api.pending;
    if (await api.retry(retryFile)) {
      if (request?.kind === "command" && request.body.command.type === "save") acknowledge(request.body.command.sheet, request.body.command.item);
      setRetryFile(undefined);
    }
  }
  const { data } = api;
  if (api.loading) return <div className={styles.skeleton} role="status" aria-label="Loading internal staff inspection" />;
  if (!data) return <section className={styles.panel}><h2>Staff inspection</h2><p className={styles.error} role="alert">{api.error || "Inspection is unavailable."}</p><button onClick={() => void api.reload()}>Retry loading inspection</button></section>;
  const inspection = data.inspection;
  const readOnly = closed || !!data.record?.closed || !data.enabled || !data.canEdit;
  const recoveryAllowed = !closed && !data.record?.closed && data.enabled && !!data.bindingRequest;
  const locked = readOnly || api.busy || !!api.pending || api.conflict;
  const missing = inspection ? missingRequirements(inspection) : [];
  const reviewAllowed = !closed && !data.record?.closed && data.enabled && data.canReview && !api.busy && !api.pending && !api.conflict && !dirty && !proposalDirty;
  return <section className={`${styles.panel} ${ui.panel}`} data-testid="staff-inspection-panel" aria-label="Internal staff inspection">
    <div className={ui.heading}><div><div className={styles.eyebrow}>Staff workspace · Internal only</div><h2>Vehicle inspection</h2><p>Document findings in their original measured units. This does not release a vehicle, authorize work, or change dispatch capacity.</p></div><span className={styles.chip}>{inspection ? `Revision ${inspection.revision} · Evidence ${inspection.evidenceRevision}` : "Not initialized"}</span></div>
    <StaffInspectionHistory visitId={visitId} />
    <ArrivalPhotoDocumentation visitId={visitId} disabled={locked || dirty}
      targets={inspection?.sheets.filter(s => s.active).flatMap(s => s.sheet.items.filter(i => s.results[i.id]?.rating).map(i => ({
        key: JSON.stringify([s.key, i.id]), label: `${s.sheet.name} · ${i.name}`,
        associated: s.results[i.id].arrivalPhotos?.map(p => p.id) ?? [],
      }))) ?? []}
      onAssociate={(target, mediaId) => { const [sheet, item] = JSON.parse(target); void api.command({type: "associate-arrival", sheet, item, mediaId}); }} />
    {readOnly && <p className={styles.notice}>Read only · {closed || data.record?.closed ? "This visit is closed." : !data.enabled ? "The inspection gate is off. Existing evidence is preserved." : "Inspection edit permission is required."}</p>}
    {data.error && <p className={styles.notice} role="status">{data.error}</p>}
    {api.error && <p className={styles.error} role="alert">{api.error}</p>}
    {api.notice && <p role="status" className={styles.brandingInfo}>{api.notice}</p>}
    {api.pending && <div className={ui.pending} role="status">
      <strong>{api.pending.kind === "photo" ? `${api.busy ? "Uploading" : "Failed / unconfirmed upload"}: ${api.pending.name}` : "Request awaiting acknowledgment"}</strong>
      <p>Not claimed saved. The original request ID and revision are retained. Resolve this request before making another change.</p>
      <small>Request {api.pending.kind === "command" ? api.pending.body.requestId : api.pending.requestId}</small>
      {api.pending.kind === "photo" && <label>Original photo for exact retry<input type="file" accept="image/jpeg,image/png,image/webp" disabled={api.busy} onChange={event => setRetryFile(event.target.files?.[0])} /></label>}
      <div className={styles.actions}><button disabled={api.busy || (readOnly && !recoveryAllowed)} onClick={() => void retry()}>{recoveryAllowed ? "Recover original inspection linking request" : `Retry exact ${api.pending.kind === "photo" ? "upload" : "request"}`}</button><button disabled={api.busy} onClick={() => void api.compare()}>Check latest server values</button></div>
    </div>}
    {(api.conflict || dirty) && <div className={styles.notice}>
      <strong>{api.conflict ? "Revision conflict — draft retained" : `${Object.keys(drafts).length} unsaved item draft(s)`}</strong>
      <p>Drafts remain in memory on this page only. Comparing never replaces your entries. After a conflict, review both versions, then explicitly discard/reload before entering a new submission; drafts are never silently rebased.</p>
      <div className={styles.actions}><button disabled={api.busy} onClick={() => void api.compare()}>Compare with latest server values</button><button disabled={api.busy || !!api.pending} onClick={async () => {
        if (!window.confirm("Discard all unsaved inspection entries and load the latest server values? This cannot undo saved evidence.")) return;
        if (await api.discardAndReload()) setDrafts({});
      }}>Discard drafts and reload latest</button></div>
    </div>}
    {api.latest && <details open><summary>Server comparison · no local entries replaced</summary><div className={ui.compare}><div><h3>Your entries / loaded evidence</h3><pre>{JSON.stringify({ inspection, unsavedEntries: drafts }, null, 2)}</pre></div><div><h3>Latest server evidence</h3><pre>{JSON.stringify(api.latest.inspection, null, 2)}</pre></div></div></details>}
    {!inspection ? <div className={styles.empty}><h3>Start a digital vehicle inspection</h3><p>Create a saved DVI with the shop’s approved inspection sheet. Inspection work is recorded when you save your first finding. This never creates a provider ticket or sends findings.</p><button className={styles.primary} disabled={locked || !data.catalog.length} onClick={() => void api.command({ type: "initialize", boardRevision: data.boardRevision })}>Start DVI</button>{!data.catalog.length && <p>No approved sheets are available. Ask a manager to provision a sheet.</p>}</div> : <>
      <div className={ui.status}><span><small>Work</small><br />{inspection.startedAt ? `Started ${new Date(inspection.startedAt).toLocaleString()}` : "Not started"}</span><span><small>Readiness</small><br />{stamp(inspection.ready, inspection.evidenceRevision)}</span><span><small>Advisor review</small><br />{stamp(inspection.reviewed, inspection.evidenceRevision)}</span></div>
      <div className={ui.views} role="group" aria-label="Inspection view">
        <button type="button" aria-pressed={view === "editor"} disabled={shouldWarnBeforeLeave || api.conflict} onClick={() => { if (!shouldWarnBeforeLeave && !api.conflict) setView("editor"); }}>Inspection editor</button>
        <button type="button" aria-pressed={view === "advisor"} disabled={shouldWarnBeforeLeave || api.conflict} onClick={() => { if (!shouldWarnBeforeLeave && !api.conflict) setView("advisor"); }}>Advisor overview · read only</button>
        {shouldWarnBeforeLeave || api.conflict ? <small>Save or explicitly discard drafts and resolve pending requests or conflicts before switching views.</small> : <small>The advisor overview shows saved evidence, never unsaved entries.</small>}
      </div>
      {view === "advisor" ? <StaffAdvisorView inspection={inspection} visitId={visitId} /> : <>
      <StaffAssistance visitId={visitId} inspection={inspection} disabled={locked || dirty}
        command={api.command} upload={api.upload}
        onDraft={(sheet, item, value) => update(draftKey(sheet, item), value)} />
      <details><summary>Manage approved sheets · multiple sheets may be active</summary><div className={styles.form}>
        <label>Approved sheet version<select value={sheetChoice} disabled={locked} onChange={event => setSheetChoice(event.target.value)}><option value="">Choose a sheet</option>{data.catalog.map(sheet => <option key={instanceKey(sheet)} value={instanceKey(sheet)}>{sheet.name} · v{sheet.version}</option>)}</select></label>
        <label className={styles.check}><input type="checkbox" checked={keepActive} disabled={locked} onChange={event => setKeepActive(event.target.checked)} />Keep existing sheets active</label>
        <div><button disabled={locked || dirty || !sheetChoice} onClick={() => void api.command({ type: "select", sheet: sheetChoice, keepActive })}>Select approved sheet</button></div>
        <small>Inactive sheets and their evidence remain readable. Save or discard drafts before changing sheets.</small>
      </div></details>
      {inspection.sheets.map(sheet => <section key={sheet.key} className={ui.sheet} aria-label={`${sheet.sheet.name} version ${sheet.sheet.version}`}>
        <div className={styles.row}><div><h3>{sheet.sheet.name} <small>v{sheet.sheet.version}</small></h3><span className={styles.chip}>{sheet.active ? "Active" : "Inactive · evidence preserved"} · {sheet.selection}</span></div><button disabled={locked || dirty || (sheet.active && inspection.sheets.filter(s => s.active).length === 1)} onClick={() => void api.command({ type: "active", sheet: sheet.key, active: !sheet.active })}>{sheet.active ? "Deactivate sheet" : "Activate sheet"}</button></div>
        {sheet.sheet.items.map(item => <InspectionItem key={item.id} item={item} sheet={sheet} visitId={visitId} value={drafts[draftKey(sheet.key, item.id)] ?? inputOf(sheet.results[item.id])} dirty={!!drafts[draftKey(sheet.key, item.id)]} disabled={locked || !sheet.active} onChange={value => update(draftKey(sheet.key, item.id), value)} onSave={async value => {
          if (await api.command({ type: "save", sheet: sheet.key, item: item.id, finding: value })) acknowledge(sheet.key, item.id);
        }} onPhoto={(file, provenance) => { void api.upload(sheet.key, item.id, file, provenance); }} />)}
      </section>)}
      </>}
      <details><summary>Saved evidence completeness · {missing.length} missing requirement(s)</summary>{missing.length ? <ul>{missing.map((entry, index) => <li key={`${entry.sheet}/${entry.item}/${index}`}>{inspection.sheets.find(sheet => sheet.key === entry.sheet)?.sheet.name} · {entry.name}: {entry.message}</li>)}</ul> : <p>All active-sheet requirements are documented in saved evidence.</p>}</details>
      <div className={styles.actions} style={{ marginTop: 16 }}>
        <button className={styles.primary} disabled={locked || dirty || !inspection.startedAt || !!missing.length} onClick={() => void api.command({ type: "ready" })}>Mark internal inspection ready</button>
        <button disabled={!reviewAllowed || !inspection.startedAt || !!missing.length} onClick={() => void api.command({ type: "review" })}>Record advisor review</button>
      </div><small>Readiness and review reference saved evidence only. Any evidence change makes earlier markers stale. These markers do not authorize customer release.</small>
      <StaffProposedWork visitId={visitId} inspection={inspection} disabled={locked || dirty || !data.canReview} command={api.command} onLockChange={setProposalDirty} />
      <ReleasePanel visitId={visitId} shopId={shopId} inspection={inspection} />
      <p><small>Provider export is available only through separately approved visit-scoped integrations. Unsupported destinations and priced-work export are unavailable; there is no fallback to legacy VIN findings.</small></p>
      <PilotInspectionPanel visitId={visitId} shopId={shopId} evidenceRevision={inspection.evidenceRevision} blocked={dirty || proposalDirty || locked} />
    </>}
  </section>;
}
function InspectionItem({ item, sheet, visitId, value, dirty, disabled, onChange, onSave, onPhoto }: {
  item: StaffItem; sheet: SheetInstance; visitId: string; value: FindingInput; dirty: boolean; disabled: boolean;
  onChange: (value: FindingInput) => void; onSave: (value: FindingInput) => Promise<void>; onPhoto: (file: File, provenance: "camera" | "upload") => void;
}) {
  const saved = sheet.results[item.id];
  const missing = missingFor(item, saved);
  const id = `inspection-${sheet.key.replace(/[^a-zA-Z0-9_-]/g, "-")}-${item.id}`;
  const field = (patch: Partial<FindingInput>) => onChange({ ...value, ...patch });
  return <article className={ui.item} data-testid={`inspection-item-${item.id}`}>
    <h4>{item.name} {item.position && <small>· {item.position}</small>}</h4><small>Procedure: {item.procedure} · {item.required ? "Required" : "Optional"}{dirty ? " · Unsaved draft" : saved ? " · Saved" : " · Not recorded"}</small>
    <form onSubmit={event => { event.preventDefault(); void onSave(value); }}>
      <fieldset disabled={disabled}><legend>Evaluation · document green findings too</legend>
        <div className={ui.ratings}>{([["green", "Green · satisfactory"], ["yellow", "Yellow · attention"], ["red", "Red · urgent"], ["na", "N/A"]] as const).map(([rating, label]) => <label key={rating}><input type="radio" name={`${id}-rating`} checked={value.rating === rating} onChange={() => field({ rating })} />{label}</label>)}<label><input type="radio" name={`${id}-rating`} checked={value.rating === null} onChange={() => field({ rating: null })} />Not evaluated</label></div>
        {value.rating === "na" && <label style={{ marginTop: 12 }}>N/A reason · required (inaccessible is not N/A)<textarea required maxLength={2000} rows={2} value={value.naReason} onChange={event => field({ naReason: event.target.value })} /></label>}
        {captureKind(item) ? <StaffCaptureEditor item={item} id={id} value={value} onChange={onChange} /> : <div className={ui.documentation}>{item.fields.map(measurement => <label key={measurement.id} htmlFor={`${id}-${measurement.id}`}>{measurement.label}{measurement.unit ? ` (${measurement.unit})` : ""}{item.requiredFields.includes(measurement.id) ? " · required for completeness" : ""}
          {measurement.type === "select" ? <select id={`${id}-${measurement.id}`} value={String(value.values[measurement.id] ?? "")} onChange={event => field({ values: { ...value.values, [measurement.id]: event.target.value } })}><option value="">Not entered</option>{measurement.options?.map(option => <option key={option} value={option}>{option}</option>)}</select> : <input id={`${id}-${measurement.id}`} type={measurement.type === "number" ? "number" : "text"} min={measurement.type === "number" ? 0 : undefined} max={measurement.type === "number" ? 100000 : undefined} step={measurement.type === "number" ? "any" : undefined} maxLength={150} value={String(value.values[measurement.id] ?? "")} onChange={event => field({ values: { ...value.values, [measurement.id]: event.target.value === "" ? "" : measurement.type === "number" ? Number(event.target.value) : event.target.value } })} />}
        </label>)}</div>}
        <div className={ui.documentation}><label>Evaluation notes {item.notesRequired ? "· required for completeness" : "· optional"}<textarea rows={3} maxLength={2000} value={value.notes} onChange={event => field({ notes: event.target.value })} /></label><label>Recommendation / next step {item.recommendationRequired ? "· required for completeness" : "· optional"}<textarea rows={3} maxLength={2000} value={value.recommendation} onChange={event => field({ recommendation: event.target.value })} /></label></div>
        <div className={styles.actions} style={{ marginTop: 12 }}><button type="submit" disabled={!dirty}>Save item evidence</button><small>Measurements start empty. Enter what was measured; no unit conversion is applied.</small></div>
      </fieldset>
    </form>
    {missing.length > 0 && <p className={ui.missing}>Missing from saved evidence: {missing.join(" · ")}</p>}
    {saved && <small className={ui.metadata}>Last item save: {saved.actor} · {new Date(saved.at).toLocaleString()}</small>}
    {!!saved?.arrivalPhotos?.length && <details><summary>Associated arrival documentation · {saved.arrivalPhotos.length}</summary>
      <p><small>Linked from arrival documentation, not captured during this evaluation. Does not satisfy required inspection photos.</small></p>
      <ul className={ui.photos}>{saved.arrivalPhotos.map(photo => {
        const url = `/api/dashboard/protractor/arrival-photos?${new URLSearchParams({visitId, mediaId: photo.id})}`;
        return <li key={photo.id}><a href={url} target="_blank" rel="noreferrer"><img src={url} alt={`Arrival documentation associated with ${item.name}`} loading="lazy" />Open arrival photo</a>
          <small>Arrival saved {new Date(photo.capturedAt).toLocaleString()}<br />Associated by {photo.actor} · {new Date(photo.at).toLocaleString()}</small></li>;
      })}</ul>
    </details>}
    <details><summary>Photo documentation · {saved?.photos.length ?? 0} saved {item.photoRequired ? "· required" : "· optional"}</summary>
      <ul className={ui.photos}>{saved?.photos.map(photo => {
        const url = `/api/shop-dispatch/inspection/media?${new URLSearchParams({ visitId, sheet: sheet.key, item: item.id, mediaId: photo.id })}`;
        return <li key={photo.id}><a href={url} target="_blank" rel="noreferrer"><img src={url} alt={`Saved evidence for ${item.name}`} loading="lazy" />Open saved photo</a><small>Saved · {photo.provenance}<br />{photo.actor} · {new Date(photo.at).toLocaleString()}</small></li>;
      })}</ul>
      {!saved?.photos.length && <p><small>No saved photos. A selected file is not saved until the server confirms it.</small></p>}
      <div className={ui.documentation}>{(["camera", "upload"] as const).map(provenance => <label key={provenance}>{provenance === "camera" ? "Capture camera photo" : "Upload photo"}<input type="file" accept="image/jpeg,image/png,image/webp" capture={provenance === "camera" ? "environment" : undefined} disabled={disabled} onChange={event => { const file = event.target.files?.[0]; if (file) onPhoto(file, provenance); event.target.value = ""; }} /></label>)}</div>
    </details>
  </article>;
}
