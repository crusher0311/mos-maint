"use client";
import { useState } from "react";
import { dependencySuggestions, readinessReasons } from "@/lib/shop-dispatch/operations";
import type { Job } from "@/lib/shop-dispatch/model";
import { CommandForm } from "./CommandForm";
import type { WorkProps } from "./JobCard";
import styles from "./pilot.module.css";

function stamp(value: string | null | undefined) {
  return value ? <time dateTime={value}>{value}</time> : "Not recorded";
}
export function blockerAge(openedAt: string, now: number) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(openedAt)) / 60000));
  return minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h`;
}
export function JobReadiness({ board, job, actor, busy, mutate, now }: WorkProps & { job: Job }) {
  const closed = !!board.visits.find(v => v.id === job.visitId)?.closed;
  const locked = closed || job.status === "completed";
  const canWork = !closed && (actor.manager || !!actor.technicianId && actor.technicianId === job.technicianId);
  const operations = job.operations;
  const reasons = readinessReasons(board, job);
  const suggestions = dependencySuggestions(board, job);
  return <details data-testid={`operations-${job.id}`}>
    <summary>Readiness, handoff & final checks · {board.operationsEnabled ? "Gate enabled" : "Gate off · opt-in"}</summary>
    <p><small>{board.operationsEnabled ? "Readiness gates are enforced for this shop." : "Tracking is available. Readiness gates are not enforced until a manager opts in under Operations."}</small></p>
    {closed && <p className={styles.warning}>Closed visit · all operations are read-only.</p>}
    {!closed && job.status === "completed" && <p><small>Completed work · readiness and handoff are locked. Final checks can be marked or reopened until the visit closes.</small></p>}
    <div data-testid={`readiness-reasons-${job.id}`}>
      <strong>{reasons.length ? "Readiness needs attention" : "Readiness reviewed · no outstanding reasons"}</strong>
      {reasons.length > 0 && <ul>{reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}
    </div>
    {operations && <p><small>Reviewed by {operations.reviewedBy} · {stamp(operations.reviewedAt)}<br />Parts: {operations.parts} · Diagnostics: {operations.diagnostics}<br />Required skills: {operations.requiredSkills.length ? operations.requiredSkills.join(", ") : "None specified — verify suitability"}</small></p>}
    {operations?.blockers.map(blocker => <p key={blocker.id}><strong>{blocker.resolved ? "Resolved" : "Open"}: {blocker.reason}</strong><br /><small>Owner: {blocker.owner} · {blockerAge(blocker.openedAt, blocker.resolvedAt ? Date.parse(blocker.resolvedAt) : now)} {blocker.resolved ? "to resolution" : "open"}<br />Opened {stamp(blocker.openedAt)}{blocker.resolvedAt && <> · Resolved {stamp(blocker.resolvedAt)}</>}</small></p>)}
    {actor.manager && !locked && <ReadinessEditor key={job.id} board={board} job={job} busy={busy} mutate={mutate} />}
    <details><summary>Handoff note & acknowledgment</summary>
      {!operations?.handoff ? <p><small>No handoff recorded. Review readiness before saving a handoff.</small></p> : <div>
        <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{operations.handoff.note}</p>
        <small>Saved by {operations.handoff.by} · {stamp(operations.handoff.at)}<br />{operations.handoff.acknowledgedAt ? <>Acknowledged by {operations.handoff.acknowledgedBy} · {stamp(operations.handoff.acknowledgedAt)}</> : "Awaiting acknowledgment"}</small>
      </div>}
      {canWork && !locked && operations && <>
        <CommandForm revision={board.revision} testId={`handoff-form-${job.id}`} busy={busy} label="Save handoff note" submit={(data, revision) => mutate({ type: "handoff", jobId: job.id, note: String(data.get("note")) }, revision)}>
          <label>Handoff note<textarea name="note" required maxLength={1000} rows={3} defaultValue={operations.handoff?.note ?? ""} /></label>
          <small>Saving replaces the note and clears acknowledgment. When operations is enabled, save a fresh unacknowledged note before changing an existing dispatch owner; the new owner acknowledges before starting.</small>
        </CommandForm>
        {operations.handoff && !operations.handoff.acknowledgedAt && <CommandForm revision={board.revision} testId={`acknowledge-form-${job.id}`} busy={busy} label="Acknowledge handoff" submit={(_, revision) => mutate({ type: "acknowledgeHandoff", jobId: job.id }, revision)}>
          <label className={styles.check}><input type="checkbox" required />I have read and understood this handoff.</label>
        </CommandForm>}
      </>}
    </details>
    <details><summary>Final checks · {operations?.checks.filter(c => !!c.completedAt).length ?? 0}/{operations?.checks.length ?? 0}</summary>
      {!operations?.checks.length && <p><small>No final checks configured. A manager can add checks in the readiness form before completion.</small></p>}
      {operations?.checks.map(check => <div key={check.id}>
        <p><strong>{check.label}</strong><br /><small>{check.completedAt ? <>Completed by {check.completedBy} · {stamp(check.completedAt)}</> : "Not yet checked"}</small></p>
        {canWork && <CommandForm revision={board.revision} testId={`quality-form-${job.id}-${check.id}`} busy={busy || !check.completedAt && !["active", "completed"].includes(job.status)} label={check.completedAt ? "Reopen check" : "Mark check complete"} submit={(_, revision) => mutate({ type: "quality", jobId: job.id, checkId: check.id, done: !check.completedAt }, revision)}>
          <small>{check.completedAt ? "Reopening clears the completion record." : ["active", "completed"].includes(job.status) ? "Confirm the actual check was performed." : "Start work before marking this check complete."}</small>
        </CommandForm>}
      </div>)}
    </details>
    {actor.manager && !locked && suggestions.length > 0 && <details><summary>Review suggested dependencies · never applied automatically</summary>
      {suggestions.map(suggestion => {
        const candidate = board.jobs.find(j => j.id === suggestion.jobId);
        return <CommandForm key={suggestion.jobId} revision={board.revision} testId={`dependency-form-${job.id}-${suggestion.jobId}`} busy={busy || job.status === "active" || job.prerequisites.length >= 20} label="Apply confirmed prerequisite" submit={(_, revision) => mutate({
          type: "plan", jobId: job.id, technicianId: job.technicianId, plannedStart: job.plannedStart,
          estimatedMinutes: job.estimatedMinutes, resource: job.resource, authorized: job.authorized,
          prerequisites: [...job.prerequisites, suggestion.jobId],
        }, revision)}>
          <strong>{candidate?.title ?? suggestion.jobId} → {job.title}</strong>
          <small>{suggestion.reason} All other saved plan values are preserved. Pause active work before applying.</small>
          <label className={styles.check}><input type="checkbox" required />I reviewed the actual work and confirm this prerequisite.</label>
        </CommandForm>;
      })}
    </details>}
  </details>;
}

function ReadinessEditor({ board, job, busy, mutate }: Pick<WorkProps, "board" | "busy" | "mutate"> & { job: Job }) {
  const [draft, setDraft] = useState(job.operations);
  const [skills, setSkills] = useState(() => job.operations?.requiredSkills.map(value => ({ id: crypto.randomUUID(), value })) ?? []);
  const [blockers, setBlockers] = useState(() => job.operations?.blockers.map(b => ({ ...b })) ?? []);
  const [checks, setChecks] = useState(() => job.operations?.checks.map(c => ({ id: c.id, label: c.label })) ?? []);
  function reload() {
    setDraft(job.operations);
    setSkills(job.operations?.requiredSkills.map(value => ({ id: crypto.randomUUID(), value })) ?? []);
    setBlockers(job.operations?.blockers.map(b => ({ ...b })) ?? []);
    setChecks(job.operations?.checks.map(c => ({ id: c.id, label: c.label })) ?? []);
  }
  return <details><summary>Manager readiness review</summary>
    <CommandForm revision={board.revision} onReload={reload} testId={`readiness-form-${job.id}`} busy={busy} label="Save readiness review" submit={(data, revision) => mutate({
      type: "readiness", jobId: job.id, readiness: {
        parts: String(data.get("parts")) as NonNullable<Job["operations"]>["parts"],
        diagnostics: String(data.get("diagnostics")) as NonNullable<Job["operations"]>["diagnostics"],
        requiredSkills: skills.map(skill => String(data.get(`skill-${skill.id}`)).trim()),
        blockers: blockers.map(b => ({ id: b.id, reason: String(data.get(`reason-${b.id}`)), owner: String(data.get(`owner-${b.id}`)), resolved: data.get(`resolved-${b.id}`) === "on" })),
        checks: checks.map(c => ({ id: c.id, label: String(data.get(`check-${c.id}`)) })),
      },
    }, revision)}>
      <div className={styles.fields}>
        <label>Parts status<select name="parts" defaultValue={draft?.parts ?? "unknown"}>{["unknown", "not-needed", "ordered", "partial", "received", "incorrect"].map(value => <option key={value}>{value}</option>)}</select></label>
        <label>Diagnostic information<select name="diagnostics" defaultValue={draft?.diagnostics ?? "unknown"}>{["unknown", "needed", "ready", "not-needed"].map(value => <option key={value}>{value}</option>)}</select></label>
      </div>
      <strong>Explicit required skills</strong><small>Use confirmed roster skill keys. No inferred qualifications.</small>
      {!skills.length && <small>No skills required in this draft.</small>}
      {skills.map((skill, index) => <div className={styles.fields} key={skill.id}><label>Required skill {index + 1}<input name={`skill-${skill.id}`} required maxLength={160} defaultValue={skill.value} /></label><button type="button" onClick={() => setSkills(values => values.filter(s => s.id !== skill.id))}>Remove skill {index + 1}</button></div>)}
      <button type="button" disabled={skills.length >= 20} onClick={() => setSkills(values => [...values, { id: crypto.randomUUID(), value: "" }])}>Add required skill</button>
      <strong>Owned blockers</strong>{!blockers.length && <small>No blockers in this draft.</small>}
      {blockers.map((blocker, index) => <div key={blocker.id}>
        <div className={styles.fields}><label>Blocker {index + 1}<input name={`reason-${blocker.id}`} required maxLength={160} defaultValue={blocker.reason} /></label><label>Required owner<input name={`owner-${blocker.id}`} required maxLength={160} defaultValue={blocker.owner} /></label></div>
        <label className={styles.check}><input name={`resolved-${blocker.id}`} type="checkbox" defaultChecked={blocker.resolved} />Resolved</label>
        <button type="button" onClick={() => { if (window.confirm("Remove this blocker from the readiness draft? Save the review to apply.")) setBlockers(values => values.filter(b => b.id !== blocker.id)); }}>Remove blocker {index + 1}</button>
      </div>)}
      <button type="button" disabled={blockers.length >= 20} onClick={() => setBlockers(values => [...values, { id: crypto.randomUUID(), reason: "", owner: "", resolved: false, openedAt: "", resolvedAt: null }])}>Add owned blocker</button>
      <strong>Configurable final checks</strong><small>Editing a check’s label clears its completion when saved.</small>
      {checks.map((check, index) => <div className={styles.fields} key={check.id}><label>Final check {index + 1}<input name={`check-${check.id}`} required maxLength={160} defaultValue={check.label} /></label><button type="button" onClick={() => { if (window.confirm("Remove this final check from the draft? Save the review to apply.")) setChecks(values => values.filter(c => c.id !== check.id)); }}>Remove final check {index + 1}</button></div>)}
      <button type="button" disabled={checks.length >= 20} onClick={() => setChecks(values => [...values, { id: crypto.randomUUID(), label: "" }])}>Add final check</button>
      <small>Additions, removals and resolved statuses are draft changes until you save this review.</small>
    </CommandForm>
  </details>;
}
