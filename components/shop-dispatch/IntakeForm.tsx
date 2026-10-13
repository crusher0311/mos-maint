"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Board } from "@/lib/shop-dispatch/model";
import { intakeDetailsSchema, type IntakeDetails, type WorkflowIntake } from "@/lib/shop-dispatch/intake-types";
import { dateLabel, localDate } from "./helpers";
import { useIntake } from "./use-intake";
import styles from "./pilot.module.css";
import css from "./Intake.module.css";

export type IntakeAppointment = { id: string; title?: string; customer?: string; contactId?: string | null; vehicleId?: string | null; vehicle?: string; concerns?: string[]; mileage?: number | null };
type Props = { board: Board; shopId?: number; busy: boolean; appointment?: IntakeAppointment; visitId?: string; initial?: IntakeDetails; refresh?: () => Promise<void>; select?: (id: string) => void };
const empty = (): IntakeDetails => ({ customer: "", vehicle: "", contactId: null, vehicleId: null, newCustomer: null, newVehicle: null, identityConfirmed: false, concerns: [], mileage: null, customerPlan: "unknown", neededBy: null, promiseAt: null, nextUpdateAt: null, commitmentsConfirmed: false });
export function IntakeForm({ board, shopId, busy, appointment, visitId, initial, refresh, select }: Props) {
  const scope = visitId ? `visit:${visitId}` : appointment ? `appointment:${appointment.id}` : "walk-in";
  const key = `shop-dispatch:intake:${shopId}:draft:${scope}`;
  const [draft, setDraft] = useState<IntakeDetails>(() => initial ?? { ...empty(), customer: appointment?.customer ?? "", vehicle: appointment?.vehicle ?? appointment?.title ?? "", contactId: appointment?.contactId ?? null, vehicleId: appointment?.vehicleId ?? null, concerns: appointment?.concerns ?? [], mileage: appointment?.mileage ?? null });
  const [concerns, setConcerns] = useState(() => draft.concerns.join("\n"));
  const [revision, setRevision] = useState(board.revision);
  const [loaded, setLoaded] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [validation, setValidation] = useState("");
  const [query, setQuery] = useState("");
  const [contacts, setContacts] = useState<{ id: string; name: string }[] | null>(null);
  const [vehicles, setVehicles] = useState<{ id: string; label: string; vin: string; mileage: number | null }[] | null>(null);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupError, setLookupError] = useState("");
  const [completedVisitId, setCompletedVisitId] = useState<string | null>(null);
  const [completedReceipt, setCompletedReceipt] = useState(false);
  const lookupToken = useRef(0);
  const api = useIntake(shopId, scope, refresh);
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(key);
      if (raw) {
        const stored = JSON.parse(raw);
        if (!stored.draft || !Number.isInteger(stored.revision) || typeof stored.concerns !== "string") throw new Error("Invalid draft");
        setDraft(stored.draft); setRevision(stored.revision); setConcerns(stored.concerns); setCompletedVisitId(stored.completedVisitId ?? null); setCompletedReceipt(stored.completedReceipt === true);
      }
      const receipt = sessionStorage.getItem(`shop-dispatch:intake:${shopId}:receipt:${scope}`);
      if (receipt && JSON.parse(receipt).action === "checkIn") {setCompletedReceipt(true);setCompletedVisitId(JSON.parse(receipt).visitId??null);}
      setLoaded(true);
    } catch { setStorageError("Saved draft could not be recovered. Intake is disabled to avoid replacing it."); }
  }, [key, scope, shopId]);
  useEffect(() => {
    if (!loaded) return;
    try { sessionStorage.setItem(key, JSON.stringify({ draft, concerns, revision, completedVisitId, completedReceipt })); }
    catch { setStorageError("Draft storage is unavailable. Nothing will be submitted until it can be preserved."); }
  }, [draft, concerns, revision, key, loaded, completedVisitId, completedReceipt]);
  useEffect(() => {
    if (api.savedScope !== scope || api.savedAction !== "checkIn" || !api.saved) return;
    setCompletedReceipt(true);
    const checkedIn = api.saved.visits.find(v => appointment
      ? (v as typeof v & { intake?: WorkflowIntake }).intake?.appointmentId === appointment.id
      : v.intake?.requestId===api.savedRequestId);
    if (checkedIn) setCompletedVisitId(checkedIn.id);
  }, [api.saved, api.savedScope, api.savedAction, api.savedRequestId,scope, appointment]);
  function change(values: Partial<IntakeDetails>) { setDraft(previous => ({ ...previous, ...values })); }
  function identity(values: Partial<IntakeDetails>) { lookupToken.current++; setLookupBusy(false); change({ ...values, identityConfirmed: false }); }
  async function lookup(kind: "contacts" | "vehicles") {
    const token = ++lookupToken.current;
    setLookupBusy(true); setLookupError("");
    if (kind === "contacts") setContacts(null); else setVehicles(null);
    try {
      const params = kind === "contacts" ? new URLSearchParams({ q: query.trim() }) : new URLSearchParams({ contactId: draft.contactId! });
      const response = await fetch(`/api/shop-dispatch/intake?${params}`, { credentials: "include", cache: "no-store" });
      if (!response.ok) throw new Error(`Identity lookup unavailable (${response.status}). Retry the search.`);
      const data = await response.json();
      if (!Array.isArray(data[kind])) throw new Error("Identity lookup returned an incomplete response.");
      if (token === lookupToken.current) { if (kind === "contacts") setContacts(data.contacts); else setVehicles(data.vehicles); }
    } catch (cause) { if (token === lookupToken.current) setLookupError(cause instanceof Error ? cause.message : "Lookup failed."); }
    finally { if (token === lookupToken.current) setLookupBusy(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setValidation("");
    const parsed = intakeDetailsSchema.safeParse({ ...draft, concerns: concerns.split("\n").map(v => v.trim()).filter(Boolean) });
    if (!parsed.success) { setValidation(parsed.error.issues.map(v => `${v.path.join(".")}: ${v.message}`).join(" · ")); return; }
    const requestId=crypto.randomUUID();
    const next = await api.send({ action: visitId ? "update" : "checkIn", requestId, revision, ...(visitId ? { visitId } : { appointmentId: appointment?.id ?? null }), details: parsed.data });
    if (next) {
      setRevision(next.revision); change(parsed.data);
      if (!visitId) {
        setCompletedReceipt(true);
        const recorded = next.visits.find(v => appointment ? v.intake?.appointmentId === appointment.id : v.intake?.requestId===requestId);
        if (recorded) setCompletedVisitId(recorded.id);
      }
    }
  }
  const returnedVisit = (api.saved ?? board).visits.find(v => v.id === (visitId || completedVisitId));
  const completed = !visitId && (completedReceipt || !!completedVisitId || api.savedScope === scope && api.savedAction === "checkIn");
  const locked = busy || api.busy || !!api.pending || !loaded || !api.ready || !!storageError || completed;
  return <section className={`${styles.panel} ${css.section}`} data-testid={`intake-${scope}`}>
    <div className={styles.eyebrow}>Workflow check-in / {appointment ? "appointment" : visitId ? "visit details" : "walk-in"}</div>
    <h2>{visitId ? "Intake details" : appointment ? appointment.title || "Appointment check-in" : "Check in a walk-in"}</h2>
    <p><small>Records arrival and customer needs locally. Does not authorize repairs, release capacity or confirm an appointment. Upstream ticket creation is a separate, explicitly confirmed action.</small></p>
    {(api.error || validation || storageError) && <div className={styles.error} role="alert">{storageError || validation || api.error}</div>}
    {api.notice && <div className={css.lock} role="status">{api.notice}{returnedVisit && select && <button type="button" onClick={() => select(returnedVisit.id)}>Open checked-in visit</button>}</div>}
    {completedVisitId && !api.notice && <div className={css.lock}>Check-in recorded. {select && <button type="button" onClick={() => select(completedVisitId)}>Open checked-in visit</button>}</div>}
    {completed && !appointment && <button type="button" disabled={busy || api.busy || !!api.pending} onClick={() => {
      if (!window.confirm("Start a different walk-in? The recorded visit stays on the board.")) return;
      if (!api.clearReceipt()) return;
      setCompletedVisitId(null); setCompletedReceipt(false); change(empty()); setConcerns(""); setRevision(api.saved?.revision ?? board.revision);
      setContacts(null); setVehicles(null); setQuery(""); setValidation("");
    }}>Start a different walk-in</button>}
    {api.pending && <div className={styles.notice} role="alert">An intake request for {api.pending.scope} is unconfirmed. Draft editing is paused. Retry sends the exact same request ID, payload and revision.
      <button type="button" disabled={busy || api.busy} onClick={() => void api.send()}>Retry identical intake request</button></div>}
    <form onSubmit={submit} className={css.form}><fieldset disabled={locked}><div className={css.steps}>
      <section><h3><span className={css.number}>01</span> Customer & vehicle identity</h3>
        <div className={styles.fields}>
          <label>Customer display name<input required maxLength={160} value={draft.customer} onChange={e => identity({ customer: e.target.value })} /></label>
          <label>Vehicle display description<input required maxLength={160} value={draft.vehicle} onChange={e => identity({ vehicle: e.target.value })} /></label>
        </div>
        <label>Find an existing customer<input type="search" value={query} onChange={e => { lookupToken.current++; setLookupBusy(false); setContacts(null); setQuery(e.target.value); }} /></label>
        <button type="button" disabled={!query.trim() || lookupBusy} onClick={() => void lookup("contacts")}>Search shop contacts</button>
        {lookupBusy && <div className={styles.skeleton} aria-label="Looking up identities" />}
        {lookupError && <p className={styles.error} role="alert">{lookupError}</p>}
        <div className={css.results}>{contacts?.map(contact => <button type="button" key={contact.id} onClick={() => { identity({ customer: contact.name, contactId: contact.id, newCustomer: null, vehicleId: null, newVehicle: null }); setVehicles(null); }}>{contact.name} · {contact.id}</button>)}{contacts?.length === 0 && <small>No contacts match. Refine your search or enter a new customer.</small>}</div>
        <div className={css.selected}><strong>{draft.contactId ? `Selected contact: ${draft.contactId}` : draft.newCustomer ? "New customer details" : "Customer identity unresolved"}</strong>
          <div className={styles.actions}><button type="button" onClick={() => { identity({ contactId: null, newCustomer: null, vehicleId: null, newVehicle: null }); setVehicles(null); }}>Clear customer identity</button>
          <button type="button" onClick={() => { identity({ contactId: null, vehicleId: null, newCustomer: { firstName: "", lastName: "", phone1: "", email: "" } }); setVehicles(null); }}>Enter new customer</button>
          {draft.contactId && <button type="button" disabled={lookupBusy} onClick={() => void lookup("vehicles")}>Find customer vehicles</button>}</div></div>
        {draft.newCustomer && <div className={styles.fields}>{(["firstName", "lastName", "phone1", "email"] as const).map(field => <label key={field}>{({ firstName: "First name", lastName: "Last name", phone1: "Phone", email: "Email" })[field]}<input type={field === "email" ? "email" : "text"} required={field === "firstName" || field === "lastName"} maxLength={field === "phone1" ? 40 : 160} value={draft.newCustomer![field]} onChange={e => identity({ newCustomer: { ...draft.newCustomer!, [field]: e.target.value } })} /></label>)}</div>}
        <div className={css.results}>{vehicles?.map(vehicle => <button type="button" key={vehicle.id} onClick={() => identity({ vehicle: vehicle.label, vehicleId: vehicle.id, newVehicle: null, mileage: vehicle.mileage })}>{vehicle.label} · VIN {vehicle.vin || "not supplied"} · {vehicle.mileage ?? "unknown"} miles</button>)}{vehicles?.length === 0 && <small>No vehicles returned for this customer. Enter a new vehicle or check in unresolved.</small>}</div>
        <div className={css.selected}><strong>{draft.vehicleId ? `Selected vehicle: ${draft.vehicleId}` : draft.newVehicle ? "New vehicle details" : "Vehicle identity unresolved"}</strong><div className={styles.actions}>
          <button type="button" onClick={() => identity({ vehicleId: null, newVehicle: null })}>Clear vehicle identity</button>
          <button type="button" onClick={() => identity({ vehicleId: null, newVehicle: { vin: "", year: new Date().getFullYear(), make: "", model: "" } })}>Enter new vehicle</button></div></div>
        {draft.newVehicle && <div className={styles.fields}>{(["vin", "year", "make", "model"] as const).map(field => <label key={field}>{field === "vin" ? "VIN · 17 characters" : field}<input required type={field === "year" ? "number" : "text"} min={field === "year" ? 1900 : undefined} max={field === "year" ? 2100 : undefined} maxLength={field === "vin" ? 17 : 160} value={draft.newVehicle![field]} onChange={e => identity({ newVehicle: { ...draft.newVehicle!, [field]: field === "year" ? Number(e.target.value) : field === "vin" ? e.target.value.toUpperCase() : e.target.value } })} /></label>)}</div>}
        <label className={styles.check}><input type="checkbox" disabled={!(draft.contactId || draft.newCustomer) || !(draft.vehicleId || draft.newVehicle)} checked={draft.identityConfirmed} onChange={e => change({ identityConfirmed: e.target.checked })} />I explicitly confirm the selected or new customer and vehicle belong together.</label>
        <small>Missing or unconfirmed identities do not block local check-in. They do block upstream ticket creation.</small>
      </section>
      <section className={css.step}><h3><span className={css.number}>02</span> Concerns & arrival plan</h3>
        <label>Customer concerns · one per line<textarea required rows={4} value={concerns} onChange={e => setConcerns(e.target.value)} placeholder="Describe what the customer wants checked" /></label>
        <div className={styles.fields}><label>Mileage · optional<input type="number" min={0} max={2000000} step={1} value={draft.mileage ?? ""} onChange={e => change({ mileage: e.target.value === "" ? null : Number(e.target.value) })} /></label>
          <label>Customer plan<select value={draft.customerPlan} onChange={e => change({ customerPlan: e.target.value as IntakeDetails["customerPlan"] })}><option value="unknown">Not established</option><option value="waiting">Waiting</option><option value="drop-off">Drop-off</option></select></label></div>
      </section>
      <section className={css.step}><h3><span className={css.number}>03</span> Proposed customer commitments</h3>
        <div className={styles.fields}>{(["neededBy", "promiseAt", "nextUpdateAt"] as const).map(field => <label key={field}>{({ neededBy: "Customer needs vehicle by", promiseAt: "Proposed completion promise", nextUpdateAt: "Proposed next update" })[field]}<input type="datetime-local" value={localDate(draft[field])} onChange={e => change({ [field]: e.target.value ? new Date(e.target.value).toISOString() : null, commitmentsConfirmed: false })} /></label>)}</div>
        <small>These are customer commitments, not confirmed availability. Needed-by is a request, not a promise.</small>
        <label className={styles.check}><input type="checkbox" checked={draft.commitmentsConfirmed} onChange={e => change({ commitmentsConfirmed: e.target.checked })} />I have reviewed and explicitly confirmed these proposed commitments with the customer.</label>
      </section>
      <div className={styles.actions}><button className={styles.primary} type="submit">{api.busy ? "Waiting for confirmation…" : visitId ? "Save intake details" : "Record local check-in"}</button>
        <button type="button" onClick={() => { if (window.confirm("Keep your draft values and use the latest displayed board revision? Review the draft against the latest board before saving.")) setRevision(board.revision); }}>Review latest revision</button><small>Draft revision {revision} · board {board.revision}</small></div>
    </div></fieldset></form>
    {returnedVisit && <p><small>Visit {returnedVisit.id} · arrival {dateLabel(returnedVisit.arrivalAt)}</small></p>}
  </section>;
}
