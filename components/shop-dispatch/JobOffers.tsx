"use client";
import type { Board } from "@/lib/shop-dispatch/model";
import { recommendJobOptions } from "@/lib/shop-dispatch/job-offers";
import { dateLabel } from "./helpers";
import styles from "./pilot.module.css";

export function JobOffers({ board, jobId, now, canReview, review }: { board: Board; jobId: string; now: number; canReview: boolean; review: () => void }) {
  const result: { options: { technicianId: string; start: string; end: string; reasons: string[]; promiseImpact: string }[]; reasons: string[]; offer: string } = recommendJobOptions(board, jobId, now);
  return <details data-testid={`job-offers-${jobId}`}><summary>Review-only planning offers</summary>
    <p><strong>{result.offer}</strong></p><small>Advisory only. These options do not assign work, reserve capacity, authorize repairs or confirm a customer promise.</small>
    {result.reasons.length > 0 && <ul>{result.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}
    {result.options.map((option, index) => <section className={styles.notice} key={`${option.technicianId}-${index}`}>
      <strong>{board.technicians.find(t => t.id === option.technicianId)?.name ?? option.technicianId}</strong><p>{dateLabel(option.start)} – {dateLabel(option.end)}</p>
      <ul>{option.reasons.map((reason, i) => <li key={i}>{reason}</li>)}</ul><p><small>Promise impact: {option.promiseImpact}</small></p>
      {canReview && <button type="button" onClick={review}>Review in assignment & plan form</button>}
    </section>)}
    {!result.options.length && <div className={styles.empty}><strong>No supported option to recommend.</strong><p>Review the reasons and current plan manually. Missing evidence is not available capacity.</p>{canReview && <button type="button" onClick={review}>Review current plan</button>}</div>}
  </details>;
}
