"use client";
import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type PointerEvent as ReactPointerEvent } from "react";
import { blockers, resourcesFor, type Board, type Command, type Job } from "@/lib/shop-dispatch/model";
import { assessJobExperience } from "@/lib/shop-dispatch/experience";
import type { HistoryState } from "./schedule-history";
import { localParts } from "@/lib/shop-dispatch/schedule-engine";
import { buildResourceTimelinePlan, buildTimelinePlan, timelineInstant, roundTimelineMinutes } from "@/lib/shop-dispatch/timeline";
import css from "./ScheduleTimeline.module.css";
import styles from "./pilot.module.css";
import { visibleLaneTechnicians } from "@/lib/shop-dispatch/lane-views";

type Plan = Extract<Command, { type: "plan" }>;
export type TimelineMode = "technician" | "resource";
type Draft = { jobId: string; mode: TimelineMode; technicianId: string; resourceId: string; date: string; time: string; minutes: string; revision: number };
type Placement = { jobId: string; mode: TimelineMode; laneId: string; minute: number; minutes: number; error: string };
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
function draftDuration(job: Job): number | null {
  const duration = timelineDuration(job);
  return job.estimatedMinutes == null ? roundTimelineMinutes(duration) : duration;
}
export function timelineLockReason(board: Board, job: Job): string {
  if (!board.visits.some(v => v.id === job.visitId)) return "Visit is missing; review this job before scheduling.";
  if (board.visits.find(v => v.id === job.visitId)?.closed) return "Closed visit: scheduling is locked.";
  if (job.status === "completed") return "Completed work: scheduling is locked.";
  if (job.status === "active") return "Active work: pause the job before moving or resizing.";
  if (job.sourceRemoved) return "Removed upstream: review this job before scheduling.";
  return "";
}

export function ScheduleTimeline({ board, date, zone, locked, save, select, history = { status: "error", profiles: [], truncated: false }, nextDay }: {
  board: Board; date: string; zone: string; locked: boolean;
  save: (command: Plan, revision: number, mode: TimelineMode) => Promise<Board | null>;
  select: (visitId: string) => void;
  history?: HistoryState;
  nextDay?: (date: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState<TimelineMode>("technician");
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [preview, setPreview] = useState<Placement | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [experienceConfirmed, setExperienceConfirmed] = useState("");
  const [autoSaving, setAutoSaving] = useState(false);
  const autoSending = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const dragJob = useRef<string | null>(null);
  const dragOffset = useRef(0);
  const suppressClick = useRef(false);
  const details = useRef<HTMLDivElement | null>(null);
  const latest = useRef({ board, date, zone, locked, mode }); latest.current = { board, date, zone, locked, mode };
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
  const shifts = (mode === "resource" ? settings?.resources : settings?.technicians)?.flatMap(t => t.weekly.filter(w => w.day === weekday)) ?? [];
  const rangeStarts = [...openings, ...shifts].map(w => clockMinute(w.start));
  const rangeEnds = [...openings, ...shifts].map(w => clockMinute(w.end));
  const closed = !!settings?.enabled && openings.length === 0;
  const start = openings.length ? Math.min(...openings.map(w => clockMinute(w.start))) : rangeStarts.length ? Math.min(...rangeStarts) : 480;
  const end = openings.length ? Math.max(...openings.map(w => clockMinute(w.end))) : rangeEnds.length ? Math.max(...rangeEnds) : 1080;
  const nextWorkingDate = (() => {
    for (let offset = 1; offset <= 7; offset++) {
      const day = new Date(`${date}T12:00:00Z`); day.setUTCDate(day.getUTCDate() + offset);
      if (settings?.weekly.some(w => w.day === day.getUTCDay())) return day.toISOString().slice(0, 10);
    }
    return null;
  })();
  const scale = 112 / 60;
  const width = (end - start) * scale;
  const positions = (a: number, b: number): CSSProperties => ({ left: (Math.max(start, a) - start) * scale, width: Math.max(2, (Math.min(end, b) - Math.max(start, a)) * scale) });
  const matches = (job: Job) => {
    const visit = board.visits.find(v => v.id === job.visitId);
    return `${job.title} ${visit?.ro ?? ""} ${visit?.vehicle ?? ""}`.toLowerCase().includes(search.trim().toLowerCase());
  };
  const queue = board.jobs.filter(j => !j.plannedStart || !Number.isFinite(Date.parse(j.plannedStart)));
  const entities = mode === "resource" ? resourcesFor(board) : board.technicians;
  const laneTechnicians = visibleLaneTechnicians(board);
  const visibleIds = new Set(laneTechnicians.map(t => t.id));
  const hiddenLaneCount = board.technicians.length - laneTechnicians.length;
  const hiddenJobs = jobs.filter(j => j.technicianId && board.technicians.some(t => t.id === j.technicianId) && !visibleIds.has(j.technicianId));
  const hiddenMatches = hiddenJobs.filter(matches);
  const jobLane = (job: Job) => (mode === "resource" ? job.resource : job.technicianId) ?? "";
  const holdLane = (hold: (typeof holds)[number]) => (mode === "resource" ? hold.resourceId : hold.technicianId) ?? "";
  const unknownIds = Array.from(new Set([...jobs.map(jobLane), ...holds.map(holdLane)].filter(id => id && !entities.some(e => e.id === id))));
  const lanes = [
    ...(mode === "resource" ? entities : laneTechnicians).map(e => ({ id: e.id, name: e.name, active: e.active, known: true })),
    ...unknownIds.map(id => ({ id, name: `Unknown ${mode === "resource" ? "resource" : "technician"} · ${id}`, active: false, known: false })),
    { id: "", name: mode === "resource" ? "No bay / equipment" : "Unassigned technician", active: mode === "resource", known: false },
  ];
  const outside = board.jobs.filter(j => j.plannedStart && Number.isFinite(Date.parse(j.plannedStart)) && !jobs.some(p => p.id === j.id));
  const chosen = board.jobs.find(j => j.id === selected);
  const visit = board.visits.find(v => v.id === chosen?.visitId);
  const chosenLock = chosen ? timelineLockReason(board, chosen) : "";
  const assignmentChanged = !!chosen && !!draft && draft.mode === "technician" && !!draft.technicianId && draft.technicianId !== chosen.technicianId;
  const draftTechnician = board.technicians.find(t => t.id === draft?.technicianId);
  const experience = assignmentChanged && draftTechnician ? assessJobExperience(chosen!, draftTechnician, history) : null;
  const confirmationKey = draft ? `${draft.jobId}:${draft.technicianId}:${draft.revision}` : "";
  const requiresConfirmation = !!experience && experience.level !== "established";
  useEffect(() => { setExperienceConfirmed(""); }, [draft?.jobId, draft?.technicianId, draft?.revision, history]);
  useEffect(() => {
    if (!selected) return;
    details.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !latest.current.locked && !autoSending.current) {
        setSelected(null); setDraft(null); returnFocus.current?.focus();
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [selected]);
  function closeDetails() { if (!locked && !autoSending.current) { setSelected(null); setDraft(null); setError(""); returnFocus.current?.focus(); } }
  function open(job: Job, placement?: Placement) {
    if (locked || autoSending.current) return;
    if (!selected) returnFocus.current = document.activeElement as HTMLElement;
    setExperienceConfirmed("");
    setSelected(job.id); setError(placement?.error ?? ""); setNotice("");
    const p = job.plannedStart && Number.isFinite(Date.parse(job.plannedStart)) ? localParts(Date.parse(job.plannedStart), zone) : null;
    const draftMode = placement?.mode ?? mode;
    setDraft({ jobId: job.id, mode: draftMode, technicianId: placement && draftMode === "technician" ? placement.laneId : job.technicianId ?? "", resourceId: placement && draftMode === "resource" ? placement.laneId : job.resource ?? "", date: placement ? date : p?.date ?? date, time: placement ? minuteText(placement.minute) : p ? minuteText(p.minute) : "", minutes: placement ? String(placement.minutes || "") : draftDuration(job) === null ? "" : String(draftDuration(job)), revision: board.revision });
  }
  function placement(jobId: string, laneId: string, minute: number, minutes?: number): Placement {
    const current = latest.current;
    const job = current.board.jobs.find(j => j.id === jobId)!;
    const duration = minutes ?? (job ? draftDuration(job) : null) ?? 0;
    let problem = "";
    try {
      if (current.locked) throw new Error("A save is pending. Resolve it before scheduling other work.");
      if (!job) throw new Error("This job is no longer on the board.");
      const reason = timelineLockReason(current.board, job);
      if (reason) throw new Error(reason);
      if (!duration) throw new Error("No positive planned duration or book baseline is known. Enter minutes in the scheduling form before saving.");
      const instant = timelineInstant(current.date, minute, current.zone);
      if (current.mode === "resource") buildResourceTimelinePlan(current.board, jobId, laneId || null, instant, duration);
      else buildTimelinePlan(current.board, jobId, laneId, instant, duration);
    } catch (cause) { problem = message(cause); }
    return { jobId, mode: current.mode, laneId, minute, minutes: duration, error: problem };
  }
  function point(clientX: number, lane: HTMLElement, offset = 0) {
    const bounds = lane.getBoundingClientRect();
    return Math.max(start, Math.min(Math.min(1439, end - 1), Math.round((start + (clientX - bounds.left) / scale - offset) / 15) * 15));
  }
  function commitPreview(value: Placement | null) {
    if (!value || latest.current.locked || autoSending.current) return;
    const job = latest.current.board.jobs.find(j => j.id === value.jobId);
    if (!job) return;
    const technician = value.mode === "technician" ? value.laneId : job.technicianId;
    const assignment = technician !== job.technicianId;
    const targetTechnician = latest.current.board.technicians.find(t => t.id === technician);
    const assessment = assignment && targetTechnician ? assessJobExperience(job, targetTechnician, history) : null;
    const needsReview = !!value.error || job.estimatedMinutes === null || !job.authorized || blockers(latest.current.board, job).length > 0 || (assignment && (assessment?.level !== "established" || (!!latest.current.board.operationsEnabled && !!job.technicianId)));
    if (needsReview) { open(job, value); return; }
    const revision = latest.current.board.revision;
    try {
      const instant = timelineInstant(latest.current.date, value.minute, latest.current.zone);
      const plan = value.mode === "resource"
        ? buildResourceTimelinePlan(latest.current.board, job.id, value.laneId || null, instant, value.minutes)
        : buildTimelinePlan(latest.current.board, job.id, value.laneId, instant, value.minutes);
      autoSending.current = true; setAutoSaving(true); setNotice("Saving…");
      void save(plan, revision, value.mode).then(confirmed => {
        if (confirmed) {
          setNotice("Saved. The timeline shows the server-confirmed plan.");
          setSelected(null); setDraft(null);
        } else {
          autoSending.current = false;
          // Preserve the exact failed draft; uncertain retry is owned by Calendar.
          setSelected(job.id);
          setDraft({ jobId: job.id, mode: value.mode, technicianId: technician ?? "", resourceId: value.mode === "resource" ? value.laneId : job.resource ?? "", date: date, time: minuteText(value.minute), minutes: String(value.minutes), revision });
          setError("Plan not confirmed. Resolve the schedule error above before continuing.");
          setNotice("");
        }
      }).catch(cause => { setError(message(cause)); setNotice(""); }).finally(() => { autoSending.current = false; setAutoSaving(false); });
    } catch (cause) { open(job, { ...value, error: message(cause) }); }
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
      const minutes = roundTimelineMinutes(Math.max(1, Math.min(1440, effectiveDuration + (event.clientX - g.x) / scale)))!;
      setPreview(placement(job.id, jobLane(job), local.minute, minutes));
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
  useEffect(() => {
    // Clear gestures, never the reviewed form, when the displayed context changes.
    gesture.current = null; dragJob.current = null; setPreview(null); suppressClick.current = false;
  }, [mode, date, zone, board.revision, locked]);
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
      if (requiresConfirmation && experienceConfirmed !== confirmationKey) throw new Error("Review the technician experience warning and explicitly confirm this assignment first.");
      if (draft.revision !== board.revision) throw new Error("The board changed. Review latest board explicitly before saving this draft.");
      const plan = draftPlan(draft);
      const confirmed = await save(plan, draft.revision, draft.mode);
      if (confirmed) { setDraft(d => d ? { ...d, revision: confirmed.revision } : null); setNotice(`Saved at revision ${confirmed.revision}. The timeline shows the server-confirmed plan.`); }
      else setError("Plan was not confirmed. Your draft is unchanged. Review the schedule error above; if the request is unconfirmed, use Retry unconfirmed change to resolve it.");
    } catch (cause) { setError(message(cause)); }
  }
  function draftPlan(value: Draft) {
    if (!value.time || !value.date || !value.minutes || (value.mode === "technician" && !value.technicianId)) throw new Error("Choose a technician, date, start time and an explicit planned duration.");
    const instant = timelineInstant(value.date, clockMinute(value.time), zone);
    return value.mode === "resource"
      ? buildResourceTimelinePlan(board, value.jobId, value.resourceId || null, instant, Number(value.minutes))
      : buildTimelinePlan(board, value.jobId, value.technicianId, instant, Number(value.minutes));
  }
  function review() {
    if (!draft || locked) return;
    try {
      draftPlan(draft);
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
      <small>{board.technicians.find(t => t.id === job.technicianId)?.name ?? (job.technicianId ? `Unknown technician ${job.technicianId}` : "Unassigned technician")} · {resourcesFor(board).find(r => r.id === job.resource)?.name ?? (job.resource ? `Unknown resource ${job.resource}` : "No bay / equipment")}</small>
      <small>{durationLabel(job)} · billed {job.bookMinutes === null ? "unknown" : `${(job.bookMinutes / 60).toFixed(2)} h`}</small>
      {reason && <small>{reason}</small>}
      {!reason && timelineDuration(job) === null && <small>Enter duration to schedule. No estimate assumed.</small>}
      <button type="button" disabled={locked} data-testid={`schedule-job-${job.id}`} onClick={() => open(job)}>{reason ? "View job" : "Details / schedule"}</button>
    </article>;
  }
  function readiness(job: Job) {
    if (job.bookMinutes === 0 && job.estimatedMinutes === null) return "Notes / non-labor";
    if (job.operations && ["ordered", "partial", "incorrect"].includes(job.operations.parts)) return "Waiting parts";
    if (!job.authorized || job.estimatedMinutes === null || blockers(board, job).length || timelineLockReason(board, job)) return "Needs duration / authorization / review";
    return "Ready";
  }
  return <section className={css.workspace} data-testid="schedule-timeline">
    <div className={css.heading}><div><h2>{mode === "resource" ? "Bay / equipment timeline" : "Technician timeline"}</h2><small>{date} · {zone} · routine valid drops save automatically; other changes open review</small></div>
      <div className={css.legend}><span><i className={css.dot} />Local job</span><span><i className={`${css.dot} ${css.holdDot}`} />Capacity hold</span><span><i className={`${css.dot} ${css.offDot}`} />Unavailable / unconfigured</span></div></div>
    <div className={css.heading}><div className={css.viewSwitch} role="group" aria-label="Day timeline lanes">{(["technician", "resource"] as const).map(value => <button type="button" disabled={locked || autoSaving} key={value} aria-pressed={mode === value} data-testid={`timeline-mode-${value}`} className={mode === value ? styles.primary : ""} onClick={() => setMode(value)}>{value === "technician" ? "Technicians" : "Bays / equipment"}</button>)}</div>
      <small>{mode === "resource" ? "Shared occupancy across technicians. Moving a job never reassigns its technician." : "Technician moves keep the current bay / equipment."}</small></div>
    <label className={css.search}>Find work<input type="search" data-testid="timeline-search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search RO, vehicle or job" /></label>
    {mode === "technician" && <><div className={css.caption} role="status" data-testid="timeline-view-counts">{laneTechnicians.length} of {board.technicians.length} technician lanes shown · {hiddenLaneCount} hidden lanes · {hiddenJobs.length} {hiddenJobs.length === 1 ? "job" : "jobs"} on hidden lanes this day. Unknown and unassigned lanes stay visible. Search and queue cover all work.</div>
    {hiddenJobs.length > 0 && <details open={search.trim() ? true : undefined} className={css.hiddenResults} data-testid="timeline-hidden-jobs">
      <summary>Jobs on hidden lanes · {search.trim() ? `${hiddenMatches.length} search matches / ${hiddenJobs.length} total this day` : hiddenJobs.length}</summary>
      <div className={css.hiddenList}>{hiddenMatches.map(job => {
        const v = board.visits.find(value => value.id === job.visitId);
        return <article className={css.queueCard} key={job.id} data-testid={`timeline-hidden-job-${job.id}`}>
          <small>RO #{v?.ro ?? "unknown"} · {board.technicians.find(t => t.id === job.technicianId)?.name} · hidden lane</small>
          <strong>{job.title}</strong><small>{v?.vehicle ?? "Vehicle unavailable"} · {job.status} · {durationLabel(job)}</small>
          <button type="button" disabled={locked} onClick={() => open(job)}>Details / schedule</button>
        </article>;
      })}{!hiddenMatches.length && <div className={css.empty}>No hidden-lane jobs match this search.</div>}</div>
    </details>}</>}
    {draft && draft.mode !== mode && <div className={styles.notice} data-testid="timeline-draft-mode">Your unsaved {draft.mode === "resource" ? "bay / equipment" : "technician"} draft is retained below. Changing lanes does not change what this draft will save. Discard / reload the job to start a draft in this view.</div>}
    {notice && !chosen && <div role="status">{notice}</div>}
    <div className={css.layout}>
      <aside className={css.queue} data-testid="schedule-unplanned"><h3>Work queue <small>{queue.length}</small></h3><small>Individual jobs · drag to {mode === "resource" ? "a bay / equipment lane" : "a technician"} or use Details / schedule. Unassigned technician work requires technician review first.</small>
        <div className={css.queueList}>{["Ready", "Needs duration / authorization / review", "Waiting parts", "Notes / non-labor"].map(group => {
          const groupJobs = queue.filter(matches).filter(j => readiness(j) === group);
          return groupJobs.length > 0 && <section className={css.queueGroup} key={group} data-testid={`timeline-queue-group-${group.split(" ")[0].toLowerCase()}`}><h4>{group} · {groupJobs.length}</h4>{Array.from(new Set(groupJobs.map(j => j.visitId))).map(id => {
            const v = board.visits.find(v => v.id === id);
            return <section key={id}><h4>RO #{v?.ro ?? "unknown"}</h4><small>{v?.vehicle ?? "Vehicle unavailable"}</small>{groupJobs.filter(j => j.visitId === id).map(queueCard)}</section>;
          })}</section>;
        })}{!queue.filter(matches).length && <div className={css.empty}>{search ? "No queued jobs match this search." : "No unscheduled work. New local jobs appear here."}</div>}</div>
        <details><summary>Outside this day · {outside.length}</summary>{outside.filter(matches).map(queueCard)}</details>
        <details open><summary>Imported arrivals · read-only</summary><small>Arrival times are intake, not technician assignments. See snapshot warnings below.</small>
          {(board.schedule?.appointments?.appointments ?? []).filter(a => (!a.start || !Number.isFinite(Date.parse(a.start)) || localParts(Date.parse(a.start), zone).date === date) && `${a.ro} ${a.title}`.toLowerCase().includes(search.toLowerCase())).map(a =>
            <article className={`${css.queueCard} ${css.arrival}`} key={a.id}><strong>{a.ro ? `RO #${a.ro} · ` : ""}{a.title || "Imported arrival"}</strong><small>{a.start && Number.isFinite(Date.parse(a.start)) ? new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(new Date(a.start)) : "Time unknown"} · read-only</small></article>)}
        </details>
      </aside>
      <div className={css.timelineShell}>
        {closed ? <div className={css.closed} data-testid="timeline-closed-day"><h3>Shop closed · {date}</h3><p>No working hours configured for this day. Existing work is retained for review, not shown as available capacity.</p>{nextWorkingDate && nextDay ? <button type="button" disabled={locked} data-testid="timeline-next-working-day" onClick={() => nextDay(nextWorkingDate)}>Next working day · {nextWorkingDate}</button> : <p>Configure shop working hours in Scheduling settings.</p>}{jobs.filter(matches).map(queueCard)}</div> : <div className={css.scroll}><div className={css.grid} style={{ "--timeline-width": `calc(${width}px + var(--lane-label))` } as CSSProperties}>
          <div className={css.ruler}><div className={css.corner}>{mode === "resource" ? "Bays / equipment" : "Technicians"} / {mode === "resource" ? entities.length : laneTechnicians.length}</div><div className={css.hours}>{Array.from({ length: Math.ceil((end - start) / 60) }, (_, i) => <span className={css.hour} key={i} style={{ left: i * 112 }}>{minuteText(start + i * 60)}</span>)}</div></div>
          {lanes.map(tech => {
            const allLaneJobs = jobs.filter(j => jobLane(j) === tech.id);
            const laneJobs = allLaneJobs.filter(matches).filter(j => { const i = interval(j); return i.start < end && (i.end > start || (timelineDuration(j) === null && i.start >= start)); }).sort((a, b) => Date.parse(a.plannedStart!) - Date.parse(b.plannedStart!));
            const laneHolds = holds.filter(h => holdLane(h) === tech.id).filter(h => {
              const a = localParts(Date.parse(h.start), zone), b = localParts(Date.parse(h.end), zone);
              return (a.date < date || a.minute < end) && (b.date > date || b.minute > start);
            });
            const tracks: number[] = [];
            const placed = laneJobs.map(job => { const i = interval(job); let track = tracks.findIndex(e => e <= i.start); if (track < 0) track = tracks.length; tracks[track] = Math.max(i.end, i.start + (timelineDuration(job) === null ? 65 : 1)); return { job, i, track }; });
            const shift = mode === "resource" ? settings?.resources.find(r => r.id === tech.id) : settings?.technicians.find(t => t.id === tech.id);
            const unavailable: { a: number; b: number }[] = [];
            for (let m = start; m < end; m += 15) {
              // Unconfigured resource hours inherit shop openings, as on the server.
              // Explicit resource hours (including an empty weekly list) override this.
              const laneWorking = mode === "resource" && !shift
                ? tech.known || !tech.id
                : !!shift?.weekly.some(w => w.day === weekday && clockMinute(w.start) <= m && clockMinute(w.end) >= m + 15);
              const working = tech.active && !!settings?.enabled && openings.some(w => clockMinute(w.start) <= m && clockMinute(w.end) >= m + 15) && laneWorking;
              const absent = shift?.timeOff.some(off => {
                const a = localParts(Date.parse(off.start), zone), b = localParts(Date.parse(off.end), zone);
                return a.date <= date && b.date >= date && (a.date < date || a.minute < m + 15) && (b.date > date || b.minute > m);
              });
              if (!working || absent) { const last = unavailable[unavailable.length - 1]; if (last?.b === m) last.b = Math.min(end, m + 15); else unavailable.push({ a: m, b: Math.min(end, m + 15) }); }
            }
            return <div className={css.row} key={tech.id}>
              <div className={`${css.tech} ${!tech.known || !tech.active ? css.retained : ""}`}><span className={css.initials}>{tech.name.split(/\s+/).slice(0, 2).map(n => n[0]).join("")}</span><div><strong>{tech.name}</strong><small>{!tech.id ? "Retained work · no assignment" : !tech.known ? "Unknown · retained work" : !tech.active ? "Inactive · retained work" : mode === "resource" && !shift ? "Shop hours apply" : !shift?.weekly.length ? "Hours unconfigured" : "Configured hours / time off"}</small><small className={css.laneMeta}>{allLaneJobs.length} jobs · {laneHolds.length} holds{search && laneJobs.length !== allLaneJobs.length ? ` · ${laneJobs.length} matches` : ""}</small></div></div>
              <div className={css.lane} data-timeline-lane={tech.id} data-testid={`timeline-lane-${tech.id}`} style={{ height: Math.max(78, tracks.length * 56 + 22) }}
                onDragOver={e => dragOver(e)} onDrop={e => dragOver(e, true)} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setPreview(null); }}>
                {unavailable.map(({ a, b }) => <div className={css.unavailable} key={a} style={positions(a, b)} title="Outside configured working hours or time off" />)}
                {laneHolds.map(h => { const a = localParts(Date.parse(h.start), zone), b = localParts(Date.parse(h.end), zone); const owner = mode === "resource" ? board.technicians.find(t => t.id === h.technicianId)?.name ?? h.technicianId : resourcesFor(board).find(r => r.id === h.resourceId)?.name ?? h.resourceId ?? "technician"; return <div key={h.id} className={css.hold} data-testid={`timeline-hold-${h.id}`} style={positions(a.date < date ? 0 : a.minute, b.date > date ? 1440 : b.minute)} title={`Reserved capacity · ${owner} · ${h.id}`}>Hold · {owner}</div>; })}
                {placed.map(({ job, i, track }) => {
                  const v = board.visits.find(v => v.id === job.visitId), reason = timelineLockReason(board, job);
                  return <div key={job.id} data-job-block={job.id} data-testid={`timeline-block-${job.id}`} className={`${css.block} ${css[job.status] ?? ""} ${!reason && !locked ? css.drag : ""} ${timelineDuration(job) === null ? css.unknown : ""}`}
                    style={{ ...positions(i.start, timelineDuration(job) === null ? Math.min(end, i.start + 65) : i.end), top: 22 + track * 56 }}
                    draggable={!locked && !reason && timelineDuration(job) !== null} onDragStart={e => dragStart(e, job)} onDragEnd={() => { dragJob.current = null; setPreview(null); }}
                    title={`${job.title} · RO #${v?.ro ?? "unknown"} · Technician: ${board.technicians.find(t => t.id === job.technicianId)?.name ?? job.technicianId ?? "Unassigned"} · Resource: ${resourcesFor(board).find(r => r.id === job.resource)?.name ?? job.resource ?? "None"} · ${reason || "Drag to move. Use details to schedule by keyboard or touch."}`}>
                    <button type="button" className={css.blockBody} data-testid={`schedule-job-${job.id}`} onPointerDown={e => begin(e, job, "move")} onClick={() => { if (!suppressClick.current) open(job); }}>
                      <strong>#{v?.ro ?? "?"} · {job.title}</strong><span>{mode === "resource" ? board.technicians.find(t => t.id === job.technicianId)?.name ?? (job.technicianId ? `Unknown technician ${job.technicianId}` : "Unassigned technician") : v?.vehicle ?? "Vehicle unavailable"} · {job.status}</span><span>{minuteText(i.start)} · {timelineDuration(job) === null ? "Duration unknown (marker only)" : durationLabel(job)} · {job.bookMinutes === null ? "billed ?" : `${(job.bookMinutes / 60).toFixed(2)} h billed`}</span>
                    </button>
                    {!reason && !locked && timelineDuration(job) !== null && localParts(Date.parse(job.plannedStart!), zone).date === date && <button type="button" className={css.resize} data-testid={`timeline-resize-${job.id}`} aria-label={`Resize planned duration for ${job.title}`} onPointerDown={e => begin(e, job, "resize")} onClick={() => { if (!suppressClick.current) open(job); }}>‖</button>}
                  </div>;
                })}
                {preview?.mode === mode && preview.laneId === tech.id && <div className={`${css.preview} ${preview.error ? css.invalid : ""}`} data-testid="timeline-preview" style={{ ...positions(preview.minute, preview.minute + (preview.minutes || 60)), top: 22 }}><strong>{minuteText(preview.minute)} · {preview.minutes ? `${preview.minutes} min${board.jobs.find(j => j.id === preview.jobId)?.estimatedMinutes == null ? " · book baseline — review" : ""}` : "duration required"}</strong><br />{preview.error || "Valid preview · not saved"}</div>}
              </div>
            </div>;
          })}
          {mode === "technician" && !laneTechnicians.length && entities.length > 0 && <div className={css.empty}>No active technicians match this saved view. Choose All technicians or edit the view. Hidden work remains accessible above.</div>}
          {!entities.length && <div className={css.empty}>{mode === "resource" ? "No configured bays / equipment. Work without a resource remains visible above. Add resources in Management." : "No technician lanes. Unassigned work remains visible above. Add technicians in Management, then configure their shifts."}</div>}
        </div></div>}
        {!closed && jobs.some(j => { const i = interval(j); return i.start < start || i.end > end; }) && <details data-testid="timeline-outside-hours"><summary>Retained work outside shop hours</summary>{jobs.filter(matches).filter(j => { const i = interval(j); return i.start < start || i.end > end; }).map(queueCard)}</details>}
        <div className={css.caption}>15-minute drag snapping. Block width uses planned minutes, or a book baseline when no estimate exists. Book baselines require manager review before saving a planned duration; billed hours never change. Dashed unknown-duration markers do not imply capacity. Overlapping jobs stack. Shaded time is unavailable or unconfigured; the server validates every save. {mode === "resource" ? "Resource hours inherit shop openings unless explicitly configured. Resource moves preserve technician, authorization and prerequisites. No-resource work is not a shared equipment reservation." : "Unknown, inactive and unassigned lanes retain local work."} Active / paused work and unknown durations can block capacity beyond the drawn block; blank space is not confirmed availability.</div>
      </div>
    </div>
    {chosen && draft && <div className={css.details} ref={details} tabIndex={-1} data-testid="timeline-details" role="region" aria-label="Job quick details">
      <div className={css.heading}><div><small>RO #{visit?.ro ?? "unknown"} · {visit?.vehicle ?? "Vehicle unavailable"}</small><h3>{chosen.title}</h3><small>{chosen.status} · {chosen.authorized ? "Authorized" : "Not authorized — unchanged by scheduling"}{chosen.sourceRemoved ? " · removed upstream; manager review" : ""}</small></div>
        <button type="button" disabled={locked} onClick={closeDetails}>Close details</button></div>
      <div className={css.metrics}><span>Capacity duration<strong>{durationLabel(chosen)}</strong></span><span>Billed hours<strong>{chosen.bookMinutes === null ? "Unknown" : `${(chosen.bookMinutes / 60).toFixed(2)} h`}</strong></span><span>Bay / equipment<strong>{resourcesFor(board).find(r => r.id === chosen.resource)?.name ?? chosen.resource ?? "None"}</strong></span><span>Prerequisites<strong>{(chosen.prerequisites ?? []).map(id => board.jobs.find(j => j.id === id)?.title ?? id).join(", ") || "None"}</strong></span></div>
      {chosenLock ? <p className={styles.notice}>{chosenLock}</p> : <form onSubmit={e => { e.preventDefault(); void submit(); }} data-testid="timeline-plan-form">
        <fieldset disabled={locked} style={{ border: 0, margin: 0, padding: 0 }}>
          <div className={`${css.form} ${draft.mode === "resource" ? css.resourceForm : ""}`}>
            {draft.mode === "resource" ? <><label>Technician · preserved<input data-testid="timeline-plan-technician-preserved" readOnly value={board.technicians.find(t => t.id === chosen.technicianId)?.name ?? chosen.technicianId ?? "Unassigned — use technician view first"} /></label><label>Bay / equipment<select data-testid="timeline-plan-resource" value={draft.resourceId} onChange={e => setDraft({ ...draft, resourceId: e.target.value })}><option value="">No bay / equipment</option>{draft.resourceId && !resourcesFor(board).some(r => r.id === draft.resourceId) && <option value={draft.resourceId} disabled>Unknown resource · {draft.resourceId}</option>}{resourcesFor(board).map(r => <option key={r.id} value={r.id} disabled={!r.active}>{r.name}{r.active ? "" : " · inactive"}</option>)}</select></label></> : <label>Technician<select data-testid="timeline-plan-technician" value={draft.technicianId} onChange={e => setDraft({ ...draft, technicianId: e.target.value })}><option value="">Choose technician</option>{draft.technicianId && !board.technicians.some(t => t.id === draft.technicianId) && <option value={draft.technicianId} disabled>Unknown technician · {draft.technicianId}</option>}{board.technicians.map(t => <option key={t.id} value={t.id} disabled={!t.active}>{t.name}{t.active ? "" : " · inactive"}</option>)}</select></label>}
            <label>Local date<input data-testid="timeline-plan-date" type="date" required value={draft.date} onChange={e => setDraft({ ...draft, date: e.target.value })} /></label>
            <label>Local start<input data-testid="timeline-plan-time" type="time" required value={draft.time} onChange={e => setDraft({ ...draft, time: e.target.value })} /></label>
            <label>Planned minutes{chosen.estimatedMinutes == null && timelineDuration(chosen) !== null ? " · book baseline — review" : ""}<input data-testid="timeline-plan-minutes" type="number" required min={1} max={1440} step={1} value={draft.minutes} placeholder="Required" onChange={e => setDraft({ ...draft, minutes: e.target.value })} /></label>
          </div>
          <button type="button" data-testid="timeline-round-minutes" disabled={roundTimelineMinutes(Number(draft.minutes)) === null} onClick={() => setDraft({ ...draft, minutes: String(roundTimelineMinutes(Number(draft.minutes))) })}>Round up to 15 min</button>
          <small>Book-based estimates and resizing round up to the next 15-minute increment, minimum 15. Billed hours stay unchanged; existing saved estimates are preserved when moving.</small>
          <div className={css.status}>Unsaved {draft.mode === "resource" ? "bay / equipment" : "technician"} draft · base revision {draft.revision} · latest {board.revision} · {zone}. Authorization, prerequisites and book labor remain unchanged. {draft.mode === "resource" ? "Technician is preserved; only resource, start and planned minutes change." : "Bay / equipment remains unchanged."}</div>
          {requiresConfirmation && experience && <section className={styles.notice} role="alert" data-testid="timeline-experience-warning"><strong>{experience.title}</strong><p>{experience.message}</p><p>{experience.count === null ? "Completed-job count unknown" : `${experience.count} matching completed jobs`} · {experience.confirmed ? "Manager-confirmed skill" : "No manager-confirmed qualification inferred"}{history.truncated ? " · History truncated; counts are incomplete" : ""}</p>
            {experience.evidence.map((item, i) => <p key={i}>RO #{item.ro} · {item.title} · {item.completedAt ?? "Date unknown"}{item.shared ? " · shared work" : ""}</p>)}
            <p>Confirmation is advisory only. It does not authorize work or override qualification or handoff restrictions.</p>
            <label><input type="checkbox" data-testid="timeline-experience-confirm" checked={experienceConfirmed === confirmationKey} onChange={e => setExperienceConfirmed(e.target.checked ? confirmationKey : "")} />I reviewed this technician’s experience for this assignment.</label>
          </section>}
          <div className={css.actions}><button type="submit" className={styles.primary} data-testid="timeline-plan-save" disabled={draft.revision !== board.revision}>Save reviewed plan</button><button type="button" data-testid="timeline-plan-review" onClick={review}>Review latest board</button><button type="button" onClick={() => open(chosen)}>Discard draft / reload job</button></div>
        </fieldset>
      </form>}
      {error && <div role="alert" className={styles.error} data-testid="timeline-error">{error}</div>}
      {notice && <div role="status" className={styles.brandingInfo}>{notice}</div>}
      <div className={css.actions}><button type="button" disabled={locked} onClick={() => select(chosen.visitId)}>Open full RO details</button><small>Quick details stay here; full RO opens the existing visit workspace.</small></div>
    </div>}
    {draft && !chosen && <div className={styles.notice} role="alert">The draft job is no longer on the board. Draft retained; no save can be made. <button type="button" disabled={locked} onClick={() => { setDraft(null); setSelected(null); }}>Discard missing job draft</button></div>}
  </section>;
}
