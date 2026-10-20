"use client";
import { usePilotInspection } from "./use-pilot-inspection";
import styles from "./pilot.module.css";
import css from "./PilotInspectionPanel.module.css";

const states = {
  preview: "Frozen preview · not sent",
  admitted: "Admitted · outcome not yet confirmed",
  pending: "Pending · do not resend",
  partial: "Partial readback · do not resend",
  conflict: "Conflict · stop and review",
  confirmed: "Confirmed · exact readback",
};
export function PilotInspectionPanel({ visitId, shopId, blocked, evidenceRevision }: {
  visitId: string; shopId?: number; blocked: boolean; evidenceRevision: number;
}) {
  const api = usePilotInspection(visitId, shopId, evidenceRevision, blocked);
  const data = api.data;
  if (api.loading) return <div className={styles.skeleton} role="status" aria-label="Loading synthetic inspection pilot" />;
  if (data && !data.enabled && !data.operation) return null;
  if (!data) return shopId === 66 ? <section className={css.unavailable} aria-label="Synthetic pilot availability">
    <h3>Synthetic DVI test</h3><p className={styles.notice}>Unavailable for this visit. The pilot requires an initialized inspection and the approved synthetic vehicle.</p>
    <p role="status"><small>{api.error}</small></p><button type="button" disabled={api.busy} onClick={() => void api.load()}>Check pilot availability</button>
  </section> : null;
  const operation = data.operation;
  const locked = blocked || api.busy || !!api.storageError || !!api.error || api.uncertain || api.admitted || !data.enabled || !data.canSend;
  const validPreview = operation?.state === "preview" && api.previewId === operation.id && operation.evidenceRevision === data.evidenceRevision && data.evidenceRevision === evidenceRevision;
  const labelSource = typeof data.labelEvidence === "string" ? data.labelEvidence
    : data.labelEvidence && typeof data.labelEvidence === "object" && "source" in data.labelEvidence && typeof data.labelEvidence.source === "string" ? data.labelEvidence.source : null;
  return <section className={css.panel} aria-label="Synthetic saved findings pilot" data-testid="pilot-inspection-panel">
    <div className={css.heading}><div><div className={styles.eyebrow}>CAR Experts · synthetic test only</div><h3>Send saved inspection findings</h3></div><span className={styles.chip}>{operation ? states[operation.state] : "Not sent"}</span></div>
    <p>This pilot writes selected saved findings to the approved synthetic work order only. No photos, pricing, customer publication, or automatic ticket creation.</p>
    <p className={styles.notice}><strong>Test data only. Not for a real customer vehicle.</strong><br />Native label evidence is not independently verified{labelSource ? ` · source: ${labelSource}` : ""}. A synthetic round trip does not certify provider behavior.</p>
    {data.warning && <p className={styles.notice}>{data.warning}</p>}
    {blocked && <p className={styles.notice}>Pilot writes are paused. Save or discard inspection drafts and resolve any pending request or conflict. Read-only visits cannot send.</p>}
    {!data.canSend && !api.admitted && <p><small>Sending is not currently authorized or available for this visit.</small></p>}
    {api.storageError && <p className={styles.error} role="alert">{api.storageError}</p>}
    {api.error && <p className={styles.error} role="alert">{api.error}</p>}
    {api.uncertain && <div className={styles.notice} role="status"><strong>Pending · do not resend</strong><p>The response is unconfirmed. Request IDs are retained, not evidence. Use status or reconciliation only; no automatic retry occurs.</p></div>}
    {!api.admitted && !api.uncertain && <>
      <fieldset className={css.candidates} disabled={locked}><legend>1. Choose saved findings</legend>
        {(data.candidates ?? []).map(candidate => <label className={css.candidate} key={JSON.stringify([candidate.sheet, candidate.item])}>
          <input type="checkbox" checked={api.selected.some(entry => entry.sheet === candidate.sheet && entry.item === candidate.item)} onChange={() => api.toggle(candidate.sheet, candidate.item)} />
          <span>{candidate.name}<small>{candidate.rating ?? "Not evaluated"} · {candidate.sheet} / {candidate.item}</small></span>
        </label>)}
      </fieldset>
      {!data.candidates?.length && <div className={styles.empty}><strong>No saved findings available</strong><p>Save eligible inspection evidence before preparing a preview.</p></div>}
      <button type="button" disabled={locked || !api.selected.length || data.evidenceRevision !== evidenceRevision} onClick={() => void api.write("preview")}>Preview selected saved findings</button>
      {operation?.state === "preview" && !validPreview && <p><small>Previous preview is not approved for sending. Selection or inspection state changed; create a new explicit preview.</small></p>}
    </>}
    {operation && (operation.state !== "preview" || validPreview) && <div className={css.operation}>
      <h4>{states[operation.state]}</h4>
      <div className={css.metadata}><small>Operation {operation.id}</small><small>Work order {operation.workOrderGuid}</small><small>Evidence {operation.evidenceRevision}</small>
        {operation.observedAt && <small>Observed {new Date(operation.observedAt).toLocaleString()}</small>}</div>
      {operation.warning && <p className={styles.notice}>{operation.warning}</p>}
      <ul className={css.lines}>{operation.lines.map(line => <li key={line.key}><strong>{line.title}</strong><p>{line.result}</p>{line.notes && <p>{line.notes}</p>}</li>)}</ul>
      {operation.state === "preview" && <div className={css.confirm}><h4>2. Review risk, then confirm separately</h4>
        <label className={styles.check}><input type="checkbox" checked={api.acknowledged} disabled={locked || !validPreview} onChange={event => api.setAcknowledged(event.target.checked)} />
          I reviewed this frozen preview. I understand this writes synthetic saved findings to the external work order, native labels are not independently verified, and a partial or uncertain outcome must not be resent.</label>
        <div><button type="button" className={styles.primary} disabled={locked || !validPreview || !api.acknowledged} onClick={() => {
          if (window.confirm("Send these frozen saved findings to the approved synthetic work order? This is an external write. Do not resend if the outcome is uncertain.")) void api.write("send");
        }}>Send saved findings</button></div>
      </div>}
      {operation.state === "confirmed" && <p role="status">Selected findings matched exact readback. This is not provider certification and does not independently verify native labels.</p>}
      {operation.state === "partial" && <p className={styles.notice}>Only part of the expected evidence was observed. No resend or replacement is available. Check status or reconcile the existing operation.</p>}
      {operation.state === "conflict" && <p className={styles.error}>Readback conflicts with the frozen findings. Stop and review with an authorized operator. Do not send replacements.</p>}
      {(operation.state === "pending" || operation.state === "admitted") && <p className={styles.notice}>The operation has been admitted but exact readback is not confirmed. Do not resend.</p>}
    </div>}
    <div className={styles.actions} style={{ marginTop: 16 }}>
      <button type="button" disabled={api.busy} onClick={() => void api.load()}>Check pilot status</button>
      {(api.admitted || api.uncertain) && <button type="button" disabled={api.busy} onClick={() => void api.write("reconcile")}>Reconcile existing operation</button>}
    </div>
    <small>No resend or replacement after admission. Reloading discovers the existing server operation; it never sends findings.</small>
  </section>;
}
