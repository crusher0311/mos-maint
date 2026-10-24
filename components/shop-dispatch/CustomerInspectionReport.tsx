"use client";
import type { CSSProperties } from "react";
import type { CustomerReport } from "@/lib/auto-dvi/release/model";
import ui from "./ReleasePanel.module.css";

/** A single allow-listed renderer for staff previews and the customer page. */
export function CustomerInspectionReport({ report, mediaUrls = {}, version }: {
  report: CustomerReport; mediaUrls?: Record<string, string>; version?: number;
}) {
  return <article data-theme-surface="light" className={ui.report} style={{ "--report-brand": /^#[a-f0-9]{6}$/i.test(report.branding.primary) ? report.branding.primary : "#285746" } as CSSProperties} aria-label="Customer findings report">
    <header>
      {report.branding.logo && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(report.branding.logo) && <img src={report.branding.logo} alt={`${report.branding.name} logo`} />}
      <div className={ui.eyebrow}>{report.branding.name}</div>
      <h2>Your inspection findings</h2>
      <small>{version !== undefined ? `Published version ${version} · ` : ""}Findings only</small>
      {report.branding.phone && <p>Shop phone: {report.branding.phone}</p>}
      <p>{report.progress === "inspection-in-progress" ? "Inspection is in progress. These are selected findings, not a completed vehicle assessment." : "These are selected inspection findings, not a complete vehicle assessment."}</p>
    </header>
    {report.concerns.length > 0 && <section><h3>Your concerns, in your words</h3>{report.concerns.map(concern => <blockquote key={concern.id}>{concern.words}</blockquote>)}</section>}
    {!report.findings.length && <p className={ui.empty}>No findings are included in this report.</p>}
    {report.findings.map((finding, index) => <section key={finding.key}>
      <small>Finding {String(index + 1).padStart(2, "0")}</small>
      <h3>{finding.title}{finding.position ? ` · ${finding.position}` : ""}</h3>
      <span className={ui.rating} data-rating={finding.rating}>{finding.rating === "red" ? "Urgent attention" : finding.rating === "yellow" ? "Attention recommended" : "Satisfactory"}</span>
      <p><small>Procedure: {finding.procedure}</small></p>
      <p className={ui.copy}>{finding.customerText}</p>
      {finding.measurements.length > 0 && <dl className={ui.measurements}>{finding.measurements.map((measurement, i) => <div key={`${measurement.label}-${i}`}><dt>{measurement.label}</dt><dd>{measurement.value}{measurement.unit ? ` ${measurement.unit}` : ""}</dd></div>)}</dl>}
      {finding.nextStep && <><h4>Suggested next step</h4><p className={ui.copy}>{finding.nextStep}</p></>}
      {finding.concernIds.map(id => {
        const concern = report.concerns.find(entry => entry.id === id);
        return concern ? <div key={id}><small>Related to your concern</small><blockquote>{concern.words}</blockquote></div> : null;
      })}
      {finding.photoIds.length > 0 && <div className={ui.reportPhotos}>{finding.photoIds.map((id, i) => mediaUrls[id] ? <img key={id} src={mediaUrls[id]} alt={`Evidence photo ${i + 1} for ${finding.title}`} loading="lazy" /> : <p key={id}><small>Evidence photo not loaded.</small></p>)}</div>}
    </section>)}
    <footer>This report shares findings only. It is not a repair authorization, an estimate, or a vehicle safety clearance. Contact the shop to discuss next steps. Publishing this report does not send it, synchronize it with another provider, or authorize work.</footer>
  </article>;
}
