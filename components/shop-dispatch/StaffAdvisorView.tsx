"use client";
import { missingFor, type StaffInspection, type StaffItem, type Finding } from "@/lib/auto-dvi/staff/model";
import { captureKind } from "./StaffCaptureEditor";
import ui from "./StaffInspectionPanel.module.css";

const captureLabels: Record<string, string> = {
  actualSize: "Actual tire size", oeSize: "OE tire size", unit: "Tread unit",
  inner: "Inner tread", center: "Center tread", outer: "Outer tread",
  beforePsi: "Before pressure", afterPsi: "After pressure (optional)", availability: "Measurement availability",
  reason: "Unable reason", rated: "Rated battery value", measured: "Measured battery value",
  ratedStandard: "Rated standard", measuredStandard: "Measured standard", outcome: "Manual test outcome",
  voltage: "Measured voltage", terminals: "Terminal condition",
};
const valueLabels: Record<string, string> = {
  "unable-to-measure": "Unable to measure", "unable-to-test": "Unable to test",
  "not-tested": "Not tested", measured: "Measured", pass: "Pass", fail: "Fail",
};
const displayValue = (value: string | number) => valueLabels[String(value)] ?? String(value);

function SavedMeasurements({ item, finding }: { item: StaffItem; finding: Finding }) {
  const kind = captureKind(item);
  const entries = Object.entries(finding.values).filter(([, value]) => value !== "");
  if (!entries.length) return <p>No measurements saved.</p>;
  return <dl className={ui.measurements}>{entries.map(([key, value]) => {
    const field = item.fields.find(field => field.id === key);
    let unit = field?.unit ?? "";
    if (kind === "tire-v1") {
      if (["inner", "center", "outer"].includes(key)) unit = String(finding.values.unit || "unit not recorded");
      if (["beforePsi", "afterPsi"].includes(key)) unit = "PSI";
    }
    if (kind === "battery-v1") {
      if (key === "rated") unit = String(finding.values.ratedStandard || "standard not recorded");
      if (key === "measured") unit = String(finding.values.measuredStandard || "standard not recorded");
      if (key === "voltage") unit = "V";
    }
    return <div key={key}><dt>{(kind && captureLabels[key]) || field?.label || key}</dt><dd>{displayValue(value)}{unit ? ` ${unit}` : ""}</dd></div>;
  })}</dl>;
}

export function StaffAdvisorView({ inspection, visitId }: { inspection: StaffInspection; visitId: string }) {
  const active = inspection.sheets.filter(sheet => sheet.active);
  const proposals = active.flatMap(sheet => sheet.sheet.items.flatMap(item => {
    const finding = sheet.results[item.id];
    return finding?.recommendation.trim() ? [{ sheet, item, finding }] : [];
  }));
  return <section className={ui.advisor} aria-label="Advisor saved evidence overview">
    <div className={ui.advisorIntro}><h3>Advisor overview · saved evidence only</h3>
      <p>All active items, including green findings. Drafts are not shown. Reviewing this view does not mark readiness, record advisor review, authorize work, or release the vehicle.</p>
    </div>
    {!active.length && <p>No active sheets. Saved evidence on inactive sheets remains available in the inspection editor.</p>}
    {active.map(sheet => <section key={sheet.key} className={ui.sheet} aria-label={`${sheet.sheet.name} saved findings`}>
      <h3>{sheet.sheet.name} <small>v{sheet.sheet.version} · Active</small></h3>
      {sheet.sheet.items.map(item => {
        const finding = sheet.results[item.id];
        const missing = missingFor(item, finding);
        const rating = finding?.rating;
        const ratingLabel = rating === "green" ? "Green · satisfactory" : rating === "yellow" ? "Yellow · attention" : rating === "red" ? "Red · urgent" : rating === "na" ? "N/A" : "Not evaluated";
        const mismatch = captureKind(item) === "battery-v1" && finding?.values.ratedStandard && finding.values.measuredStandard && finding.values.ratedStandard !== finding.values.measuredStandard;
        return <article key={item.id} className={ui.item}>
          <div className={ui.findingHeading}><h4>{item.name}{item.position ? ` · ${item.position.toUpperCase()}` : ""}</h4><span className={ui.ratingBadge} data-rating={rating ?? "none"}>{ratingLabel}</span></div>
          <small>{item.required ? "Required" : "Optional"} · {finding ? "Saved evidence" : "Not recorded"}</small>
          {!!missing.length && <p className={ui.missing}>Missing from saved evidence: {missing.join(" · ")}</p>}
          {finding ? <>
            <SavedMeasurements item={item} finding={finding} />
            {mismatch && <p className={ui.missing}>Rated and measured standards differ. No direct comparison or automatic outcome.</p>}
            {finding.naReason && <p className={ui.savedText}><strong>N/A reason: </strong>{finding.naReason}</p>}
            <p className={ui.savedText}><strong>Evaluation notes: </strong>{finding.notes || "No notes saved."}</p>
            <small className={ui.metadata}>Last item save: {finding.actor} · {new Date(finding.at).toLocaleString()}</small>
            <h5>Saved inspection photos · {finding.photos.length}</h5>
            {!finding.photos.length && <p>No inspection photos saved.</p>}
            <ul className={ui.photos}>{finding.photos.map(photo => {
              const url = `/api/shop-dispatch/inspection/media?${new URLSearchParams({ visitId, sheet: sheet.key, item: item.id, mediaId: photo.id })}`;
              return <li key={photo.id}><a href={url} target="_blank" rel="noreferrer"><img src={url} alt={`Saved evidence for ${item.name}`} loading="lazy" />Open saved photo</a><small>Saved · {photo.provenance}<br />{photo.actor} · {new Date(photo.at).toLocaleString()}</small></li>;
            })}</ul>
            {!!finding.arrivalPhotos?.length && <>
              <h5>Associated arrival documentation</h5><p>Arrival photos are separate from inspection capture and do not satisfy required inspection photos.</p>
              <ul className={ui.photos}>{finding.arrivalPhotos.map(photo => {
                const url = `/api/dashboard/protractor/arrival-photos?${new URLSearchParams({ visitId, mediaId: photo.id })}`;
                return <li key={photo.id}><a href={url} target="_blank" rel="noreferrer"><img src={url} alt={`Arrival documentation associated with ${item.name}`} loading="lazy" />Open arrival photo</a><small>Arrival saved {new Date(photo.capturedAt).toLocaleString()}<br />Associated by {photo.actor} · {new Date(photo.at).toLocaleString()}</small></li>;
              })}</ul>
            </>}
          </> : <p>No saved evaluation for this item.</p>}
        </article>;
      })}
    </section>)}
    <section className={ui.proposed} aria-label="Proposed work from saved recommendations">
      <h3>Proposed work</h3><p><strong>Proposed only—not authorized or performed.</strong> These are saved recommendations, not work orders or approval records.</p>
      {proposals.length ? proposals.map(({ sheet, item, finding }) => <article key={`${sheet.key}/${item.id}`}>
        <h4>{item.name}{item.position ? ` · ${item.position.toUpperCase()}` : ""}</h4><small>{sheet.sheet.name} · v{sheet.sheet.version}</small>
        <p className={ui.savedText}>{finding.recommendation}</p>
      </article>) : <p>No proposed work in saved active-sheet recommendations.</p>}
    </section>
  </section>;
}
