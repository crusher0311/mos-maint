"use client";
import { useState, type FormEvent } from "react";
import type { Board } from "@/lib/shop-dispatch/model";
import { resourcesFor } from "@/lib/shop-dispatch/model";
import { scheduleSettingsSchema, type ScheduleSettings as Settings } from "@/lib/shop-dispatch/schedule-types";
import styles from "./pilot.module.css";
import css from "./ScheduleCalendar.module.css";

type Opening = Settings["weekly"][number];
type Lane = Settings["technicians"][number];
const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function emptySettings(): Settings {
  return { enabled: false, timeZone: "", weekly: [], technicians: [], resources: [], bufferMinutes: 0, leadMinutes: 0 };
}
function Openings({ value, change, label }: { value: Opening[]; change: (next: Opening[]) => void; label: string }) {
  function patch(index: number, next: Partial<Opening>) { change(value.map((row, i) => i === index ? { ...row, ...next } : row)); }
  return <div>
    {!value.length && <p className={css.muted}>No openings configured · closed / unavailable.</p>}
    {value.map((row, index) => <div className={css.opening} key={index}>
      <label>Day<select aria-label={`${label} day ${index + 1}`} value={row.day} onChange={e => patch(index, { day: Number(e.target.value) })}>{days.map((day, i) => <option value={i} key={day}>{day}</option>)}</select></label>
      <label>Start<input required type="time" value={row.start} aria-label={`${label} start ${index + 1}`} onChange={e => patch(index, { start: e.target.value })} /></label>
      <label>End<input required type="time" value={row.end} aria-label={`${label} end ${index + 1}`} onChange={e => patch(index, { end: e.target.value })} /></label>
      <button type="button" aria-label={`Remove ${label} opening ${index + 1}`} onClick={() => change(value.filter((_, i) => i !== index))}>Remove</button>
    </div>)}
    <button type="button" disabled={value.length >= 21} onClick={() => change([...value, { day: 1, start: "09:00", end: "17:00" }])}>Add {label === "Shop" ? "opening" : "shift"}</button>
  </div>;
}
function LaneEditor({ lane, change, name }: { lane: Lane; change: (next: Lane) => void; name: string }) {
  return <details data-testid={`schedule-lane-${lane.id}`}><summary>{name} · {lane.weekly.length} shifts · {lane.timeOff.length} time-off periods</summary>
    <p><small>Weekly shifts use the shop timezone. Split overnight shifts across days. No shifts means unavailable.</small></p>
    <Openings value={lane.weekly} label={name} change={weekly => change({ ...lane, weekly })} />
    <h3 style={{ marginTop: 18 }}>Time off</h3>
    <small>Enter explicit UTC dates and times, not shop local time. UTC avoids ambiguity at daylight-saving transitions.</small>
    {lane.timeOff.map((period, index) => <div className={css.absence} key={index}>
      {(["start", "end"] as const).map(key => <label key={key}>{key === "start" ? "From" : "Until"} (UTC)<input required type="datetime-local" step="60" value={period[key] ? new Date(period[key]).toISOString().slice(0, 16) : ""} onChange={e => change({ ...lane, timeOff: lane.timeOff.map((row, i) => i === index ? { ...row, [key]: e.target.value ? `${e.target.value}:00.000Z` : "" } : row) })} /></label>)}
      <button type="button" onClick={() => change({ ...lane, timeOff: lane.timeOff.filter((_, i) => i !== index) })}>Remove time off</button>
    </div>)}
    <button type="button" disabled={lane.timeOff.length >= 60} onClick={() => change({ ...lane, timeOff: [...lane.timeOff, { start: "", end: "" }] })}>Add time off</button>
  </details>;
}

export function ScheduleSettings({ board, busy, save }: { board: Board; busy: boolean; save: (settings: Settings, revision: number) => Promise<Board | null> }) {
  const [draft, setDraft] = useState<Settings>(() => structuredClone(board.schedule?.settings ?? emptySettings()));
  const [baseRevision, setBaseRevision] = useState(board.revision);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  function patch(next: Partial<Settings>) { setDraft(current => ({ ...current, ...next })); setMessage(""); }
  function updateLane(kind: "technicians" | "resources", lane: Lane) {
    setDraft(current => ({ ...current, [kind]: current[kind].some(row => row.id === lane.id) ? current[kind].map(row => row.id === lane.id ? lane : row) : [...current[kind], lane] }));
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setMessage(""); setFailed(false);
    const parsed = scheduleSettingsSchema.safeParse(draft);
    if (!parsed.success) { setFailed(true); setMessage(parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join(" · ")); return; }
    if (draft.enabled && (!draft.weekly.length || !draft.technicians.some(lane => lane.weekly.length && board.technicians.some(t => t.id === lane.id && t.active)))) {
      setFailed(true); setMessage("Before enabling, configure shop openings and at least one active technician’s shifts. History is never used to infer availability."); return;
    }
    const result = await save(parsed.data, baseRevision);
    if (result) { setBaseRevision(result.revision); setDraft(structuredClone(result.schedule?.settings ?? parsed.data)); setMessage("Scheduling settings saved."); }
    else { setFailed(true); setMessage("Not confirmed. Draft and original revision preserved. Resolve the request above; after a conflict, refresh then explicitly reload this form."); }
  }
  return <form onSubmit={submit} className={css.settings} data-testid="schedule-settings">
    <div className={styles.row}><div><h2>Scheduling settings</h2><small data-testid="schedule-settings-revision">Form base revision {baseRevision} · latest {board.revision}. Refresh never rebases this draft.</small></div>
      <button type="button" disabled={busy} data-testid="schedule-settings-reload" onClick={() => {
        if (!window.confirm("Discard this scheduling draft and load the latest fetched settings?")) return;
        setDraft(structuredClone(board.schedule?.settings ?? emptySettings())); setBaseRevision(board.revision); setMessage("Latest fetched settings loaded. Review before saving."); setFailed(false);
      }}>Reload latest form</button></div>
    <fieldset disabled={busy}>
      <div className={styles.fields}>
        <label className={styles.check}><input data-testid="schedule-enabled" type="checkbox" checked={draft.enabled} onChange={e => patch({ enabled: e.target.checked })} />Enable availability (explicit opt-in)</label>
        <label>Shop timezone · IANA<input required data-testid="schedule-timezone" placeholder="America/Chicago" value={draft.timeZone} onChange={e => patch({ timeZone: e.target.value })} /></label>
        <label>Buffer between work · minutes<input type="number" required min={0} max={120} step={1} value={draft.bufferMinutes} onChange={e => patch({ bufferMinutes: Number(e.target.value) })} /></label>
        <label>Minimum booking lead · minutes<input type="number" required min={0} max={10080} step={1} value={draft.leadMinutes} onChange={e => patch({ leadMinutes: Number(e.target.value) })} /></label>
      </div>
      <section style={{ marginTop: 22 }}><h3>Weekly shop openings</h3><Openings value={draft.weekly} label="Shop" change={weekly => patch({ weekly })} /></section>
      <section style={{ marginTop: 22 }}><h3>Technician shifts & time off</h3><p><small>Configure each technician explicitly. No historical assignments, book hours or appointment assignments create working hours.</small></p>
        {board.technicians.map(tech => <LaneEditor key={tech.id} name={`${tech.name}${tech.active ? "" : " (inactive)"}`} lane={draft.technicians.find(row => row.id === tech.id) ?? { id: tech.id, weekly: [], timeOff: [] }} change={lane => updateLane("technicians", lane)} />)}
        {!board.technicians.length && <p className={css.muted}>Add technicians in Roster & intake before configuring shifts.</p>}
      </section>
      <section style={{ marginTop: 22 }}><h3>Optional bay / resource hours</h3><small>Unconfigured resources use server scheduling policy; add shifts or time off to restrict a bay explicitly.</small>
        {resourcesFor(board).map(resource => <div key={resource.id}><LaneEditor name={`${resource.name}${resource.active ? "" : " (inactive)"}`} lane={draft.resources.find(row => row.id === resource.id) ?? { id: resource.id, weekly: [], timeOff: [] }} change={lane => updateLane("resources", lane)} />
          {draft.resources.some(row => row.id === resource.id) && <button style={{ marginTop: 8 }} type="button" onClick={() => {
            if (window.confirm(`Remove all custom shifts and time off for ${resource.name} and use the default resource policy?`)) patch({ resources: draft.resources.filter(row => row.id !== resource.id) });
          }}>Remove custom bay schedule</button>}
        </div>)}
      </section>
      <div className={styles.actions} style={{ marginTop: 24 }}><button type="submit" className={styles.primary} data-testid="schedule-settings-save">Save scheduling settings</button></div>
    </fieldset>
    {message && <div role={failed ? "alert" : "status"} className={failed ? styles.error : styles.brandingInfo}>{message}</div>}
  </form>;
}
