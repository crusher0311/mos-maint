"use client";
import { useState } from "react";
import { promiseRisk } from "@/lib/shop-dispatch/operations";
import { recommendNextJobs } from "@/lib/shop-dispatch/operations-scheduling";
import { CommandForm } from "./CommandForm";
import { blockerAge } from "./JobReadiness";
import type { WorkProps } from "./JobCard";
import styles from "./pilot.module.css";

export function OperationsPanel({ board, actor, now, busy, mutate, select }: WorkProps & { select: (visitId: string, jobId?: string) => void }) {
  const [technicianId, setTechnicianId] = useState("");
  if (!actor.manager) return null;
  const open = board.visits.filter(v => !v.closed);
  const queue = board.jobs.flatMap(job => open.some(v => v.id === job.visitId) ? (job.operations?.blockers ?? []).filter(b => !b.resolved).map(blocker => ({ job, blocker })) : [])
    .sort((a, b) => Date.parse(a.blocker.openedAt) - Date.parse(b.blocker.openedAt));
  const recommendations = recommendNextJobs(board, technicianId, now);
  return <section data-testid="operations-panel">
    <div className={styles.panel}>
      <div className={styles.row}><h2>Shop operations</h2><span className={styles.chip}>{board.operationsEnabled ? "Gate enabled" : "Gate off · default"}</span></div>
      <p>Review readiness, put an owner on every hold, and close the loop on handoffs and final checks.</p>
      <CommandForm revision={board.revision} testId="operations-mode-form" busy={busy} label="Save operations mode" submit={(data, revision) => mutate({ type: "operationsMode", enabled: data.get("enabled") === "on" }, revision)}>
        <label className={styles.check}><input name="enabled" type="checkbox" defaultChecked={!!board.operationsEnabled} />Enable operations gates for this shop</label>
        <small>Off by default. Opting in enforces readiness, handoff acknowledgment and quality checks. Review existing work before enabling.</small>
      </CommandForm>
    </div>
    <section className={styles.panel}><h2>Owned blocker queue <small>/ {queue.length}</small></h2>
      {!queue.length ? <div className={styles.empty}><h3>No open owned blockers</h3><p>Readiness reviews on each job keep holds and their responsible owners visible here.</p></div> :
        queue.map(({ job, blocker }) => <div className={styles.job} key={`${job.id}-${blocker.id}`}>
          <div className={styles.row}><strong>{blocker.reason}</strong><span className={`${styles.chip} ${styles.paused}`}>{blockerAge(blocker.openedAt, now)} open</span></div>
          <p>Owner: <strong>{blocker.owner}</strong><br /><small>Opened <time dateTime={blocker.openedAt}>{blocker.openedAt}</time></small></p>
          <button onClick={() => select(job.visitId, job.id)}>RO {open.find(v => v.id === job.visitId)?.ro} · {job.title} · Open job</button>
        </div>)}
    </section>
    <section className={styles.panel}><h2>Customer promise review</h2>
      <p className={styles.warning}><strong>Dependency-only LOWER BOUND — not a full completion forecast.</strong></p>
      <small>Does not account for all technician queues, shifts, appointments, resource contention or operational uncertainty. “No known risk” is not a delivery promise.</small>
      {!open.length && <div className={styles.empty}>No open visits to review.</div>}
      {open.map(visit => {
        const risk = promiseRisk(board, visit.id, now);
        return <div className={styles.job} key={visit.id}>
          <div className={styles.row}><button onClick={() => select(visit.id)}>RO {visit.ro} · {visit.vehicle}</button><span className={`${styles.chip} ${risk.level === "at-risk" ? styles.paused : ""}`}>{risk.level === "at-risk" ? "At risk" : risk.level === "unknown" ? "Unknown" : "No known risk"} · dependency-only LOWER BOUND</span></div>
          <small>Customer promise: {visit.promiseAt ?? "Not set"}<br />Earliest dependency-only finish: {risk.earliestFinish ?? "Unknown"}</small>
          {!!risk.reasons.length && <ul>{risk.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}
        </div>;
      })}
    </section>
    <section className={styles.panel}><h2>Next-job recommendations</h2>
      <label>Active technician<select value={technicianId} onChange={event => setTechnicianId(event.target.value)}><option value="">Choose a technician</option>{board.technicians.filter(t => t.active).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
      <p><small>Suggestions require operations and scheduling enabled, a fresh appointment snapshot, and configured technician shifts. Configure or refresh these in Schedule if suggestions are unavailable. Active sessions, readiness, prerequisites and scheduling constraints can also exclude work.</small></p>
      {!technicianId ? <div className={styles.empty}>Select an active technician to review eligible work.</div> : !recommendations.length ? <div className={styles.empty}><h3>No eligible recommendations</h3><p>{board.operationsEnabled ? "Review schedule setup and refresh the appointment snapshot. Then review shifts, readiness, resource availability and current sessions. No job was assigned." : "Operations gates are off. A manager must explicitly enable them before recommendations are available."}</p></div> :
        recommendations.map(recommendation => {
          const job = board.jobs.find(j => j.id === recommendation.jobId);
          return job ? <div className={styles.job} key={job.id}><h3>{job.title}</h3><small>RO {board.visits.find(v => v.id === job.visitId)?.ro}</small><ul>{recommendation.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul><button onClick={() => select(job.visitId, job.id)}>Review job · no automatic assignment</button></div> : null;
        })}
    </section>
  </section>;
}
