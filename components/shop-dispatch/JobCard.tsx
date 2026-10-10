"use client";
import { blockers, elapsed, resourcesFor, type Actor, type Board, type Command, type Job } from "@/lib/shop-dispatch/model";
import { CommandForm } from "./CommandForm";
import { canControl, dateLabel, iso, localDate, minutes, nullableNumber } from "./helpers";
import styles from "./pilot.module.css";

export interface WorkProps { board: Board; actor: Actor; now: number; busy: boolean; mutate: (command: Command, expectedRevision?: number) => Promise<boolean> }
export function JobCard({ job, board, actor, now, busy, mutate }: WorkProps & { job: Job }) {
  const times = elapsed(job, now);
  const blocked = blockers(board, job);
  const closed = board.visits.find(v => v.id === job.visitId)?.closed;
  const controls = canControl(board, job, actor.manager, actor.technicianId);
  const tech = board.technicians.find(t => t.id === job.technicianId);
  const sourceTechnicians = job.sourceTechnicians ?? [];
  const sourceAssignments = sourceTechnicians.map(source => ({
    name: source.name.trim() || "Unnamed Protractor technician",
    matches: source.sourceId ? board.technicians.filter(t => !!t.sourceId && t.sourceId.toLowerCase() === source.sourceId!.toLowerCase() && t.active) : [],
  }));
  const upstreamChoice = sourceAssignments.length === 1 && sourceAssignments[0].matches.length === 1
    ? sourceAssignments[0].matches[0] : null;
  const resources = resourcesFor(board);
  const resource = resources.find(r => r.id === job.resource);
  const resourceOccupied = !!job.resource && board.jobs.some(j => j.id !== job.id && j.resource === job.resource && j.status === "active");
  const resourceUnavailable = !!job.resource && !resource?.active;
  async function start() {
    const current = board.jobs.find(j => j.technicianId === job.technicianId && j.status === "active" && j.id !== job.id);
    if (current && !window.confirm(`Pause “${current.title}” and start “${job.title}”? Waiting time will begin for the paused job.`)) return;
    await mutate({ type: "start", jobId: job.id, pauseCurrent: !!current });
  }
  return <article className={styles.job} data-testid={`job-${job.id}`}>
    <div className={styles.row}><h3>{job.title}</h3><span className={`${styles.chip} ${styles[job.status] || ""}`}>{job.status === "paused" ? "Paused · waiting" : job.status}</span></div>
    <small>Dispatch owner: {tech?.name ?? "Unassigned"} · Planned start {dateLabel(job.plannedStart)}{job.resource && ` · ${resource?.name ?? job.resource}${resourceUnavailable ? " (inactive or unavailable)" : ""}`}</small>
    {(job.sourceId || sourceAssignments.length > 0) && <div data-testid={`protractor-assignment-${job.id}`}>
      <small><strong>Protractor assignment</strong> · read-only</small>
      {sourceAssignments.length === 0 ? <div><small>No technician reported by Protractor.</small></div> :
        sourceAssignments.map((source, index) => <div key={index}><small>{source.name} · {source.matches.length === 1
          ? `Active dispatch roster match: ${source.matches[0].name.trim() || "Unnamed dispatch technician"}`
          : "Roster review needed — no unique active source-ID match"}</small></div>)}
      {sourceAssignments.length > 1 && <div><small>Multiple Protractor technicians. Choose the dispatch owner manually.</small></div>}
    </div>}
    <div className={`${styles.metrics} ${styles.mono}`}>
      <div><small>Actual active work</small><strong>{minutes(times.activeMs)}</strong></div>
      <div><small>Paused waiting</small><strong>{minutes(times.waitingMs)}</strong></div>
      <div><small>Manual estimate</small><strong>{job.estimatedMinutes === null ? "Unknown" : `${job.estimatedMinutes} min`}</strong></div>
      <div><small>Book time {job.sourceId ? "· upstream" : "· entered"}</small><strong>{job.bookMinutes === null ? "Unknown" : `${job.bookMinutes} min`}</strong></div>
    </div>
    {job.pauseReason && <p className={styles.warning}>Waiting: {job.pauseReason}</p>}
    {blocked.length > 0 && <p className={styles.warning}>Blocked: {blocked.join(" · ")}</p>}
    {resourceOccupied && <p className={styles.warning}>{resource?.name ?? "Shared resource"} occupied by another local active session.</p>}
    {resourceUnavailable && job.status !== "completed" && <p className={styles.warning}>This resource is inactive or unavailable. A manager must reassign the job’s resource before starting work.</p>}
    {job.prerequisites.length > 0 && <p><small>Dependencies: {job.prerequisites.map(id => board.jobs.find(j => j.id === id)?.title ?? "Missing job").join(" → ")}</small></p>}
    {controls && <div className={styles.actions}>
      {["idle", "paused"].includes(job.status) && <button data-testid={`start-${job.id}`} className={styles.primary} disabled={busy || !!blocked.length || !tech?.active || resourceOccupied || resourceUnavailable} onClick={() => void start()}>{job.status === "paused" ? "Resume work" : "Start work"}</button>}
      {job.status === "active" && <button data-testid={`complete-${job.id}`} disabled={busy} onClick={() => { if (window.confirm(`Complete “${job.title}”? The session will stop and completed work is locked.`)) void mutate({ type: "complete", jobId: job.id }); }}>Complete job</button>}
    </div>}
    {controls && job.status === "active" && <details><summary>Pause with a reason</summary>
      <CommandForm testId={`pause-form-${job.id}`} busy={busy} label="Pause work" submit={data => mutate({ type: "pause", jobId: job.id, reason: String(data.get("reason")) })}>
        <label>What are we waiting for?<input name="reason" required maxLength={160} placeholder="Parts, approval, another job…" /></label>
      </CommandForm>
    </details>}
    {actor.manager && !closed && <details><summary>Assignment, authorization & plan</summary>
      {job.status === "active" || job.status === "completed" ? <p><small>{job.status === "active" ? "Pause active work before changing its plan." : "Completed plans are locked."}</small></p> :
        <CommandForm revision={board.revision} busy={busy} testId={`plan-form-${job.id}`} label="Save plan" submit={(data, expectedRevision) => mutate({
          type: "plan", jobId: job.id, technicianId: String(data.get("technicianId")) || null,
          plannedStart: iso(data.get("plannedStart")), estimatedMinutes: nullableNumber(data.get("estimatedMinutes")),
          prerequisites: data.getAll("prerequisites").map(String), resource: String(data.get("resource") ?? "") || null,
          authorized: data.get("authorized") === "on",
        }, expectedRevision)}>
          <div className={styles.fields}>
            <label>Active dispatch owner<select name="technicianId" defaultValue={job.technicianId ?? ""}><option value="">Unassigned</option>{board.technicians.filter(t => t.active).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
            <label>Planned work start<input type="datetime-local" name="plannedStart" defaultValue={localDate(job.plannedStart)} /></label>
            <label>Manual planned estimate (minutes)<input type="number" name="estimatedMinutes" min={1} max={1440} step={1} defaultValue={job.estimatedMinutes ?? ""} placeholder="Unknown" /></label>
            <label>Shared resource<select name="resource" defaultValue={job.resource ?? ""}><option value="">None</option>{resources.filter(r => r.active || r.id === job.resource).map(r => <option key={r.id} value={r.id} disabled={!r.active}>{r.name}{r.active ? "" : " · inactive"}</option>)}{job.resource && !resource && <option value={job.resource} disabled>{job.resource} · unavailable</option>}</select></label>
          </div>
          {upstreamChoice && <div className={styles.actions}>
            <button type="button" data-testid={`select-protractor-technician-${job.id}`} onClick={event => {
              const select = event.currentTarget.form?.elements.namedItem("technicianId");
              if (select instanceof HTMLSelectElement) select.value = upstreamChoice.id;
            }}>Select Protractor technician: {upstreamChoice.name.trim() || "Unnamed dispatch technician"}</button>
            <small>Changes this draft only. Save plan to assign the dispatch owner.</small>
          </div>}
          <label className={styles.check}><input type="checkbox" name="authorized" defaultChecked={job.authorized} />Manager authorizes this work</label>
          <div><small>Prerequisites · other jobs on this visit only</small>{board.jobs.filter(j => j.visitId === job.visitId && j.id !== job.id).map(j => <label className={styles.check} key={j.id}><input type="checkbox" name="prerequisites" value={j.id} defaultChecked={job.prerequisites.includes(j.id)} />{j.title} · {j.status}</label>)}</div>
          <small>These are local dispatch assignments, not provider technician assignments or confirmed availability. No learned speed estimates.</small>
        </CommandForm>}
    </details>}
    {actor.manager && !closed && job.status !== "active" && <details><summary>Audited session time correction</summary>
      <CommandForm revision={board.revision} testId={`correct-form-${job.id}`} busy={busy} label="Record correction" submit={(data, expectedRevision) => mutate({ type: "correct", jobId: job.id, activeMinutes: Number(data.get("activeMinutes")), waitingMinutes: Number(data.get("waitingMinutes")), reason: String(data.get("reason")) }, expectedRevision)}>
        <div className={styles.fields}>
          <label>Total active minutes<input required type="number" min={0} max={100000} step="any" name="activeMinutes" defaultValue={Number((times.activeMs / 60000).toFixed(2))} /></label>
          <label>Total waiting minutes<input required type="number" min={0} max={100000} step="any" name="waitingMinutes" defaultValue={Number((times.waitingMs / 60000).toFixed(2))} /></label>
        </div>
        <label>Required audit reason<input required name="reason" maxLength={160} /></label>
        <small>Replaces the accumulated totals, not the estimate. Actor, old totals and reason are recorded in the audit.</small>
      </CommandForm>
    </details>}
  </article>;
}
