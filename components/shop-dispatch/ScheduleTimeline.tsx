"use client";
import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type PointerEvent as ReactPointerEvent } from "react";
import { resourcesFor, type Board, type Command, type Job } from "@/lib/shop-dispatch/model";
import { localParts } from "@/lib/shop-dispatch/schedule-engine";
import { buildTimelinePlan, timelineInstant } from "@/lib/shop-dispatch/timeline";
import css from "./ScheduleTimeline.module.css";
import styles from "./pilot.module.css";

type Plan = Extract<Command, { type: "plan" }>;
type Draft = { jobId: string; technicianId: string; date: string; time: string; minutes: string; revision: number };
type Placement = { jobId: string; technicianId: string; minute: number; minutes: number; error: string };
type Gesture = { jobId: string; kind: "move" | "resize"; x: number; y: number; offset: number; moved: boolean };
function minuteText(minute: number) { return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`; }
function clockMinute(time: string) { const [h, m] = time.split(":").map(Number); return h * 60 + m; }
function message(error: unknown) { return error instanceof Error ? error.message : "Could not validate this placement."; }
export function timelineDuration(job: Job): number | null {
  const duration = job.estimatedMinutes ?? job.bookMinutes;
  return typeof duration === "number" && Number.isFinite(duration) && duration > 0 ? duration : null;
}
function durationLabel(job: Job): string {
  const duration = timelineDuration(job);
  return duration === null ? "Duration unknown" : `${duration} min ${job.estimatedMinutes == null ? "book baseline — review" : "planned"}`;
}
export function timelineLockReason(board: Board, job: Job): string {
  if (!board.visits.some(v => v.id === job.visitId)) return "Visit is missing; review this job before scheduling.";
  if (board.visits.find(v => v.id === job.visitId)?.closed) return "Closed visit: scheduling is locked.";
  if (job.status === "completed") return "Completed work: scheduling is locked.";
  if (job.status === "active") return "Active work: pause the job before moving or resizing.";
  if (job.sourceRemoved) return "Removed upstream: review this job before scheduling.";
  return "";
}

export function ScheduleTimeline({ board, date, zone, locked, save, select }: {
  board: Board; date: string; zone: string; locked: boolean;
  save: (command: Plan, revision: number) => Promise<Board | null>;
  select: (visitId: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [preview, setPreview] = useState<Placement | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const gesture = useRef<Gesture | null>(null);
  const dragJob = useRef<string | null>(null);
  const dragOffset = useRef(0);
  const suppressClick = useRef(false);
  const details = useRef<HTMLDivElement | null>(null);
  const latest = useRef({ board, date, zone, locked }); latest.current = { board, date, zone, locked };
  const pointerHandlers = useRef({ move: (_: PointerEvent) => {}, end: (_: PointerEvent) => {} });
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const settings = board.schedule?.settings;
  const openings = settings?.weekly.filter(w => w.day === weekday) ?? [];
  const jobs = board.jobs.filter(job => {
    if (!job.plannedStart || !Number.isFinite(Date.parse(job.plannedStart))) return false;
    const start = localParts(Date.parse(job.plannedStart), zone).date;
    const duration = timelineDuration(job);
    const end = localParts(Date.parse(job.plannedStart) + (duration ?? 0) * 60000 - (duration ? 1 : 0), zone).date;
    return start <= date && end >= date;
  });
  function interval(job: Job) {
    const start = localParts(Date.parse(job.plannedStart!), zone);
    const endTime = Date.parse(job.plannedStart!) + (timelineDuration(job) ?? 0) * 60000;
    const end = localParts(endTime, zone);
    return { start: start.date < date ? 0 : start.minute, end: end.date > date ? 1440 : end.minute };
  }
  const holds = (board.schedule?.holds ?? []).filter(h => !h.releasedAt && Date.parse(h.expiresAt) > Date.now() && localParts(Date.parse(h.start), zone).date <= date && localParts(Date.parse(h.end) - 1, zone).date >= date);
  const shifts = settings?.technicians.flatMap(t => t.weekly.filter(w => w.day === weekday)) ?? [];
  const rangeStarts = [...openings, ...shifts].map(w => clockMinute(w.start));
  const rangeEnds = [...openings, ...shifts].map(w => clockMinute(w.end));
  jobs.forEach(j => { const i = interval(j); rangeStarts.push(i.start); rangeEnds.push(Math.max(i.start + 30, i.end)); });
  holds.forEach(h => {
    const a = localParts(Date.parse(h.start), zone), b = localParts(Date.parse(h.end), zone);
    rangeStarts.push(a.date < date ? 0 : a.minute); rangeEnds.push(b.date > date ? 1440 : b.minute);
  });
  const start = rangeStarts.length ? Math.max(0, Math.floor(Math.min(...rangeStarts) / 60) * 60) : 0;
  const end = rangeEnds.length ? Math.min(1440, Math.max(start + 60, Math.ceil(Math.max(...rangeEnds) / 60) * 60)) : 1440;
  const scale = 112 / 60;
  const width = (end - start) * scale;
  const positions = (a: number, b: number): CSSProperties => ({ left: (Math.max(start, a) - start) * scale, width: Math.max(2, (Math.min(end, b) - Math.max(start, a)) * scale) });
  const matches = (job: Job) => {
    const visit = board.visits.find(v => v.id === job.visitId);
    return `${job.title} ${visit?.ro ?? ""} ${visit?.vehicle ?? ""}`.toLowerCase().includes(search.trim().toLowerCase());
  };
  const queue = board.jobs.filter(j => !j.plannedStart || !Number.isFinite(Date.parse(j.plannedStart)) || (jobs.some(p => p.id === j.id) && !board.technicians.some(t => t.id === j.technicianId)));
  const outside = board.jobs.filter(j => j.plannedStart && Number.isFinite(Date.parse(j.plannedStart)) && !jobs.some(p => p.id === j.id));
  const chosen = board.jobs.find(j => j.id === selected);
  const visit = board.visits.find(v => v.id === chosen?.visitId);
  const chosenLock = chosen ? timelineLockReason(board, chosen) : "";
  function open(job: Job, placement?: Placement) {
    setSelected(job.id); setError(placement?.error ?? ""); setNotice("");
    const p = job.plannedStart && Number.isFinite(Date.parse(job.plannedStart)) ? localParts(Date.parse(job.plannedStart), zone) : null;
    setDraft({ jobId: job.id, technicianId: placement?.technicianId ?? job.technicianId ?? "", date: placement ? date : p?.date ?? date, time: placement ? minuteText(placement.minute) : p ? minuteText(p.minute) : "", minutes: placement ? String(placement.minutes || "") : timelineDuration(job) === null ? "" : String(timelineDuration(job)), revision: board.revision });
  }
  function placement(jobId: string, technicianId: string, minute: number, minutes?: number): Placement {
    const current = latest.current;
    const job = current.board.jobs.find(j => j.id === jobId)!;
    const duration = minutes ?? (job ? timelineDuration(job) : null) ?? 0;
    let problem = "";
    try {
      if (current.locked) throw new Error("A save is pending. Resolve it before scheduling other work.");
      if (!job) throw new Error("This job is no longer on the board.");
      const reason = timelineLockReason(current.board, job);
      if (reason) throw new Error(reason);
      if (!duration) throw new Error("No positive planned duration or book baseline is known. Enter minutes in the scheduling form before saving.");
      buildTimelinePlan(current.board, jobId, technicianId, timelineInstant(current.date, minute, current.zone), duration);
    } catch (cause) { problem = message(cause); }
    return { jobId, technicianId, minute, minutes: duration, error: problem };
  }
  function point(clientX: number, lane: HTMLElement, offset = 0) {
    const bounds = lane.getBoundingClientRect();
    return Math.max(start, Math.min(Math.min(1439, end - 1), Math.round((start + (clientX - bounds.left) / scale - offset) / 15) * 15));
  }
  function commitPreview(value: Placement | null) {
    if (!value || latest.current.locked) return;
    const job = latest.current.board.jobs.find(j => j.id === value.jobId);
    if (job) { open(job, value); details.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" }); }
  }
  pointerHandlers.current.move = event => {
    const g = gesture.current;
    if (!g || latest.current.locked) return;
    if (!g.moved && Math.abs(event.clientX - g.x) + Math.abs(event.clientY - g.y) < 6) return;
    g.moved = true; suppressClick.current = true;
    if (event.cancelable) event.preventDefault();
    const lane = document.elementFromPoint?.(event.clientX, event.clientY)?.closest<HTMLElement>("[data-timeline-lane]");
    if (!lane) { setPreview(null); return; }
    const job = latest.current.board.jobs.find(j => j.id === g.jobId);
    if (!job) return;
    const effectiveDuration = timelineDuration(job);
    if (g.kind === "resize" && job.plannedStart && effectiveDuration !== null) {
      const local = localParts(Date.parse(job.plannedStart), zone);
      if (local.date !== date) return;
      const minutes = Math.max(1, Math.min(1440, effectiveDuration + Math.round((event.clientX - g.x) / scale / 15) * 15));
      setPreview(placement(job.id, job.technicianId!, local.minute, minutes));
    } else setPreview(placement(job.id, lane.dataset.timelineLane!, point(event.clientX, lane, g.offset)));
  };
  const previewRef = useRef(preview); previewRef.current = preview;
  pointerHandlers.current.end = () => {
    const g = gesture.current; gesture.current = null;
    if (g?.moved) commitPreview(previewRef.current);
    setPreview(null);
    window.setTimeout(() => { suppressClick.current = false; }, 0);
  };
  useEffect(() => {
    const move = (e: PointerEvent) => pointerHandlers.current.move(e);
    const end = (e: PointerEvent) => pointerHandlers.current.end(e);
    const cancel = () => { gesture.current = null; setPreview(null); suppressClick.current = false; };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", cancel);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", cancel); };
  }, []);
  function begin(event: ReactPointerEvent, job: Job, kind: "move" | "resize") {
    if (locked || timelineLockReason(board, job) || event.button !== 0) return;
    if (kind === "resize") { event.preventDefault(); event.stopPropagation(); }
    const block = event.currentTarget.closest<HTMLElement>("[data-job-block]");
    const offset = kind === "move" && block ? (event.clientX - block.getBoundingClientRect().left) / scale : 0;
    gesture.current = { jobId: job.id, kind, x: event.clientX, y: event.clientY, offset, moved: false };
  }
  function dragStart(event: DragEvent, job: Job) {
    if (locked || timelineLockReason(board, job)) { event.preventDefault(); return; }
    dragOffset.current = gesture.current?.jobId === job.id ? gesture.current.offset : 0;
    gesture.current = null; dragJob.current = job.id;
    event.dataTransfer.setData("application/x-detect-dog-job", job.id); event.dataTransfer.effectAllowed = "move";
  }
  function dragOver(event: DragEvent<HTMLElement>, final = false) {
    const id = dragJob.current || event.dataTransfer.getData("application/x-detect-dog-job");
    if (!id || locked) return;
    event.preventDefault(); event.dataTransfer.dropEffect = "move";
    const value = placement(id, event.currentTarget.dataset.timelineLane!, point(event.clientX, event.currentTarget, dragOffset.current));
    if (final) { commitPreview(value); setPreview(null); dragJob.current = null; } else setPreview(value);
  }
  async function submit() {
    if (!draft || locked || chosenLock) return;
    setError(""); setNotice("");
    try {
      if (draft.revision !== board.revision) throw new Error("The board changed. Review latest board explicitly before saving this draft.");
      if (!draft.time || !draft.date || !draft.technicianId || !draft.minutes) throw new Error("Choose a technician, date, start time and an explicit planned duration.");
      const plan = buildTimelinePlan(board, draft.jobId, draft.technicianId, timelineInstant(draft.date, clockMinute(draft.time), zone), Number(draft.minutes));
      const confirmed = await save(plan, draft.revision);
      if (confirmed) { setDraft(d => d ? { ...d, revision: confirmed.revision } : null); setNotice(`Saved at revision ${confirmed.revision}. The timeline shows the server-confirmed plan.`); }
      else setError("Plan was not confirmed. Your draft is unchanged. Review the schedule error above; if the request is unconfirmed, use Retry unconfirmed change to resolve it.");
    } catch (cause) { setError(message(cause)); }
  }
  function review() {
    if (!draft || locked) return;
    try {
      buildTimelinePlan(board, draft.jobId, draft.technicianId, timelineInstant(draft.date, clockMinute(draft.time), zone), Number(draft.minutes));
      setDraft({ ...draft, revision: board.revision }); setError(""); setNotice(`Draft reviewed against revision ${board.revision}. Save explicitly to apply.`);
    } catch (cause) { setError(message(cause)); }
  }
  function queueCard(job: Job) {
    const v = board.visits.find(v => v.id === job.visitId), reason = timelineLockReason(board, job);
    return <article key={job.id} className={`${css.queueCard} ${!reason && !locked ? css.drag : ""}`} draggable={!locked && !reason && timelineDuration(job) !== null}
      onDragStart={e => dragStart(e, job)} onDragEnd={() => { dragJob.current = null; setPreview(null); }}
      onPointerDown={e => { if (!(e.target as HTMLElement).closest("button")) begin(e, job, "move"); }}
      data-testid={`timeline-queue-${job.id}`}>
      <small>RO #{v?.ro ?? "unknown"} · {job.status}</small><strong>{job.title}</strong><small>{v?.vehicle ?? "Vehicle unavailable"}</small>
      <small>{durationLabel(job)} · billed {job.bookMinutes === null ? "unknown" : `${(job.bookMinutes / 60).toFixed(2)} h`}</small>
      {reason && <small>{reason}</small>}
      {!reason && timelineDuration(job) === null && <small>Enter duration to schedule. No estimate assumed.</small>}
      <button type="button" data-testid={`schedule-job-${job.id}`} onClick={() => open(job)}>{reason ? "View job" : "Details / schedule"}</button>
    </article>;
  }
  return <section className={css.workspace} data-testid="schedule-timeline">
    <div className={css.heading}><div><h2>Technician timeline</h2><small>{date} · {zone} · drag jobs, then review and save</small></div>
      <div className={css.legend}><span><i className={css.dot} />Local job</span><span><i className={`${css.dot} ${css.holdDot}`} />Capacity hold</span><span><i className={`${css.dot} ${css.offDot}`} />Unavailable / unconfigured</span></div></div>
    <label className={css.search}>Find work<input type="search" data-testid="timeline-search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search RO, vehicle or job" /></label>
    <div className={css.layout}>
      <aside className={css.queue} data-testid="schedule-unplanned"><h3>Work queue <small>{queue.length}</small></h3><small>Individual jobs · drag to a technician or use Details / schedule.</small>
        <div className={css.queueList}>{queue.filter(matches).map(queueCard)}{!queue.filter(matches).length && <div className={css.empty}>{search ? "No queued jobs match this search." : "No unscheduled work. New local jobs appear here."}</div>}</div>
        <details><summary>Outside this day · {outside.length}</summary>{outside.filter(matches).map(queueCard)}</details>
        <details open><summary>Imported arrivals · read-only</summary><small>Arrival times are intake, not technician assignments. See snapshot warnings below.</small>
          {(board.schedule?.appointments?.appointments ?? []).filter(a => (!a.start || !Number.isFinite(Date.parse(a.start)) || localParts(Date.parse(a.start), zone).date === date) && `${a.ro} ${a.title}`.toLowerCase().includes(search.toLowerCase())).map(a =>
            <article className={`${css.queueCard} ${css.arrival}`} key={a.id}><strong>{a.ro ? `RO #${a.ro} · ` : ""}{a.title || "Imported arrival"}</strong><small>{a.start && Number.isFinite(Date.parse(a.start)) ? new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(new Date(a.start)) : "Time unknown"} · read-only</small></article>)}
        </details>
      </aside>
      <div className={css.timelineShell}>
        <div className={css.scroll}><div className={css.grid} style={{ "--timeline-width": `calc(${width}px + var(--lane-label))` } as CSSProperties}>
          <div className={css.ruler}><div className={css.corner}>Technicians / {board.technicians.length}</div><div className={css.hours}>{Array.from({ length: Math.ceil((end - start) / 60) }, (_, i) => <span className={css.hour} key={i} style={{ left: i * 112 }}>{minuteText(start + i * 60)}</span>)}</div></div>
          {board.technicians.map(tech => {
            const laneJobs = jobs.filter(j => j.technicianId === tech.id && matches(j)).sort((a, b) => Date.parse(a.plannedStart!) - Date.parse(b.plannedStart!));
            const tracks: number[] = [];
            const placed = laneJobs.map(job => { const i = interval(job); let track = tracks.findIndex(e => e <= i.start); if (track < 0) track = tracks.length; tracks[track] = Math.max(i.end, i.start + (timelineDuration(job) === null ? 65 : 1)); return { job, i, track }; });
            const shift = settings?.technicians.find(t => t.id === tech.id);
            const unavailable: { a: number; b: number }[] = [];
            for (let m = start; m < end; m += 15) {
              const working = tech.active && !!settings?.enabled && openings.some(w => clockMinute(w.start) <= m && clockMinute(w.end) >= m + 15) && shift?.weekly.some(w => w.day === weekday && clockMinute(w.start) <= m && clockMinute(w.end) >= m + 15);
              const absent = shift?.timeOff.some(off => {
                const a = localParts(Date.parse(off.start), zone), b = localParts(Date.parse(off.end), zone);
                return a.date <= date && b.date >= date && (a.date < date || a.minute < m + 15) && (b.date > date || b.minute > m);
              });
              if (!working || absent) { const last = unavailable[unavailable.length - 1]; if (last?.b === m) last.b = Math.min(end, m + 15); else unavailable.push({ a: m, b: Math.min(end, m + 15) }); }
            }
            return <div className={css.row} key={tech.id}>
              <div className={css.tech}><span className={css.initials}>{tech.name.split(/\s+/).slice(0, 2).map(n => n[0]).join("")}</span><div><strong>{tech.name}</strong><small>{!tech.active ? "Inactive" : !shift?.weekly.length ? "Shift unconfigured" : `${laneJobs.length} jobs`}</small></div></div>
              <div className={css.lane} data-timeline-lane={tech.id} data-testid={`timeline-lane-${tech.id}`} style={{ height: Math.max(78, tracks.length * 56 + 22) }}
                onDragOver={e => dragOver(e)} onDrop={e => dragOver(e, true)} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setPreview(null); }}>
                {unavailable.map(({ a, b }) => <div className={css.unavailable} key={a} style={positions(a, b)} title="Outside configured working hours or time off" />)}
                {holds.filter(h => h.technicianId === tech.id).map(h => { const a = localParts(Date.parse(h.start), zone), b = localParts(Date.parse(h.end), zone); return <div key={h.id} className={css.hold} data-testid={`timeline-hold-${h.id}`} style={positions(a.date < date ? 0 : a.minute, b.date > date ? 1440 : b.minute)} title={`Reserved capacity${h.resourceId ? ` · ${h.resourceId}` : ""}`}>Hold · {h.resourceId || "technician"}</div>; })}
                {placed.map(({ job, i, track }) => {
                  const v = board.visits.find(v => v.id === job.visitId), reason = timelineLockReason(board, job);
                  return <div key={job.id} data-job-block={job.id} data-testid={`timeline-block-${job.id}`} className={`${css.block} ${css[job.status] ?? ""} ${!reason && !locked ? css.drag : ""} ${timelineDuration(job) === null ? css.unknown : ""}`}
                    style={{ ...positions(i.start, timelineDuration(job) === null ? Math.min(end, i.start + 65) : i.end), top: 22 + track * 56 }}
                    draggable={!locked && !reason && timelineDuration(job) !== null} onDragStart={e => dragStart(e, job)} onDragEnd={() => { dragJob.current = null; setPreview(null); }}
                    title={`${job.title} · RO #${v?.ro ?? "unknown"} · ${reason || "Drag to move. Use details to schedule by keyboard or touch."}`}>
                    <button type="button" className={css.blockBody} data-testid={`schedule-job-${job.id}`} onPointerDown={e => begin(e, job, "move")} onClick={() => { if (!suppressClick.current) open(job); }}>
                      <strong>#{v?.ro ?? "?"} · {job.title}</strong><span>{v?.vehicle ?? "Vehicle unavailable"}</span><span>{minuteText(i.start)} · {timelineDuration(job) === null ? "Duration unknown (marker only)" : durationLabel(job)} · {job.bookMinutes === null ? "billed ?" : `${(job.bookMinutes / 60).toFixed(2)} h billed`}</span>
                    </button>
                    {!reason && !locked && timelineDuration(job) !== null && localParts(Date.parse(job.plannedStart!), zone).date === date && <button type="button" className={css.resize} data-testid={`timeline-resize-${job.id}`} aria-label={`Resize planned duration for ${job.title}`} onPointerDown={e => begin(e, job, "resize")} onClick={() => { if (!suppressClick.current) open(job); }}>‖</button>}
                  </div>;
                })}
                {preview?.technicianId === tech.id && <div className={`${css.preview} ${preview.error ? css.invalid : ""}`} data-testid="timeline-preview" style={{ ...positions(preview.minute, preview.minute + (preview.minutes || 60)), top: 22 }}><strong>{minuteText(preview.minute)} · {preview.minutes ? `${preview.minutes} min${board.jobs.find(j => j.id === preview.jobId)?.estimatedMinutes == null ? " · book baseline — review" : ""}` : "duration required"}</strong><br />{preview.error || "Valid preview · not saved"}</div>}
              </div>
            </div>;
          })}
          {!board.technicians.length && <div className={css.empty}>No technician lanes. Add technicians in Management, then configure their shifts.</div>}
        </div></div>
        <div className={css.caption}>15-minute drag snapping. Block width uses planned minutes, or a book baseline when no estimate exists. Book baselines require manager review before saving a planned duration; billed hours never change. Dashed unknown-duration markers do not imply capacity. Overlapping jobs stack. Shaded time is unavailable or unconfigured; the server validates every save.</div>
      </div>
    </div>
    {chosen && draft && <div className={css.details} ref={details} data-testid="timeline-details" role="region" aria-label="Job quick details">
      <div className={css.heading}><div><small>RO #{visit?.ro ?? "unknown"} · {visit?.vehicle ?? "Vehicle unavailable"}</small><h3>{chosen.title}</h3><small>{chosen.status} · {chosen.authorized ? "Authorized" : "Not authorized — unchanged by scheduling"}{chosen.sourceRemoved ? " · removed upstream; manager review" : ""}</small></div>
        <button type="button" onClick={() => { setSelected(null); setDraft(null); setError(""); }}>Close details</button></div>
      <div className={css.metrics}><span>Capacity duration<strong>{durationLabel(chosen)}</strong></span><span>Billed hours<strong>{chosen.bookMinutes === null ? "Unknown" : `${(chosen.bookMinutes / 60).toFixed(2)} h`}</strong></span><span>Bay / equipment<strong>{resourcesFor(board).find(r => r.id === chosen.resource)?.name ?? chosen.resource ?? "None"}</strong></span><span>Prerequisites<strong>{(chosen.prerequisites ?? []).map(id => board.jobs.find(j => j.id === id)?.title ?? id).join(", ") || "None"}</strong></span></div>
      {chosenLock ? <p className={styles.notice}>{chosenLock}</p> : <form onSubmit={e => { e.preventDefault(); void submit(); }} data-testid="timeline-plan-form">
        <fieldset disabled={locked} style={{ border: 0, margin: 0, padding: 0 }}>
          <div className={css.form}>
            <label>Technician<select data-testid="timeline-plan-technician" value={draft.technicianId} onChange={e => setDraft({ ...draft, technicianId: e.target.value })}><option value="">Choose technician</option>{board.technicians.map(t => <option key={t.id} value={t.id} disabled={!t.active}>{t.name}{t.active ? "" : " · inactive"}</option>)}</select></label>
            <label>Local date<input data-testid="timeline-plan-date" type="date" required value={draft.date} onChange={e => setDraft({ ...draft, date: e.target.value })} /></label>
            <label>Local start<input data-testid="timeline-plan-time" type="time" required value={draft.time} onChange={e => setDraft({ ...draft, time: e.target.value })} /></label>
            <label>Planned minutes{chosen.estimatedMinutes == null && timelineDuration(chosen) !== null ? " · book baseline — review" : ""}<input data-testid="timeline-plan-minutes" type="number" required min={1} max={1440} step={1} value={draft.minutes} placeholder="Required" onChange={e => setDraft({ ...draft, minutes: e.target.value })} /></label>
          </div>
          <div className={css.status}>Unsaved draft · base revision {draft.revision} · latest {board.revision} · {zone}. Authorization, prerequisites and bay remain unchanged.</div>
          <div className={css.actions}><button type="submit" className={styles.primary} data-testid="timeline-plan-save" disabled={draft.revision !== board.revision}>Save reviewed plan</button><button type="button" data-testid="timeline-plan-review" onClick={review}>Review latest board</button><button type="button" onClick={() => open(chosen)}>Discard draft / reload job</button></div>
        </fieldset>
      </form>}
      {error && <div role="alert" className={styles.error} data-testid="timeline-error">{error}</div>}
      {notice && <div role="status" className={styles.brandingInfo}>{notice}</div>}
      <div className={css.actions}><button type="button" disabled={locked} onClick={() => select(chosen.visitId)}>Open full RO details</button><small>Quick details stay here; full RO opens the existing visit workspace.</small></div>
    </div>}
  </section>;
}
