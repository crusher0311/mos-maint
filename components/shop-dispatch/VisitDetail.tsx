"use client";
import type { Transport, Visit } from "@/lib/shop-dispatch/model";
import { CommandForm } from "./CommandForm";
import { JobCard, type WorkProps } from "./JobCard";
import { dateLabel, iso, localDate, nullableNumber, projection } from "./helpers";
import styles from "./pilot.module.css";

export function VisitDetail({ visit, onBack, ...work }: WorkProps & { visit: Visit; onBack: () => void }) {
  const { board, actor, busy, mutate, now } = work;
  const jobs = board.jobs.filter(j => j.visitId === visit.id);
  const unresolved = ["needed", "arranged"].includes(visit.transport.ride) || ["requested", "assigned"].includes(visit.transport.loaner);
  const canClose = jobs.every(j => j.status === "completed") && !unresolved;
  return <section data-testid="pilot-visit-detail">
    <div className={styles.row}><button onClick={onBack}>← Back to dispatch</button><span className={styles.chip}>{visit.closed ? "Closed · history" : "Open visit"} · {visit.provider === "manual" ? "Manual intake" : "Protractor intake"}</span></div>
    <div className={styles.panel} style={{ marginTop: 16 }}>
      <div className={styles.row}><div><div className={styles.eyebrow}>Repair order {visit.ro}</div><h1>{visit.vehicle}</h1><p>{visit.customer || "Customer not supplied"}</p></div>
        {actor.manager && !visit.closed && <button disabled={busy || !canClose} data-testid="close-visit" onClick={() => { if (window.confirm("Close this visit? Its jobs and transport history will remain viewable, but changes will be locked.")) void mutate({ type: "close", visitId: visit.id }); }}>Close visit</button>}
      </div>
      <div className={styles.metrics}>
        <div><small>Arrival</small><strong>{dateLabel(visit.arrivalAt)}</strong></div>
        <div><small>Work starts</small><strong>{jobs.some(j => j.plannedStart) ? dateLabel(jobs.filter(j => j.plannedStart).sort((a, b) => Date.parse(a.plannedStart!) - Date.parse(b.plannedStart!))[0].plannedStart) : "Not planned"}</strong></div>
        <div><small>Customer promise</small><strong>{dateLabel(visit.promiseAt)}</strong></div>
      </div>
      <p>{projection(board, visit, now)}</p><small>Limited serial projection from manual estimates only. Does not optimize scheduling, account for other visits, rack contention, unknown parts delays or technician availability. Book time is not a promise estimate.</small>
      {actor.manager && !visit.closed && !canClose && <p><small>To close: complete every job, finish arranged rides, and resolve requested or assigned loaners.</small></p>}
      {visit.provider === "protractor" && <div className={styles.notice}>
        Upstream status: {visit.sourceStatus || "Not supplied"} · Fetched {dateLabel(visit.sourceFetchedAt)}<br />
        Imported jobs require manager authorization. Removed packages are blocked for review. Upstream status never silently completes local work. No upstream writebacks.
        {actor.manager && !visit.closed && visit.sourceId && <div className={styles.actions}><button disabled={busy} onClick={() => void mutate({ type: "sync", workOrderId: visit.sourceId! })}>Refresh this work order</button></div>}
      </div>}
    </div>
    <div className={styles.grid}><section>
      <h2>Individual jobs <small> / {jobs.length}</small></h2>
      {!jobs.length && <div className={styles.empty}>No jobs on this visit yet. Managers can add work below.</div>}
      {jobs.map(job => <JobCard key={job.id} job={job} {...work} />)}
      {actor.manager && !visit.closed && <div className={styles.panel} style={{ marginTop: 18 }}><h3>Add a manual job</h3>
        <CommandForm testId="job-create-form" label="Create job" reset creation busy={busy} submit={data => mutate({ type: "job", id: String(data.get("creationId")), visitId: visit.id, title: String(data.get("title")), bookMinutes: nullableNumber(data.get("bookMinutes")) })}>
          <label>Job title<input required name="title" maxLength={160} /></label>
          <label>Entered book minutes · optional<input name="bookMinutes" type="number" min={0} max={10000} step="any" /></label>
        </CommandForm>
      </div>}
    </section><aside className={styles.panel}><h2>Customer & transport</h2>
      <div className={styles.actions}><span className={styles.chip}>{visit.transport.customerPlan}</span><span className={styles.chip}>Ride · {visit.transport.ride}</span><span className={styles.chip}>Loaner · {visit.transport.loaner}</span></div>
      <p><small>Loaner ID: {visit.transport.loanerId || "Not assigned"}<br />Pickup: {dateLabel(visit.transport.pickupAt)}<br />{visit.transport.notes || "No transport notes"}</small></p>
      {actor.manager && !visit.closed && <CommandForm revision={board.revision} testId="transport-form" busy={busy} label="Save customer plan" submit={(data, expectedRevision) => mutate({
        type: "transport", visitId: visit.id, arrivalAt: iso(data.get("arrivalAt")), promiseAt: iso(data.get("promiseAt")),
        transport: { customerPlan: String(data.get("customerPlan")) as Transport["customerPlan"], ride: String(data.get("ride")) as Transport["ride"], loaner: String(data.get("loaner")) as Transport["loaner"], loanerId: String(data.get("loanerId")), pickupAt: iso(data.get("pickupAt")), notes: String(data.get("notes")) },
      }, expectedRevision)}>
        <label>Arrival<input name="arrivalAt" type="datetime-local" defaultValue={localDate(visit.arrivalAt)} /></label>
        <label>Promise · separate from work start<input name="promiseAt" type="datetime-local" defaultValue={localDate(visit.promiseAt)} /></label>
        <label>Customer plan<select name="customerPlan" defaultValue={visit.transport.customerPlan}>{["unknown", "waiting", "drop-off", "returning"].map(v => <option key={v}>{v}</option>)}</select></label>
        <div className={styles.fields}>
          <label>Ride<select name="ride" defaultValue={visit.transport.ride}>{["none", "needed", "arranged", "completed"].map(v => <option key={v}>{v}</option>)}</select></label>
          <label>Loaner<select name="loaner" defaultValue={visit.transport.loaner}>{["none", "requested", "assigned", "returned"].map(v => <option key={v}>{v}</option>)}</select></label>
        </div>
        <label>Loaner identifier · required when assigned<input name="loanerId" maxLength={60} defaultValue={visit.transport.loanerId} /></label>
        <label>Pickup time<input name="pickupAt" type="datetime-local" defaultValue={localDate(visit.transport.pickupAt)} /></label>
        <label>Transport notes<textarea name="notes" maxLength={500} defaultValue={visit.transport.notes} rows={3} /></label>
      </CommandForm>}
    </aside></div>
  </section>;
}
