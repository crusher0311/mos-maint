"use client";
import type { Board, Job, Visit } from "@/lib/shop-dispatch/model";
import { blockers, resourcesFor } from "@/lib/shop-dispatch/model";
import { dateLabel } from "./helpers";
import styles from "./pilot.module.css";

export function Timeline({ board, visits, now, select }: { board: Board; visits: Visit[]; now: number; select: (id: string) => void }) {
  const visible = new Set(visits.map(v => v.id));
  const jobs = board.jobs.filter(j => visible.has(j.visitId));
  const day = new Date(now); day.setHours(7, 0, 0, 0);
  const start = day.getTime(), span = 12 * 3600000;
  const lanes = [
    ...board.technicians.filter(t => t.active || jobs.some(j => j.technicianId === t.id)).map(t => ({ id: t.id, title: t.name, note: t.active ? "Local assignments" : "Inactive · history", jobs: jobs.filter(j => j.technicianId === t.id) })),
    { id: "unassigned", title: "Unassigned", note: "Manager assignment needed", jobs: jobs.filter(j => !j.technicianId) },
    ...resourcesFor(board).filter(r => r.active || jobs.some(j => j.resource === r.id)).map(r => ({
      id: `resource:${r.id}`, title: r.name,
      note: !r.active ? "Inactive · history" : board.jobs.some(j => j.resource === r.id && j.status === "active") ? "Local session occupied" : "No local active session",
      jobs: jobs.filter(j => j.resource === r.id),
    })),
  ];
  function block(job: Job, timed: boolean) {
    const visit = board.visits.find(v => v.id === job.visitId)!;
    const left = job.plannedStart ? (Date.parse(job.plannedStart) - start) / span * 100 : 0;
    const width = job.estimatedMinutes ? Math.min(job.estimatedMinutes / 720 * 100, 100 - left) : 16;
    return <button key={job.id} className={`${timed ? styles.block : ""} ${job.status === "active" ? styles.active : ""}`} style={timed ? { left: `${left}%`, width: `${Math.max(0, width)}%` } : undefined}
      onClick={() => select(job.visitId)} data-testid={`timeline-job-${job.id}`} title={`${visit.vehicle} · ${job.title} · ${dateLabel(job.plannedStart)} · ${job.estimatedMinutes === null ? "duration unknown; marker is not to scale" : `${job.estimatedMinutes} min manual estimate`}`}>
      <strong>#{visit.ro} · {job.title}</strong><small style={job.status === "active" ? { color: "inherit" } : undefined}>{visit.vehicle} · {job.status}</small>
      <small style={job.status === "active" ? { color: "inherit" } : undefined}>{blockers(board, job).length ? "Blocked · " : ""}{job.estimatedMinutes === null ? "Estimate unknown · marker" : `${job.estimatedMinutes} min manual`}</small>
    </button>;
  }
  return <><div className={styles.row}><h2>Dispatch timeline</h2><small>{new Date(now).toLocaleDateString()} · 07:00–19:00 local</small></div>
    <div className={styles.timeline} data-testid="pilot-timeline" tabIndex={0} role="region" aria-label="Technician timeline; scroll horizontally">
      <div className={styles.lane}><div className={styles.laneTitle}><span className={styles.eyebrow}>Technician / resource</span></div><div className={styles.axis}>{Array.from({ length: 13 }, (_, i) => <span key={i}>{String(i + 7).padStart(2, "0")}:00</span>)}</div></div>
      {lanes.map(lane => {
        const planned = lane.jobs.filter(j => j.plannedStart && Date.parse(j.plannedStart) >= start && Date.parse(j.plannedStart) < start + span).sort((a, b) => Date.parse(a.plannedStart!) - Date.parse(b.plannedStart!));
        const outside = lane.jobs.filter(j => !planned.includes(j));
        return <div className={styles.lane} key={lane.id} data-testid={`pilot-lane-${lane.id}`}><div className={styles.laneTitle}><strong>{lane.title}</strong><small>{lane.note}</small><small>{lane.jobs.length} jobs</small></div><div>
          <div className={styles.track}>{planned.map(job => <div className={styles.trackRow} key={job.id}>{block(job, true)}</div>)}
            {!planned.length && <small style={{ display: "block", padding: 16 }}>No jobs planned in this window</small>}
            {now >= start && now < start + span && <div className={styles.now} style={{ left: `${(now - start) / span * 100}%` }} title="Current server-adjusted time" />}
          </div>
          {!!outside.length && <div className={styles.queue}><small style={{ width: "100%" }}>Unscheduled / outside today’s window</small>{outside.map(job => block(job, false))}</div>}
        </div></div>;
      })}
    </div><p><small>Each row is an individual job. Width shows only the manual planned estimate; unknown durations use a labelled marker, not a prediction. Shared-resource work appears in both technician and resource lanes. No provider availability or optimized scheduler is implied.</small></p>
  </>;
}
