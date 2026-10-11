"use client";
import { useRef, useState } from "react";
import type { Board, Command } from "@/lib/shop-dispatch/model";
import { visibleLaneTechnicians, type ScheduleLaneView } from "@/lib/shop-dispatch/lane-views";
import css from "./ScheduleViews.module.css";
import styles from "./pilot.module.css";

export type ScheduleViewCommand = Extract<Command, { type: "saveScheduleView" | "deleteScheduleView" | "selectScheduleView" }>;
type Draft = { view: ScheduleLaneView; revision: number; isNew: boolean };
type FailedAction = { command: ScheduleViewCommand; revision: number };
function toggle(values: string[], value: string) { return values.includes(value) ? values.filter(v => v !== value) : [...values, value]; }

export function ScheduleViews({ board, locked, save }: {
  board: Board; locked: boolean;
  save: (command: ScheduleViewCommand, revision: number) => Promise<Board | null>;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [failed, setFailed] = useState<FailedAction | null>(null);
  const [sending, setSending] = useState(false);
  const inFlight = useRef(false);
  const views = board.scheduleViews?.views ?? [];
  const selectedId = board.scheduleViews?.selectedId ?? null;
  const selected = views.find(v => v.id === selectedId);
  const disabled = locked || sending;
  const skills = new Map<string, { title: string; count: number }>();
  board.technicians.forEach(t => (t.skills ?? []).filter(s => s.status === "confirmed").forEach(s => {
    const old = skills.get(s.key);
    skills.set(s.key, { title: old?.title ?? s.title, count: (old?.count ?? 0) + (t.active ? 1 : 0) });
  }));
  const skillKeys = [...new Set([...skills.keys(), ...(draft?.view.skillKeys ?? [])])].sort();
  const missingIds = (draft?.view.technicianIds ?? []).filter(id => !board.technicians.some(t => t.id === id));
  const preview = draft ? visibleLaneTechnicians({
    ...board, scheduleViews: { views: [draft.view], selectedId: draft.view.id },
  }) : [];
  function edit(view?: ScheduleLaneView) {
    setDraft({ view: view ? { ...view, technicianIds: [...view.technicianIds], skillKeys: [...view.skillKeys] } : {
      id: crypto.randomUUID(), name: "", technicianIds: [], skillKeys: [],
    }, revision: board.revision, isNew: !view });
    setError(""); setNotice(""); setFailed(null);
  }
  async function commit(command: ScheduleViewCommand, revision: number) {
    if (disabled || inFlight.current) return;
    setError(""); setNotice(""); setFailed(null);
    if (revision !== board.revision) {
      setError("The board changed. Review latest board before saving this view or retrying this action.");
      if (command.type !== "saveScheduleView") setFailed({ command, revision });
      return;
    }
    inFlight.current = true; setSending(true);
    try {
      const confirmed = await save(command, revision);
      if (!confirmed) {
        setError("View change was not confirmed. Your draft is unchanged. Resolve the schedule error above; use Retry unconfirmed change there if offered, or retry here after review.");
        if (command.type !== "saveScheduleView") setFailed({ command, revision });
        return;
      }
      if (command.type === "saveScheduleView") setDraft(null);
      setNotice(command.type === "selectScheduleView" ? "Day timeline selection saved." : command.type === "deleteScheduleView" ? "Saved view deleted." : "View saved. Choose it above to apply it to the day timeline.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "View change failed. Review and try again.");
      if (command.type !== "saveScheduleView") setFailed({ command, revision });
    } finally { inFlight.current = false; setSending(false); }
  }
  return <section className={css.workspace} data-testid="schedule-views" aria-label="Saved day timeline views" aria-busy={sending}>
    <div className={css.toolbar}>
      <label className={css.picker}>Day timeline view
        <select value={selectedId ?? ""} disabled={disabled} data-testid="schedule-view-select"
          onChange={e => void commit({ type: "selectScheduleView", id: e.target.value || null }, board.revision)}>
          <option value="">All technicians</option>
          {selectedId && !selected && <option value={selectedId}>Unavailable saved view · {selectedId}</option>}
          {views.map(view => <option key={view.id} value={view.id}>{view.name}</option>)}
        </select>
      </label>
      <div className={css.actions}>
        <button type="button" disabled={disabled} data-testid="schedule-view-create" onClick={() => edit()}>Create view</button>
        <button type="button" disabled={disabled || !selected} data-testid="schedule-view-edit" onClick={() => selected && edit(selected)}>Edit view</button>
        <button type="button" disabled={disabled || !selected} data-testid="schedule-view-delete" onClick={() => {
          if (selected && window.confirm(`Delete “${selected.name}”? This removes the saved view, not technicians or jobs.`)) void commit({ type: "deleteScheduleView", id: selected.id }, board.revision);
        }}>Delete view</button>
      </div>
    </div>
    <p className={css.scope}>Saved selection applies only to day technician lanes. Bays / equipment, work queue, RO search, job details, week overview and availability remain unrestricted. All technicians includes the full roster.</p>
    {draft && <form className={css.editor} data-testid="schedule-view-form" onSubmit={e => {
      e.preventDefault();
      if (!draft.view.name.trim()) { setError("Enter a name for this view."); return; }
      if (!draft.view.technicianIds.length && !draft.view.skillKeys.length) { setError("Choose at least one technician or confirmed skill. Use All technicians above for the full roster."); return; }
      void commit({ type: "saveScheduleView", view: { ...draft.view, name: draft.view.name.trim() } }, draft.revision);
    }}>
      <div className={styles.row}><h3>{draft.isNew ? "Create day timeline view" : "Edit day timeline view"}</h3><small>Unsaved draft · revision {draft.revision}</small></div>
      <label className={css.name}>View name<input required maxLength={60} value={draft.view.name} disabled={disabled} data-testid="schedule-view-name"
        onChange={e => setDraft({ ...draft, view: { ...draft.view, name: e.target.value } })} placeholder="e.g. Diagnostics & handoffs" /></label>
      <p className={css.scope}>Show active technicians explicitly checked below <strong>OR</strong> active technicians with any chosen current manager-confirmed skill. Skills expand the roster; they do not narrow explicit choices. Historical or not-qualified skills never match.</p>
      <div className={css.choices}>
        <fieldset className={css.group} disabled={disabled}><legend>Explicit technician roster</legend><small>Inactive and missing selections are retained for review, but never shown as lanes in a saved view.</small>
          <div className={css.list}>{board.technicians.map(t => <label className={css.choice} key={t.id}>
            <input type="checkbox" checked={draft.view.technicianIds.includes(t.id)} data-testid={`schedule-view-technician-${t.id}`}
              onChange={() => setDraft({ ...draft, view: { ...draft.view, technicianIds: toggle(draft.view.technicianIds, t.id) } })} />
            <span>{t.name}{!t.active && <small>Inactive · will not show</small>}</span>
          </label>)}{missingIds.map(id => <label className={css.choice} key={id}>
            <input type="checkbox" checked onChange={() => setDraft({ ...draft, view: { ...draft.view, technicianIds: toggle(draft.view.technicianIds, id) } })} />
            <span>{id}<small>Missing technician · retained selection; uncheck to remove</small></span>
          </label>)}{!board.technicians.length && !missingIds.length && <small>No technicians yet. Add the roster in Management.</small>}</div>
        </fieldset>
        <fieldset className={css.group} disabled={disabled}><legend>Current confirmed skill choices</legend><small>Matches update with manager-confirmed skills and technician activity.</small>
          <div className={css.list}>{skillKeys.map(key => <label className={css.choice} key={key}>
            <input type="checkbox" checked={draft.view.skillKeys.includes(key)} data-testid={`schedule-view-skill-${key}`}
              onChange={() => setDraft({ ...draft, view: { ...draft.view, skillKeys: toggle(draft.view.skillKeys, key) } })} />
            <span>{skills.get(key)?.title ?? key}<small>{key} · {skills.get(key)?.count ?? 0} active confirmed{!skills.has(key) ? " · stale selection; uncheck to remove" : ""}</small></span>
          </label>)}{!skillKeys.length && <small>No current confirmed skills. Confirm skills in Management, or choose technicians explicitly.</small>}</div>
        </fieldset>
      </div>
      <div className={css.summary} data-testid="schedule-view-preview"><strong>{preview.length} matching active technicians</strong>{preview.length ? ` · ${preview.map(t => t.name).join(", ")}` : " · This view will show no lanes. The queue and job search will still be available."}</div>
      <small>Draft revision {draft.revision} · latest {board.revision}. Review adopts the latest revision without discarding your choices.</small>
      <div className={css.actions}>
        <button className={styles.primary} type="submit" disabled={disabled || draft.revision !== board.revision} data-testid="schedule-view-save">{sending ? "Saving view…" : "Save view"}</button>
        <button type="button" disabled={disabled} data-testid="schedule-view-review" onClick={() => { setDraft({ ...draft, revision: board.revision }); setError(""); setNotice(`View draft reviewed against revision ${board.revision}. Save explicitly to apply.`); }}>Review latest board</button>
        <button type="button" disabled={disabled} onClick={() => { setDraft(null); setError(""); }}>Cancel edit</button>
      </div>
    </form>}
    {error && <div role="alert" className={styles.error} data-testid="schedule-view-error">{error}</div>}
    {failed && <div className={css.actions}>
      <button type="button" disabled={disabled || failed.revision !== board.revision} onClick={() => void commit(failed.command, failed.revision)}>Retry view action</button>
      <button type="button" disabled={disabled} onClick={() => { setFailed({ ...failed, revision: board.revision }); setError(""); setNotice("Action reviewed against latest board. Retry explicitly to apply."); }}>Review action against latest board</button>
      <button type="button" disabled={disabled} onClick={() => { setFailed(null); setError(""); }}>Dismiss failed action</button>
    </div>}
    {notice && <div role="status" className={styles.brandingInfo}>{notice}</div>}
  </section>;
}
