"use client";
import { useState } from "react";
import { shopReadinessSummary, type SummaryItem, type SummaryMode } from "@/lib/shop-dispatch/readiness-summary";
import type { WorkProps } from "./JobCard";
import styles from "./pilot.module.css";

type Select = (visitId: string, jobId?: string) => void;
type ReadinessSummaryProps = Pick<WorkProps, "board" | "actor" | "now"> & { select: Select };
const PREVIEW_LIMIT = 2;

function SummaryEntry({ item, select }: { item: SummaryItem; select: Select }) {
  return <li>
    {item.visitId
      ? <button type="button" onClick={() => select(item.visitId!, item.jobId)}>{item.label} · Open {item.jobId ? "job" : "visit"}</button>
      : <strong>{item.label}</strong>}
    <details><summary>Readiness detail</summary><p>{item.detail}</p></details>
  </li>;
}

export function ReadinessSummary({ board, actor, now, select }: ReadinessSummaryProps) {
  const [mode, setMode] = useState<SummaryMode>("morning");
  if (!actor.manager) return null;
  const snapshot = shopReadinessSummary(board, mode, now);
  return <section className={styles.panel} data-testid="readiness-summary" aria-label="Shop readiness summary">
    <div className={styles.row}>
      <div><div className={styles.eyebrow}>Manager review · read-only</div><h2>Shop readiness summary</h2></div>
      <div className={styles.actions} role="group" aria-label="Readiness review mode">
        <button type="button" aria-pressed={mode === "morning"} className={mode === "morning" ? styles.primary : undefined} onClick={() => setMode("morning")}>Morning</button>
        <button type="button" aria-pressed={mode === "end-of-day"} className={mode === "end-of-day" ? styles.primary : undefined} onClick={() => setMode("end-of-day")}>End of day</button>
      </div>
    </div>
    <p>Shop date: <strong>{snapshot.today ?? "Unknown"}</strong> · Timezone: <strong>{snapshot.timeZone ?? "Not configured"}</strong><br />
      Arrivals / capacity window: <strong>{snapshot.targetDate ?? "Unknown"}</strong></p>
    <p><small>Live snapshot, not a saved report. Changes with the current board and review time; nothing is assigned, saved or sent.</small></p>
    <details data-testid="readiness-summary-freshness">
      <summary>Snapshot freshness · timestamps and coverage</summary>
      <p><small>Review time: <time dateTime={snapshot.generatedAt}>{snapshot.generatedAt}</time><br />
        Board updated: {snapshot.updatedAt ? <time dateTime={snapshot.updatedAt}>{snapshot.updatedAt}</time> : "Unknown"}<br />
        Appointment snapshot fetched: {snapshot.appointmentFetchedAt ? <time dateTime={snapshot.appointmentFetchedAt}>{snapshot.appointmentFetchedAt}</time> : "Unknown / not fetched"}<br />
        Timestamps alone do not establish complete or fresh coverage. Missing, incomplete or stale coverage is listed separately as unknown below. This review does not refresh data.</small></p>
    </details>
    <p className={styles.warning}><strong>Dependency-only LOWER BOUND — not a full completion forecast.</strong><br />
      No known risk is not a delivery promise. Technician queues, shifts, appointments, resources and other uncertainty may change the outcome. This is a review aid, not automated dispatch.</p>
    {snapshot.sections.map(section => <section className={styles.rosterReview} key={section.id} data-testid={`readiness-summary-${section.id}`} aria-label={section.title}>
      <div className={styles.row}>
        <h3>{section.title}</h3>
        <span className={styles.chip}>{section.items.length} known · {section.unknown.length} unknown</span>
      </div>
      {section.items.length ? <>
        <ul>{section.items.slice(0, PREVIEW_LIMIT).map(item => <SummaryEntry key={item.id} item={item} select={select} />)}</ul>
        {section.items.length > PREVIEW_LIMIT && <details><summary>Show {section.items.length - PREVIEW_LIMIT} more known items</summary>
          <ul>{section.items.slice(PREVIEW_LIMIT).map(item => <SummaryEntry key={item.id} item={item} select={select} />)}</ul>
        </details>}
      </> : <p><small>No known items in this snapshot; unknown information may still need review.</small></p>}
      {!!section.unknown.length && <div className={styles.notice} data-testid={`readiness-summary-${section.id}-unknown`}>
        <strong>Unknown information · {section.unknown.length}</strong>
        <ul>{section.unknown.slice(0, PREVIEW_LIMIT).map((reason, index) => <li key={index}>{reason}</li>)}</ul>
        {section.unknown.length > PREVIEW_LIMIT && <details><summary>Show {section.unknown.length - PREVIEW_LIMIT} more unknowns</summary>
          <ul>{section.unknown.slice(PREVIEW_LIMIT).map((reason, index) => <li key={index}>{reason}</li>)}</ul>
        </details>}
      </div>}
    </section>)}
  </section>;
}
