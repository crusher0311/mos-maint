"use client";
import { useRef, useState } from "react";
import { z } from "zod";
import type { TechnicianSkill } from "@/lib/shop-dispatch/model";
import { CommandForm } from "./CommandForm";
import type { WorkProps } from "./JobCard";
import styles from "./pilot.module.css";

const historySchema = z.object({
  truncated: z.boolean(),
  profiles: z.array(z.object({
    technicianId: z.string(), sourceId: z.string().nullable(),
    skills: z.array(z.object({
      key: z.string(), title: z.string(), count: z.number().int().nonnegative(),
      lastCompletedAt: z.string().nullable(), sharedJobCount: z.number().int().nonnegative(),
      evidence: z.array(z.object({
        ro: z.string(), title: z.string(), completedAt: z.string().nullable(), shared: z.boolean(),
      })),
    })),
  })),
});
type History = z.infer<typeof historySchema>;
type HistoricalSkill = History["profiles"][number]["skills"][number];
type SkillProps = Pick<WorkProps, "board" | "actor" | "busy" | "mutate">;

function date(value: string | null) {
  if (!value) return "Unknown";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Unknown" : parsed.toLocaleDateString();
}
function normalizedTitle(value: string) { return value.trim().replace(/\s+/g, " "); }

export function TechnicianSkills({ board, actor, busy, mutate }: SkillProps) {
  const [history, setHistory] = useState<History | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [limits, setLimits] = useState<Record<string, number>>({});
  const inFlight = useRef(false);
  async function load() {
    if (!actor.manager || inFlight.current) return;
    inFlight.current = true;
    setLoading(true); setError(""); setHistory(null);
    try {
      // Explicit manager request only: no mount fetch, polling or upstream writes.
      const response = await fetch("/api/shop-dispatch/skills", { credentials: "include", cache: "no-store" });
      const data: unknown = await response.json();
      if (!response.ok) {
        const message = data && typeof data === "object" && "error" in data && typeof data.error === "string"
          ? data.error : "Skill history could not be loaded. Try again.";
        throw new Error(message);
      }
      const parsed = historySchema.safeParse(data);
      if (!parsed.success) throw new Error("Skill history response was invalid. Try loading again.");
      setHistory(parsed.data);
      setLimits({});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Skill history could not be loaded. Try again.");
    } finally { inFlight.current = false; setLoading(false); }
  }
  if (!actor.manager) return null;
  return <section className={styles.panel} data-testid="technician-skills">
    <div className={styles.eyebrow}>Manager assessments · separate from history</div>
    <h2>Technician skill profiles</h2>
    <p><small>Assessments are local manager decisions, not inferred qualifications. No MOS login is required.
      Historical suggestions use archived invoiced work, excluding credits, and group normalized exact service titles only; they do not infer related skills or independent capability.
      History dates reflect the invoice archive event, not a verified task completion time.
      Multi-technician jobs may credit several technicians and do not establish who performed each task.</small></p>
    <button type="button" data-testid="skills-load" disabled={busy || loading || !board.technicians.length} onClick={() => void load()}>
      {loading ? "Loading skill history…" : error ? "Retry loading skill history" : history ? "Reload skill history" : "Load skill history"}
    </button>
    {loading && <div className={styles.skeleton} role="status" aria-label="Loading skill history" />}
    {error && <p className={styles.notice} role="alert">{error} Manual skills and saved assessments remain available.</p>}
    {!history && !loading && !error && <p><small>History has not been loaded. Saved assessments and manual skills are available below.</small></p>}
    {history?.truncated && <p className={styles.notice} role="status">This history response is truncated. Counts and evidence may be incomplete; missing history is not evidence of missing skill.</p>}
    {!!board.technicians.length && <label className={styles.form}>Search skill titles
      <input type="search" data-testid="skills-search" placeholder="Filter saved assessments and historical titles"
        value={search} onInput={event => { setSearch(event.currentTarget.value); setLimits({}); }} />
      <small>Filters loaded titles only, not qualifications. Showing up to 25 titles per section for each technician; use Show more to review additional matches.</small>
    </label>}
    {!board.technicians.length && <div className={styles.empty}>No local technicians yet. Add a technician to the roster above before assessing skills.</div>}
    {board.technicians.map(technician => {
      // Optional field is also compatible with boards saved before skill profiles existed.
      const assessments = technician.skills ?? [];
      const skills = history?.profiles.find(profile => profile.technicianId === technician.id)?.skills ?? [];
      const query = normalizedTitle(search).toLowerCase();
      const matches = (skill: { title: string; key: string }) =>
        skill.title.toLowerCase().includes(query) || skill.key.toLowerCase().includes(query);
      const matchingAssessments = assessments.filter(matches);
      const matchingSkills = skills.filter(matches);
      const limit = limits[technician.id] ?? 25;
      const canShowMore = matchingAssessments.length > limit || matchingSkills.length > limit;
      return <details key={technician.id} data-testid={`skills-technician-${technician.id}`}>
        <summary>{technician.name} · {technician.active ? "Active" : "Inactive"} · {assessments.length} manager assessments{history && ` · ${skills.length} historical titles`}</summary>
        <h3>Saved manager assessments</h3>
        {!assessments.length && <div className={styles.empty}>No manager assessments yet. Add a manual skill or review a historical suggestion.</div>}
        {!!assessments.length && <p><small>Showing {Math.min(limit, matchingAssessments.length)} of {matchingAssessments.length} matching assessments ({assessments.length} total).</small></p>}
        {!!assessments.length && !matchingAssessments.length && <div className={styles.empty}>No saved assessments match this search.</div>}
        {matchingAssessments.slice(0, limit).map(assessment => <div className={styles.reviewEntry} key={assessment.key}>
          <div className={styles.row}><strong>{assessment.title}</strong><span className={styles.chip}>{assessment.status === "confirmed" ? "Manager confirmed" : "Not qualified"}</span></div>
          <p><small>Reviewed {date(assessment.reviewedAt)} · {assessment.reviewedBy || "Reviewer unavailable"}</small></p>
          {assessment.notes && <p>{assessment.notes}</p>}
          <details><summary>Edit or remove assessment</summary>
            <SkillForm board={board} busy={busy} mutate={mutate} technicianId={technician.id} skill={assessment} assessment />
          </details>
        </div>)}
        <details><summary>Add a manual skill</summary>
          <SkillForm board={board} busy={busy} mutate={mutate} technicianId={technician.id} />
        </details>
        <h3>Historical evidence · not a qualification</h3>
        {!history && <p><small>{loading ? "Loading history. Assessments above remain available." : "Load history explicitly to review service-title suggestions."}</small></p>}
        {history && !skills.length && <div className={styles.empty}>No historical service titles returned for this technician. You can still add a manual assessment.</div>}
        {!!skills.length && <p><small data-testid={`skills-count-${technician.id}`}>Showing {Math.min(limit, matchingSkills.length)} of {matchingSkills.length} matching historical titles ({skills.length} total).</small></p>}
        {!!skills.length && !matchingSkills.length && <div className={styles.empty}>No historical titles match this search.</div>}
        {matchingSkills.slice(0, limit).map(skill => <div className={styles.reviewEntry} key={skill.key}>
          <strong>{skill.title}</strong>
          <p><small>{skill.count} invoiced jobs · Last invoiced {date(skill.lastCompletedAt)} · {skill.sharedJobCount} multi-technician jobs</small></p>
          {skill.sharedJobCount > 0 && <p className={styles.notice}>Shared credit is not proof of independent capability.</p>}
          <details><summary>Review RO evidence ({skill.evidence.length})</summary>
            {!skill.evidence.length && <p>No individual RO evidence returned.</p>}
            <ul>{skill.evidence.map((entry, index) => <li key={`${entry.ro}-${index}`}>
              RO {entry.ro} · {entry.title} · Invoiced {date(entry.completedAt)}{entry.shared ? " · Multi-technician" : ""}
            </li>)}</ul>
          </details>
          {assessments.some(assessment => assessment.key === skill.key)
            ? <p><small>Manager assessment shown above. Historical evidence remains separate and is not removed by assessment changes.</small></p>
            : <details><summary>Assess this service title</summary>
              <SkillForm board={board} busy={busy} mutate={mutate} technicianId={technician.id} skill={skill} />
            </details>}
        </div>)}
        {canShowMore && <button type="button" data-testid={`skills-more-${technician.id}`}
          onClick={() => setLimits(previous => ({ ...previous, [technician.id]: limit + 25 }))}>
          Show more skill titles for {technician.name}
        </button>}
      </details>;
    })}
  </section>;
}

function SkillForm({ board, busy, mutate, technicianId, skill, assessment = false }: Pick<WorkProps, "board" | "busy" | "mutate"> & {
  technicianId: string; skill?: TechnicianSkill | HistoricalSkill; assessment?: boolean;
}) {
  const saved = skill && "status" in skill ? skill : undefined;
  return <CommandForm revision={board.revision} busy={busy} reset={!skill}
    testId={`skill-form-${technicianId}-${skill?.key ?? "manual"}`} label="Save assessment"
    submit={(data, expectedRevision) => {
      const title = normalizedTitle(String(data.get("title") ?? ""));
      const key = skill?.key ?? title.toLowerCase();
      const status = String(data.get("status"));
      const notes = String(data.get("notes") ?? "").trim();
      if (!title || title.length > 160 || !key || key.length > 160) throw new Error("Enter a skill title of 1–160 characters.");
      if (status !== "confirmed" && status !== "not-qualified" && status !== "remove") throw new Error("Choose a valid assessment.");
      if (status === "remove" && !assessment) throw new Error("Only a saved assessment can be removed.");
      if (notes.length > 500) throw new Error("Keep assessment notes within 500 characters.");
      if (status === "remove" && !window.confirm(`Remove the manager assessment for “${title}”? Historical evidence will remain.`)) return Promise.resolve(false);
      return mutate({ type: "skill", technicianId, key, title, status, notes }, expectedRevision);
    }}>
    <label>Skill / service title<input name="title" required maxLength={160} defaultValue={skill?.title ?? ""} /></label>
    {skill && <small>The original exact-title key is retained when editing the display title.</small>}
    <label>Manager assessment<select name="status" defaultValue={saved?.status ?? "confirmed"}>
      <option value="confirmed">Confirmed by manager</option>
      <option value="not-qualified">Not qualified</option>
      {assessment && <option value="remove">Remove manager assessment only</option>}
    </select></label>
    <label>Assessment notes<textarea name="notes" maxLength={500} defaultValue={saved?.notes ?? ""} /></label>
    <small>Saving records your decision. Historical invoiced-job counts are not a certification.</small>
  </CommandForm>;
}
