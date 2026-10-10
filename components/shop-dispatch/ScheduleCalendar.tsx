"use client";
import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import type { Board, Job } from "@/lib/shop-dispatch/model";
import { resourcesFor } from "@/lib/shop-dispatch/model";
import type { AvailabilityResult, ScheduleSettings as Settings } from "@/lib/shop-dispatch/schedule-types";
import { ScheduleSettings } from "./ScheduleSettings";
import styles from "./pilot.module.css";
import css from "./ScheduleCalendar.module.css";

type Command = { type: "settings"; requestId: string; revision: number; settings: Settings } | { type: "release"; requestId: string; revision: number; holdId: string };
export function scheduleDate(value: string | number, timeZone: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  return `${parts.find(p => p.type === "year")?.value}-${parts.find(p => p.type === "month")?.value}-${parts.find(p => p.type === "day")?.value}`;
}
export function shiftScheduleDate(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10);
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : "Scheduling request failed. Try again."; }
export function ScheduleCalendar({ board, busy, refresh, select }: { board: Board; busy: boolean; refresh: () => Promise<void>; select: (visitId: string) => void }) {
  const [fetched, setFetched] = useState<Board | null>(null);
  const current = fetched && fetched.revision >= board.revision ? fetched : board;
  const zone = current.schedule?.settings?.timeZone || "UTC";
  const [startDate, setStartDate] = useState(() => scheduleDate(Date.now(), zone));
  const [mode, setMode] = useState<"day" | "week">("week");
  const [duration, setDuration] = useState(60);
  const [technicianId, setTechnicianId] = useState("");
  const [resourceId, setResourceId] = useState("");
  const [skillKey, setSkillKey] = useState("");
  const [availability, setAvailability] = useState<AvailabilityResult | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<Command | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [clock, setClock] = useState(() => Date.now());
  const [loadedQuery, setLoadedQuery] = useState("");
  const controller = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const mounted = useRef(true);
  const sending = useRef(false);
  const count = mode === "day" ? 1 : 7;
  const endDate = shiftScheduleDate(startDate, count);
  const query = new URLSearchParams({ startDate, endDate, durationMinutes: String(duration) });
  if (technicianId) query.set("technicianId", technicianId);
  if (resourceId) query.set("resourceId", resourceId);
  if (skillKey.trim()) query.set("skillKey", skillKey.trim());
  const queryString = query.toString();
  const initialQuery = useRef(queryString);
  const queryStale = loadedQuery !== queryString;
  function time(value: string | null): string {
    if (!value || !Number.isFinite(Date.parse(value))) return "Time unknown";
    return new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
  }
  async function load(search: string) {
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    const token = ++sequence.current;
    setLoading(true); setError("");
    try {
      const response = await fetch(`/api/shop-dispatch/schedule?${search}`, { credentials: "include", signal: abort.signal, cache: "no-store" });
      if (!response.ok) throw new Error(response.status === 403 ? "Manager access is required." : `Schedule could not be loaded (${response.status}). Refresh to retry.`);
      const data = await response.json() as { board: Board; availability: AvailabilityResult };
      if (token !== sequence.current || !mounted.current) return;
      setFetched(previous => !previous || data.board.revision >= previous.revision ? data.board : previous);
      setAvailability(data.availability); setLoadedQuery(search); setClock(Date.now());
    } catch (cause) { if (!abort.signal.aborted && mounted.current) setError(errorText(cause)); }
    finally { if (token === sequence.current && mounted.current) setLoading(false); }
  }
  useEffect(() => {
    mounted.current = true;
    void load(initialQuery.current);
    // One bounded initial read. Date/filter changes require an explicit request.
    return () => { mounted.current = false; controller.current?.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    // Display clock only; never polls appointments or availability.
    const timer = window.setInterval(() => setClock(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);
  async function send(command: Command): Promise<Board | null> {
    if (sending.current) return null;
    sending.current = true; setSaving(true); setError(""); setNotice("");
    // Invalidate reads already in flight before a mutation can commit.
    sequence.current++; controller.current?.abort(); setLoading(false);
    let confirmed = false;
    try {
      const response = await fetch("/api/shop-dispatch/schedule", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command) });
      if (!response.ok) {
        if (response.status >= 500) setPending(command);
        else setPending(null);
        throw new Error(response.status === 409 ? "Revision conflict. Your draft is unchanged. Refresh schedule, then explicitly Reload latest form before trying again." : `Not saved (${response.status}). Review settings or retry the unconfirmed request.`);
      }
      const data = await response.json() as { board: Board };
      confirmed = true; setPending(null); setFetched(data.board); setAvailability(null); setLoadedQuery(""); setClock(Date.now());
      setNotice(`Change confirmed at revision ${data.board.revision}. Refresh schedule for new availability. After an uncertain settings retry, explicitly reload the settings form to review the saved values.`);
      try { await refresh(); } catch { setError("Change saved, but parent board refresh failed. Refresh the board manually."); }
      return data.board;
    } catch (cause) {
      if (!confirmed && !(cause instanceof Error && /^(Revision conflict|Not saved)/.test(cause.message))) setPending(command);
      setError(errorText(cause)); return null;
    } finally { sending.current = false; setSaving(false); }
  }
  function submitSearch(event: FormEvent) { event.preventDefault(); void load(queryString); }
  function jobCard(job: Job) {
    const visit = current.visits.find(v => v.id === job.visitId);
    return <button className={css.job} key={job.id} data-testid={`schedule-job-${job.id}`} onClick={() => select(job.visitId)}>
      <strong>{visit ? `#${visit.ro} · ` : ""}{job.title}</strong>
      <small>{job.plannedStart ? time(job.plannedStart) : "Unplanned"} · {job.status}{visit?.closed ? " · closed visit" : ""}</small>
      <small>{current.technicians.find(t => t.id === job.technicianId)?.name ?? (job.technicianId ? `Unknown technician ${job.technicianId}` : "Unassigned")}{job.resource ? ` · ${resourcesFor(current).find(r => r.id === job.resource)?.name ?? job.resource}` : ""}</small>
      <small>Estimate: {job.estimatedMinutes === null ? "unknown" : `${job.estimatedMinutes} min`} · Book: {job.bookMinutes === null ? "unknown" : `${job.bookMinutes} min`}</small>
      {job.sourceRemoved && <small className={styles.warning}>Removed upstream · manager review</small>}
    </button>;
  }
  const unplanned = current.jobs.filter(job => !job.plannedStart || !Number.isFinite(Date.parse(job.plannedStart)));
  const outside = current.jobs.filter(job => job.plannedStart && Number.isFinite(Date.parse(job.plannedStart)) && (scheduleDate(job.plannedStart, zone) < startDate || scheduleDate(job.plannedStart, zone) >= endDate));
  const appointments = current.schedule?.appointments;
  const appointmentStale = !appointments || clock - Date.parse(appointments.fetchedAt) > 300000 || !Number.isFinite(Date.parse(appointments.fetchedAt));
  const appointmentRangeMismatch = !appointments || appointments.startDate !== startDate || appointments.endDate !== endDate;
  const holds = current.schedule?.holds ?? [];
  const locked = busy || saving || !!pending;
  return <section className={css.workspace} data-testid="schedule-calendar" aria-busy={loading || saving}>
    <div className={styles.row}><div><div className={styles.eyebrow}>Manager workspace / capacity planning</div><h2>Shop schedule</h2><small>{zone}{!current.schedule?.settings?.timeZone ? " · display fallback only; configure shop timezone" : ""} · revision {current.revision} · every local job status included</small></div>
      <button aria-expanded={settingsOpen} data-testid="schedule-settings-toggle" onClick={() => setSettingsOpen(!settingsOpen)}>{settingsOpen ? "Hide settings" : "Scheduling settings"}</button></div>
    {error && <div className={styles.error} role="alert" data-testid="schedule-error">{error}</div>}
    {notice && <div className={styles.brandingInfo} role="status" data-testid="schedule-save-status">{notice}</div>}
    {pending && <div className={styles.error} role="alert">The last change is unconfirmed. Other saves are blocked; retry sends the identical request ID and revision.
      <div className={styles.actions}><button disabled={busy || saving} data-testid="schedule-retry" onClick={() => void send(pending)}>Retry unconfirmed change</button></div>
    </div>}
    <div hidden={!settingsOpen} className={styles.panel}><ScheduleSettings board={current} busy={locked} save={(settings, revision) => send({ type: "settings", requestId: crypto.randomUUID(), revision, settings })} /></div>
    {!current.schedule?.settings?.enabled && <div className={styles.notice}>Availability is disabled. Configure timezone, shop openings and technician shifts, then opt in. Existing jobs and imported arrivals remain visible.</div>}
    <form onSubmit={submitSearch} className={styles.panel} data-testid="schedule-search">
      <div className={css.toolbar}>
        <div className={styles.actions}>
          <button type="button" aria-label="Previous schedule period" data-testid="schedule-previous" onClick={() => setStartDate(shiftScheduleDate(startDate, -count))}>Previous</button>
          <button type="button" data-testid="schedule-today" onClick={() => setStartDate(scheduleDate(Date.now(), zone))}>Today</button>
          <button type="button" aria-label="Next schedule period" data-testid="schedule-next" onClick={() => setStartDate(shiftScheduleDate(startDate, count))}>Next</button>
        </div>
        <label>Starting date<input required type="date" data-testid="schedule-date" value={startDate} onChange={e => { if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) setStartDate(e.target.value); }} /></label>
        <div className={styles.actions}>{(["day", "week"] as const).map(value => <button key={value} type="button" aria-pressed={mode === value} className={mode === value ? styles.primary : ""} data-testid={`schedule-${value}`} onClick={() => setMode(value)}>{value === "day" ? "Day" : "7 days"}</button>)}</div>
      </div>
      <p className={css.range}>{startDate} – {shiftScheduleDate(endDate, -1)} · {zone} · at most seven days per request</p>
      <div className={css.filters}>
        <label>Duration · minutes<input required type="number" min={15} max={480} step={1} value={duration} onChange={e => setDuration(Number(e.target.value))} data-testid="schedule-duration" /></label>
        <label>Technician<select value={technicianId} onChange={e => setTechnicianId(e.target.value)}><option value="">All technicians</option>{current.technicians.map(t => <option key={t.id} value={t.id}>{t.name}{t.active ? "" : " (inactive)"}</option>)}</select></label>
        <label>Bay / resource<select value={resourceId} onChange={e => setResourceId(e.target.value)}><option value="">Any resource</option>{resourcesFor(current).map(r => <option key={r.id} value={r.id}>{r.name}{r.active ? "" : " (inactive)"}</option>)}</select></label>
        <label>Required skill key<input maxLength={160} value={skillKey} placeholder="Optional exact skill key" onChange={e => setSkillKey(e.target.value)} /></label>
      </div>
      <div className={styles.actions} style={{ marginTop: 16 }}><button className={styles.primary} type="submit" disabled={loading || saving || busy} data-testid="schedule-refresh">{loading ? "Loading schedule…" : "Refresh schedule & find availability"}</button><small>Manual refresh only. Filters apply to availability, never hide local jobs.</small></div>
    </form>
    {loading && <div className={styles.skeleton} aria-label="Loading schedule and arrivals" />}
    {queryStale && <div className={styles.notice} role="status" data-testid="schedule-query-stale">This date range or search has not been refreshed. Local jobs use the latest board; imported arrivals and availability may belong to the previous request.</div>}
    <div><div className={styles.row}><h2>Planned local work</h2><small>Planned start, manual estimate and book minutes are separate; cards are not duration-scaled.</small></div>
      <div className={css.calendar} style={{ "--days": count } as CSSProperties} data-testid="schedule-days">
        {Array.from({ length: count }, (_, index) => {
          const day = shiftScheduleDate(startDate, index);
          const jobs = current.jobs.filter(job => job.plannedStart && scheduleDate(job.plannedStart, zone) === day).sort((a, b) => Date.parse(a.plannedStart!) - Date.parse(b.plannedStart!));
          return <section className={css.day} key={day} data-testid={`schedule-day-${day}`}><h3>{new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(new Date(`${day}T12:00:00Z`))}</h3>{jobs.map(jobCard)}{!jobs.length && <p className={css.muted}>No planned local work.</p>}</section>;
        })}
      </div>
    </div>
    <section className={styles.panel} data-testid="schedule-unplanned"><h2>Unplanned queue <small>/ {unplanned.length}</small></h2><small>All statuses, including hidden source statuses and closed visits. A missing start is not available capacity.</small>{unplanned.map(jobCard)}{!unplanned.length && <p className={css.muted}>Every local job has a planned start.</p>}
      <details><summary>Planned outside this window · {outside.length}</summary>{outside.map(jobCard)}{!outside.length && <p>No jobs outside this window.</p>}</details>
    </section>
    <section className={styles.panel} data-testid="schedule-arrivals"><div className={styles.row}><h2>Protractor appointment arrivals</h2><span className={styles.chip}>Read-only intake · not job blocks</span></div>
      <small>{appointments ? `Snapshot ${appointments.startDate} to ${appointments.endDate} (exclusive) · fetched ${time(appointments.fetchedAt)}` : "No appointment snapshot received."}</small>
      {(appointmentStale || appointmentRangeMismatch || !appointments?.complete || appointments.warning) && <div className={styles.notice} role="status" data-testid="schedule-appointment-warning">
        {appointmentStale && <p>Appointment snapshot is missing or over five minutes old. Refresh before relying on capacity.</p>}
        {appointmentRangeMismatch && <p>Appointment snapshot does not cover the displayed range.</p>}
        {!appointments?.complete && <p>Appointment intake is incomplete. Missing arrivals must not be treated as free time.</p>}
        {appointments?.warning && <p>{appointments.warning}</p>}
      </div>}
      <div className={css.list}>{appointments?.appointments.map(appointment => {
        const unknownTime = !appointment.start || !Number.isFinite(Date.parse(appointment.start));
        const durationKnown = !unknownTime && appointment.end && Date.parse(appointment.end) > Date.parse(appointment.start!);
        return <article className={css.entry} key={appointment.id} data-testid={`schedule-appointment-${appointment.id}`}>
          <strong>{appointment.ro ? `#${appointment.ro} · ` : ""}{appointment.title || "Imported appointment"}</strong>
          <p>{time(appointment.start)}{durationKnown ? ` – ${time(appointment.end)}` : " · duration unknown"}</p>
          <small>Source technician IDs: {appointment.technicianSourceIds.join(", ") || "not supplied"}. Arrival only; does not create a local assignment.</small>
          {(unknownTime || !durationKnown) && <p className={styles.warning}>{unknownTime ? "Unknown arrival time. " : ""}{!durationKnown ? "Unknown duration; do not assume a booking length." : ""}</p>}
        </article>;
      })}</div>
      {!appointments?.appointments.length && <p className={css.muted}>No arrivals in the fetched snapshot. Check completeness and date range above before interpreting this as empty.</p>}
    </section>
    <section className={styles.panel} data-testid="schedule-availability"><h2>Availability search</h2>
      {!availability ? <div className={styles.empty}><h3>No current search results</h3><p>Choose a date range and duration, then refresh. Technician working hours must be configured explicitly.</p></div> : <>
        <small>Revision {availability.revision} · generated {time(availability.generatedAt)} · {availability.timeZone ?? "timezone not configured"} · appointment snapshot {time(availability.appointmentFetchedAt)}</small>
        {(queryStale || availability.revision !== current.revision || clock - Date.parse(availability.generatedAt) > 300000) && <div className={styles.notice}>Search results are stale or use a different revision/query. Refresh before relying on them.</div>}
        {availability.reasons.map((reason, i) => <div className={styles.notice} key={`reason-${i}`} data-testid="schedule-availability-reason">{reason}</div>)}
        {availability.warnings.map((warning, i) => <div className={styles.notice} key={`warning-${i}`}>{warning}</div>)}
        {availability.truncated && <div className={styles.notice}>Results truncated. Narrow the dates or choose a technician.</div>}
        {!availability.available && <p>No availability confirmed. Review the reasons above.</p>}
        {Array.from(new Set(availability.slots.map(slot => slot.technicianId))).map(id => <div key={id}><h3>{current.technicians.find(t => t.id === id)?.name ?? id}</h3><div className={css.slots}>{availability.slots.filter(slot => slot.technicianId === id).map((slot, i) => <div className={css.slot} key={`${slot.start}-${slot.resourceId}-${i}`} data-testid="schedule-slot">{time(slot.start)} – {time(slot.end)}{slot.resourceId ? ` · ${resourcesFor(current).find(r => r.id === slot.resourceId)?.name ?? slot.resourceId}` : ""}</div>)}</div></div>)}
        {!availability.slots.length && <p className={css.muted}>No slots returned for this search.</p>}
        <small>Informational only. Viewing a slot does not reserve it; integrators create holds separately.</small>
      </>}
    </section>
    <section className={styles.panel} data-testid="schedule-holds"><h2>Capacity holds <small>/ {holds.filter(hold => !hold.releasedAt && Date.parse(hold.expiresAt) > clock).length} unexpired</small></h2>
      <small>Expiration labels use the local clock; the server validates release and capacity. Refresh to confirm current state.</small>
      <div className={css.list}>{holds.map(hold => <article className={css.entry} key={hold.id} data-testid={`schedule-hold-${hold.id}`}>
        <div className={styles.row}><strong>{current.technicians.find(t => t.id === hold.technicianId)?.name ?? hold.technicianId}</strong><span className={styles.chip}>{hold.releasedAt ? "Released" : Date.parse(hold.expiresAt) <= clock ? "Expired" : `Expires ${time(hold.expiresAt)}`}</span></div>
        <p>{time(hold.start)} – {time(hold.end)}{hold.resourceId ? ` · ${resourcesFor(current).find(r => r.id === hold.resourceId)?.name ?? hold.resourceId}` : ""}</p>
        <small>Hold {hold.id}{hold.skillKey ? ` · skill ${hold.skillKey}` : ""}</small>
        {!hold.releasedAt && Date.parse(hold.expiresAt) > clock && <div className={styles.actions}><button disabled={locked} data-testid={`schedule-release-${hold.id}`} onClick={() => {
          if (window.confirm("Release this capacity hold? Integrators may no longer rely on this reservation.")) void send({ type: "release", requestId: crypto.randomUUID(), revision: current.revision, holdId: hold.id });
        }}>Release hold</button></div>}
      </article>)}</div>
      {!holds.length && <p className={css.muted}>No capacity holds on the latest board.</p>}
    </section>
  </section>;
}
