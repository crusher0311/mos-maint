"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Board, Visit } from "@/lib/shop-dispatch/model";
import type { TicketIntent, WorkflowIntake } from "@/lib/shop-dispatch/intake-types";
import { IntakeForm } from "./IntakeForm";
import { useIntake } from "./use-intake";
import { DviEntry } from "./DviEntry";
import NewWorkOrderModal from "../NewWorkOrderModal";
import { dateLabel } from "./helpers";
import styles from "./pilot.module.css";
import css from "./Intake.module.css";

export function VisitIntake({ visit, board, shopId, manager, busy, refresh, onLockChange, onOpenInspection }: { visit: Visit; board: Board; shopId?: number; manager: boolean; busy: boolean; refresh?: () => Promise<void>; onLockChange?: (locked: boolean) => void; onOpenInspection?: () => void }) {
  const api = useIntake(shopId, `tickets:${visit.id}`, refresh);
  const [detailsLocked, setDetailsLocked] = useState(false);
  const requestLocked = detailsLocked || api.busy || !!api.pending;
  const lockCallback = useRef(onLockChange);
  lockCallback.current = onLockChange;
  useEffect(() => {
    lockCallback.current?.(requestLocked);
    return () => lockCallback.current?.(false);
  }, [requestLocked]);
  const current = api.saved && api.saved.revision >= board.revision ? api.saved : board;
  const latest = current.visits.find(v => v.id === visit.id) ?? visit;
  const intake = (latest as Visit & { intake?: WorkflowIntake }).intake;
  const intents = ((current as Board & { ticketIntents?: TicketIntent[] }).ticketIntents ?? []).filter(v => v.visitId === visit.id);
  const hasIntent = intents.length > 0;
  const [roNumber, setRoNumber] = useState("");
  const [confirmedLink, setConfirmedLink] = useState(false);
  const [ticketPreview,setTicketPreview]=useState<{sourceId:string;ro:string;customer:string;vehicle:string;sourceStatus:string}|null>(null);
  const [previewError,setPreviewError]=useState("");
  const [previewBusy,setPreviewBusy]=useState(false);
  const [showNewRO, setShowNewRO] = useState(false);
  const [revision, setRevision] = useState(board.revision);
  const [storageReady, setStorageReady] = useState(false);
  const [storageError, setStorageError] = useState("");
  const key = `shop-dispatch:intake:${shopId}:draft:tickets:${visit.id}`;
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(key);
      if (raw) { const value = JSON.parse(raw); setRoNumber(value.roNumber ?? ""); setConfirmedLink(value.confirmedLink === true); setRevision(value.revision); }
      setStorageReady(true);
    } catch { setStorageError("Ticket draft could not be recovered. Actions disabled to protect the original request."); }
  }, [key]);
  useEffect(() => {
    if (!storageReady) return;
    try { sessionStorage.setItem(key, JSON.stringify({ roNumber, confirmedLink, revision })); }
    catch { setStorageError("Ticket draft cannot be preserved. Actions disabled."); }
  }, [key, storageReady, roNumber, confirmedLink, revision]);
  const locked = busy || detailsLocked || api.busy || !!api.pending || !api.ready || !storageReady || !!storageError;
  async function link(event: FormEvent) {
    event.preventDefault();
    if(!ticketPreview||!confirmedLink)return;
    const result = await api.send({ action: "link", visitId: visit.id, requestId: crypto.randomUUID(), revision, roNumber, expectedSourceId:ticketPreview.sourceId, confirmed: true });
    if (result) setRevision(result.revision);
  }
  return <section>
    <div className={styles.panel}><div className={styles.eyebrow}>Workflow intake record</div><h2>Arrival & customer needs</h2>
      {intake ? <><small>Checked in {dateLabel(intake.checkedInAt)} by {intake.checkedInBy}{intake.appointmentId ? ` · appointment ${intake.appointmentId}` : " · walk-in"}</small>
        <div className={css.summary}><div><small>Customer</small><strong>{intake.details.customer}</strong><small>{intake.details.contactId || (intake.details.newCustomer ? "New customer supplied" : "Identity missing")}</small></div>
          <div><small>Vehicle</small><strong>{intake.details.vehicle}</strong><small>{intake.details.vehicleId || (intake.details.newVehicle ? "New vehicle supplied" : "Identity missing")}</small></div>
          <div><small>Mileage / plan</small><strong>{intake.details.mileage ?? "Not supplied"} · {intake.details.customerPlan}</strong></div>
          <div><small>Identity confirmation</small><strong>{intake.details.identityConfirmed ? "Explicitly confirmed" : "Not confirmed"}</strong></div>
          <div><small>Needed by</small><strong>{dateLabel(intake.details.neededBy)}</strong></div>
          <div><small>Promise / next update</small><strong>{dateLabel(intake.details.promiseAt)} / {dateLabel(intake.details.nextUpdateAt)}</strong><small>{intake.details.commitmentsConfirmed ? "Customer commitments confirmed" : "Commitments not confirmed"}</small></div></div>
        <h3>Recorded concerns</h3><ul>{intake.details.concerns.map((concern, index) => <li key={index}>{concern}</li>)}</ul></> : <div className={styles.empty}>No workflow intake record. Existing imported work and local dispatch remain unchanged.</div>}
      {manager && !visit.closed && <details><summary>{intake ? "Review or update intake details" : "Record intake details"}</summary><IntakeForm board={current} shopId={shopId} busy={busy || api.busy || !!api.pending} visitId={visit.id} initial={intake?.details ?? undefined} refresh={refresh} onLockChange={setDetailsLocked} /></details>}
    </div>
    <section className={styles.panel} data-testid="visit-ticket-actions"><div className={styles.eyebrow}>Controlled upstream action</div><h2>Repair order / ticket</h2>
      <p><small>Linking verifies an existing upstream RO. Creation can write a new customer, vehicle and work order upstream; it does not authorize repairs or assign work. General upstream writeback is not available.</small></p>
      {intents.map(intent => <article className={css.lock} key={intent.id} data-testid={`ticket-intent-${intent.id}`}><strong>{intent.status === "confirmed" ? "Confirmed ticket" : intent.status === "uncertain" ? "Ticket outcome uncertain" : "Ticket pending verification"}</strong><p>{intent.message}</p><small>{dateLabel(intent.createdAt)} · attempted stages: {intent.attempted.join(", ") || "none recorded"}{intent.workOrderId ? ` · work order ${intent.workOrderId}` : ""}</small></article>)}
      {latest.sourceId && <p>Linked upstream work order: <strong>{latest.sourceId}</strong> · RO {latest.ro}</p>}
      {latest.sourceId && onOpenInspection && <div className={styles.actions}><small>Ticket linked. Continue into the saved inspection workspace; findings are never sent automatically.</small><DviEntry key={latest.sourceId} visitId={visit.id} shopId={shopId} closed={latest.closed} busy={locked} onOpen={onOpenInspection} /></div>}
      {(api.error || storageError) && <div className={styles.error} role="alert">{storageError || api.error}</div>}
      {api.notice && <p role="status">{api.notice}</p>}
      {api.pending && <div className={styles.notice} role="alert">An intake request ({api.pending.scope}) has an unconfirmed outcome. Do not submit a new ticket action.<button disabled={busy || api.busy} onClick={() => void api.send()}>Retry identical request</button></div>}
      {manager && !visit.closed && <>
        {hasIntent && <div className={styles.notice}><p>Verification only: reconcile checks the recorded attempt. It never replays attempted customer, vehicle or work-order writes. If verification cannot establish success, a manager must investigate upstream; another creation is not offered.</p>
          <button disabled={locked || intents.every(v => v.status === "confirmed")} onClick={() => void api.send({ action: "reconcile", visitId: visit.id })}>Retry verification only</button></div>}
        {!latest.sourceId && !hasIntent && <><form onSubmit={link} className={css.form}><fieldset disabled={locked}><h3>Link an existing ticket</h3>
          <label>Existing upstream RO number<input disabled={previewBusy} required inputMode="numeric" pattern="[0-9]{1,15}" maxLength={15} value={roNumber} onChange={e => { setRoNumber(e.target.value); setConfirmedLink(false); setTicketPreview(null); }} /></label>
          <button type="button" disabled={previewBusy||!/^\d{1,15}$/.test(roNumber)} onClick={async()=>{
            setPreviewBusy(true);setPreviewError("");setConfirmedLink(false);setTicketPreview(null);
            try{
              const response=await fetch(`/api/shop-dispatch/intake?roNumber=${encodeURIComponent(roNumber)}`,{credentials:"include",cache:"no-store"});
              const value=await response.json();
              if(!response.ok||!value.ticket)throw new Error(value.error||"Ticket could not be verified.");
              setTicketPreview(value.ticket);
            }catch(error){setPreviewError(error instanceof Error?error.message:"Ticket lookup failed.");}
            finally{setPreviewBusy(false);}
          }}>Look up official ticket</button>
          {previewError&&<p role="alert">{previewError}</p>}
          {ticketPreview&&<p>Verified RO {ticketPreview.ro} · {ticketPreview.customer||"Customer not supplied"} · {ticketPreview.vehicle} · {ticketPreview.sourceStatus}</p>}
          <label className={styles.check}><input disabled={!ticketPreview} type="checkbox" checked={confirmedLink&&!!ticketPreview} onChange={e => setConfirmedLink(e.target.checked)} />I confirm the displayed customer, vehicle and RO belong to this visit. Resolve any differing intake identity before linking.</label>
          <button type="submit" disabled={!confirmedLink||!ticketPreview||previewBusy}>Verify & link existing ticket</button></fieldset></form>
          <div className={css.step}><h3>Create a new upstream ticket</h3>
            <p><small>Use the same guided repair-order form as the dashboard. Local intake is not sent as a second creation request. After creation, explicitly look up and link the official number above if you want to attach it to this local visit; DVI handoff opens the confirmed imported visit.</small></p>
            <button disabled={locked} onClick={() => setShowNewRO(true)}>Create New RO</button>
          </div></>}
        <button disabled={locked} onClick={() => { if (window.confirm("Review the ticket action draft against the latest displayed board and use its revision?")) { setRevision(current.revision); setConfirmedLink(false); } }}>Review latest ticket revision</button><small>Draft revision {revision} · board {current.revision}</small>
      </>}
    </section>
    <NewWorkOrderModal isOpen={showNewRO} onClose={() => setShowNewRO(false)} onCreated={number => {
      setRoNumber(String(number)); setConfirmedLink(false); setTicketPreview(null); void refresh?.();
    }} />
  </section>;
}
