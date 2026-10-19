"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { StaffInspection } from "@/lib/auto-dvi/staff/model";
import type { CustomerReport, ReleaseSelection } from "@/lib/auto-dvi/release/model";
import { CustomerInspectionReport } from "./CustomerInspectionReport";
import { useInspectionRelease } from "./use-inspection-release";
import ui from "./ReleasePanel.module.css";

type Selected = ReleaseSelection["findings"][number];
const keyOf = (sheet: string, item: string) => `${sheet}/${item}`;
function initialSelection(inspection: StaffInspection): Selected[] {
  return inspection.sheets.flatMap(sheet => sheet.active ? sheet.sheet.items.flatMap(item => {
    const finding = sheet.results[item.id];
    return finding?.rating && finding.rating !== "na" ? [{ sheet: sheet.key, item: item.id, includeInactive: false, customerText: "", nextStep: "", photoIds: [], concernIds: [] }] : [];
  }) : []);
}
export function ReleasePanel({ visitId, shopId, inspection }: { visitId: string; shopId?: number; inspection: StaffInspection }) {
  return <ReleaseEditor key={`${shopId}:${visitId}`} visitId={visitId} shopId={shopId} inspection={inspection} />;
}
function ReleaseEditor({ visitId, shopId, inspection }: { visitId: string; shopId?: number; inspection: StaffInspection }) {
  const api = useInspectionRelease(visitId, shopId);
  const [findings, setFindings] = useState<Selected[]>(() => initialSelection(inspection));
  const [ack, setAck] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [copied, setCopied] = useState("");
  const [expiry, setExpiry] = useState("");
  const evidence = JSON.stringify({
    selected: findings.map(f => {
      const sheet = inspection.sheets.find(s => s.key === f.sheet);
      return {active: sheet?.active, item: sheet?.sheet.items.find(i => i.id === f.item), finding: sheet?.results[f.item]};
    }),
    hazards: inspection.sheets.flatMap(s => s.sheet.items.filter(i => s.results[i.id]?.rating === "red").map(i => `${s.key}/${i.id}`)),
  });
  const previousEvidence = useRef(evidence);
  // An evidence edit is not a new approval of the old preview.
  useEffect(() => {
    if (previousEvidence.current !== evidence) { api.invalidate(); setAck(false); previousEvidence.current = evidence; }
  }, [evidence, api.invalidate]);
  useEffect(() => {
    if (api.pending?.type === "preview") { setFindings(api.pending.selection.findings); setAck(false); }
  }, [api.pending]);
  const available = useMemo(() => inspection.sheets.flatMap(sheet => sheet.sheet.items.flatMap(item => {
    const result = sheet.results[item.id];
    return result?.rating && result.rating !== "na" ? [{ sheet, item, result, key: keyOf(sheet.key, item.id) }] : [];
  })), [inspection]);
  function change(next: Selected[]) { setFindings(next); setAck(false); api.invalidate(); }
  function patch(selected: Selected, update: Partial<Selected>) {
    change(findings.map(entry => keyOf(entry.sheet, entry.item) === keyOf(selected.sheet, selected.item) ? { ...entry, ...update } : entry));
  }
  function mediaFor(report: CustomerReport) {
    const urls: Record<string, string> = {};
    for (const finding of report.findings) {
      const source = inspection.sheets.flatMap(sheet => sheet.sheet.items.map(item => ({sheet, item, key: keyOf(sheet.key, item.id)})))
        .find(entry => entry.key === finding.key);
      if (!source) continue;
      for (const id of finding.photoIds) {
        urls[id] = `/api/shop-dispatch/inspection/media?${new URLSearchParams({ visitId, sheet: source.sheet.key, item: source.item.id, mediaId: id })}`;
      }
    }
    return urls;
  }
  if (api.loading) return <div className={ui.skeleton} role="status" aria-label="Checking customer release availability" />;
  // The release endpoint is the only authority. Technicians receive no release UI.
  if (api.authority && !api.authority.canPublish) return null;
  if (!api.authority) return <section className={ui.panel}><h2>Customer findings release</h2><p className={ui.error} role="alert">{api.error}</p><button onClick={() => void api.reload()}>Retry availability check</button></section>;
  const blocked = api.busy || !!api.pending || !api.storageReady;
  const gateBlocked = blocked || !api.authority.enabled;
  const retryBlocked = api.busy || (!api.authority.enabled && !(api.pending?.type === "link" && (api.pending.action === "revoke" || api.pending.action === "copy")));
  const valid = findings.length > 0 && findings.length <= 120 && findings.every(entry => entry.customerText.trim() && available.some(source => source.key === keyOf(entry.sheet, entry.item) && (source.sheet.active || entry.includeInactive)));
  const customerUrl = api.link?.token && !api.link.revokedAt && new Date(api.link.expiresAt).getTime() > Date.now() ? `${typeof window !== "undefined" ? window.location.origin : ""}/workflow-report#${encodeURIComponent(api.link.token)}` : "";
  const expiryISO = expiry && Number.isFinite(new Date(expiry).getTime()) ? new Date(expiry).toISOString() : undefined;
  const current = api.preview ? api.preview.current : api.authority.current?.report;
  return <section className={ui.panel} aria-label="Customer findings release" data-testid="inspection-release-panel">
    <div className={ui.heading}><div><div className={ui.eyebrow}>Advisor workspace · Explicit customer release</div><h2>Share the findings. Not the internal notes.</h2></div><span>{api.authority.current ? `Published v${api.authority.current.version}` : "Not published"}</span></div>
    <p>Select saved findings and write customer-facing explanations. Active-sheet findings start included; inactive sheets require an explicit opt-in. Internal notes and recommendations are never automatically copied.</p>
    <p className={ui.notice}>Findings only. No repair authorization, vehicle clearance, provider synchronization, or customer delivery is performed here. “Published” and “copied” do not mean “sent.”</p>
    {!api.authority.enabled && <p className={ui.notice}>The release gate is off. Existing published reports remain viewable; valid links can be copied and existing links can be revoked. Preparing, publishing, creating, extending, and replacing are unavailable.</p>}
    {api.error && <p className={ui.error} role="alert">{api.error}</p>}
    {api.notice && <p className={ui.notice} role="status">{api.notice}</p>}
    {api.pending && <div className={ui.notice} role="status"><strong>{api.busy ? "Awaiting server receipt" : "Unconfirmed request retained"} · {api.pending.type}</strong><p>The exact request body and any request ID are retained in this tab’s session storage. Selection and link changes are blocked until the request is resolved.</p><button disabled={retryBlocked} onClick={() => void api.retry()}>Retry exact retained request</button></div>}
    <fieldset disabled={gateBlocked}>
      <legend>Select findings and prepare public copy</legend>
      {!available.length && <div className={ui.empty}><h3>No eligible saved findings</h3><p>Save an evaluated, non-N/A finding in the inspection before preparing a customer release.</p></div>}
      {available.map(({ sheet, item, result, key }) => {
        const selected = findings.find(entry => keyOf(entry.sheet, entry.item) === key);
        return <article className={ui.finding} key={key}>
          <small>{sheet.sheet.name} · v{sheet.sheet.version} · {sheet.active ? "Active sheet" : "Inactive sheet"} · {result.rating}</small>
          <label className={ui.check}><input type="checkbox" checked={!!selected} onChange={event => change(event.target.checked ? [...findings, { sheet: sheet.key, item: item.id, includeInactive: !sheet.active, customerText: "", nextStep: "", photoIds: [], concernIds: [] }] : findings.filter(entry => keyOf(entry.sheet, entry.item) !== key))} /><span><strong>{item.name}{item.position ? ` · ${item.position}` : ""}</strong>{!sheet.active && " · Explicitly include inactive-sheet evidence"}</span></label>
          {selected && <>
            <p><small>Procedure: {item.procedure}. Saved measurements are included with their original units.</small></p>
            {!sheet.active && !selected.includeInactive && <label className={ui.check}><input type="checkbox" checked={selected.includeInactive} onChange={event => patch(selected, { includeInactive: event.target.checked })} />Confirm inclusion of this now-inactive sheet’s finding</label>}
            <div className={ui.fields}><label>Customer explanation · required<textarea rows={3} maxLength={2000} value={selected.customerText} onChange={event => patch(selected, { customerText: event.target.value })} placeholder="Write what the customer should understand." /></label><label>Suggested next step · optional<textarea rows={3} maxLength={2000} value={selected.nextStep} onChange={event => patch(selected, { nextStep: event.target.value })} placeholder="Write a customer-facing next step." /></label></div>
            <strong>Photos · choose individually (up to 6)</strong>
            <div className={ui.photos}>{result.photos.map((photo, index) => <label key={photo.id}><img src={`/api/shop-dispatch/inspection/media?${new URLSearchParams({ visitId, sheet: sheet.key, item: item.id, mediaId: photo.id })}`} alt={`Saved photo ${index + 1} for ${item.name}`} loading="lazy" /><span className={ui.check}><input type="checkbox" checked={selected.photoIds.includes(photo.id)} disabled={!selected.photoIds.includes(photo.id) && selected.photoIds.length >= 6} onChange={event => patch(selected, { photoIds: event.target.checked ? [...selected.photoIds, photo.id] : selected.photoIds.filter(id => id !== photo.id) })} />Include photo {index + 1}</span></label>)}</div>
            {!result.photos.length && <p><small>No saved photos on this finding.</small></p>}
            {!!api.authority?.concerns.length && <fieldset><legend>Explicit concern associations · original words retained</legend>{api.authority.concerns.map(concern => <label className={ui.check} key={concern.id}><input type="checkbox" checked={selected.concernIds.includes(concern.id)} disabled={!selected.concernIds.includes(concern.id) && selected.concernIds.length >= 20} onChange={event => patch(selected, { concernIds: event.target.checked ? [...selected.concernIds, concern.id] : selected.concernIds.filter(id => id !== concern.id) })} /><span className={ui.copy}>{concern.words}</span></label>)}</fieldset>}
          </>}
        </article>;
      })}
      <div className={ui.actions}><button className={ui.primary} disabled={!valid || gateBlocked} onClick={() => { setAck(false); void api.prepare({ findings, acknowledgeExcludedHazards: false }); }}>Prepare customer preview</button><small>{findings.length} selected · changing selection invalidates the preview</small></div>
    </fieldset>
    {(current || api.preview) && <>
      <div className={ui.actions}><strong>Exact customer layout</strong><button aria-pressed={!mobile} onClick={() => setMobile(false)}>Desktop</button><button aria-pressed={mobile} onClick={() => setMobile(true)}>Mobile</button></div>
      <div className={ui.compare}>
        <div><h3>Current published report</h3>{current ? <div style={mobile ? { maxWidth: 390, marginInline: "auto" } : undefined}><CustomerInspectionReport report={current} mediaUrls={mediaFor(current)} version={api.authority.current?.version} /></div> : <p className={ui.empty}>No report has been published.</p>}</div>
        <div><h3>Proposed report · not published</h3>{api.preview ? <div style={mobile ? { maxWidth: 390, marginInline: "auto" } : undefined}><CustomerInspectionReport report={api.preview.report} mediaUrls={mediaFor(api.preview.report)} /></div> : <p className={ui.empty}>Prepare a new preview to compare your selection.</p>}</div>
      </div>
    </>}
    {api.preview && <>
      {api.preview.excludedHazards.length > 0 && <div className={ui.notice}><strong>Urgent findings excluded from this report</strong><ul>{api.preview.excludedHazards.map(hazard => <li key={hazard.key}>{hazard.title}</li>)}</ul><label className={ui.check}><input type="checkbox" disabled={blocked} checked={ack} onChange={event => setAck(event.target.checked)} />I acknowledge these urgent findings will not appear in this release.</label></div>}
      <button className={ui.primary} disabled={gateBlocked || (!!api.preview.excludedHazards.length && !ack)} onClick={() => { if (window.confirm("Publish this exact findings-only preview? This does not send it or authorize repairs.")) void api.publish(ack); }}>Publish this exact preview</button>
    </>}
    {api.authority.current && <section className={ui.finding}><h3>Customer access links</h3><p>Links open the latest published report. Anyone with the link can view it until it expires or is revoked. Tokens are shown only from a confirmed link receipt and are not stored by this interface.</p>
      <label>Expiry for create, replace or extend · optional for create/replace<input type="datetime-local" disabled={gateBlocked} value={expiry} onChange={event => setExpiry(event.target.value)} /></label>
      <div className={ui.actions}><button disabled={gateBlocked || (!!expiry && (!expiryISO || new Date(expiry).getTime() <= Date.now()))} onClick={() => { setCopied(""); void api.changeLink("create", undefined, expiryISO); }}>Create access link</button></div>
      {!api.authority.links.length && <p className={ui.empty}>No access links have been created.</p>}
      {api.authority.links.map(link => <div className={ui.link} key={link.id}><small>{link.revokedAt ? `Revoked ${new Date(link.revokedAt).toLocaleString()}` : `Expires ${new Date(link.expiresAt).toLocaleString()}`}</small><div className={ui.actions}>
        <button disabled={blocked || !!link.revokedAt || !(new Date(link.expiresAt).getTime() > Date.now())} onClick={async () => {
          setCopied("");
          const receipt = await api.changeLink("copy", link.id);
          if (!receipt?.token) return;
          try {
            await navigator.clipboard.writeText(`${window.location.origin}/workflow-report#${encodeURIComponent(receipt.token)}`);
            setCopied("Link copied. It has not been sent or delivered.");
          } catch { setCopied("Copy was unavailable. Select the retrieved URL below and copy it manually."); }
        }}>Copy link</button>
        <button disabled={gateBlocked || !!link.revokedAt || !expiryISO || new Date(expiryISO).getTime() <= Math.max(Date.now(), new Date(link.expiresAt).getTime())} onClick={() => void api.changeLink("extend", link.id, expiryISO)}>Extend to selected expiry</button><button disabled={blocked || !!link.revokedAt} onClick={() => { if (window.confirm("Revoke this access link? Anyone using it will lose access.")) { setCopied(""); void api.changeLink("revoke", link.id); } }}>Revoke</button><button disabled={gateBlocked || (!!expiry && (!expiryISO || new Date(expiry).getTime() <= Date.now()))} onClick={() => { if (window.confirm("Replace this link and invalidate the previous token?")) { setCopied(""); void api.changeLink("replace", link.id, expiryISO); } }}>Replace link</button>
      </div></div>)}
      {customerUrl && <div className={ui.notice}><label>Customer URL · private bearer link<input readOnly value={customerUrl} aria-label="Customer report link" /></label><div className={ui.actions}><button disabled={blocked} onClick={async () => { try { await navigator.clipboard.writeText(customerUrl); setCopied("Link copied. It has not been sent."); } catch { setCopied("Copy was unavailable. Select the URL and copy it manually."); } }}>Copy customer link</button></div>{copied && <p role="status">{copied}</p>}</div>}
    </section>}
  </section>;
}
