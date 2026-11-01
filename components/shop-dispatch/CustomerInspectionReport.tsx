"use client";
import {useEffect, useId, useRef, useState, type CSSProperties} from "react";
import type { CustomerReport } from "@/lib/auto-dvi/release/model";
import ui from "./ReleasePanel.module.css";
import clipUi from "./SilentClips.module.css";

/** A single allow-listed renderer for staff previews and the customer page. */
export function CustomerInspectionReport({ report, mediaUrls = {}, version }: {
  report: CustomerReport; mediaUrls?: Record<string, string>; version?: number;
}) {
  const [playback, setPlayback] = useState<{id: string; serial: number} | null>(null);
  const [playError, setPlayError] = useState("");
  const player = useRef<HTMLVideoElement>(null);
  const captionId = useId();
  const playAll = useRef(false);
  const ordered = [...report.findings].sort((a, b) =>
    Number(!!b.concernIds.length) - Number(!!a.concernIds.length) ||
    ({red: 0, yellow: 1, green: 2}[a.rating] - {red: 0, yellow: 1, green: 2}[b.rating]));
  const playlist = ordered.flatMap(finding => (finding.clips ?? []).map(clip => ({...clip, title: finding.title})));
  const current = playlist.find(clip => clip.id === playback?.id);
  useEffect(() => {
    playAll.current = false; setPlayback(null); setPlayError("");
  }, [report]);
  useEffect(() => {
    const video = player.current;
    if (!video || !playback) return;
    let active = true;
    video.muted = true;
    video.currentTime = 0;
    try {
      void video.play().catch(() => {
        if (active) {playAll.current = false; setPlayError("Playback could not start. Choose a clip to retry, or read the finding and caption below.");}
      });
    } catch {
      playAll.current = false; setPlayError("Playback is unavailable. Read the caption, finding and photos below.");
    }
    return () => {active = false; video.pause();};
  }, [playback]);
  function select(id: string, all = false) {
    playAll.current = all; setPlayError("");
    setPlayback(previous => ({id, serial: (previous?.serial ?? 0) + 1}));
  }
  function ended() {
    if (!playAll.current) return;
    const index = playlist.findIndex(clip => clip.id === playback?.id);
    const next = playlist.slice(index + 1).find(clip => mediaUrls[clip.id]);
    if (next) select(next.id, true);
    else {playAll.current = false; setPlayError("All available silent clips have finished. You can replay any clip below.");}
  }
  const group = (finding: CustomerReport["findings"][number]) => finding.concernIds.length ? "Related to your concerns" :
    finding.rating === "red" ? "Urgent attention" : finding.rating === "yellow" ? "Attention recommended" : "Satisfactory";
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
    {!!playlist.length && <section aria-label="Silent inspection clips">
      <h3>See the selected findings</h3>
      <p>Silent videos with reviewed captions. Nothing plays until you choose. The complete text and available photos remain below.</p>
      <div className={clipUi.playback}>
        <button type="button" disabled={!playlist.some(clip => mediaUrls[clip.id])}
          onClick={() => {const first = playlist.find(clip => mediaUrls[clip.id]); if (first) select(first.id, true);}}>Play All silent clips</button>
        {playback && <button type="button" onClick={() => {playAll.current = false; setPlayback(null); setPlayError("");}}>Stop playback</button>}
      </div>
      {current && mediaUrls[current.id] && <figure className={clipUi.clip}>
        <video key={current.id} ref={player} className={clipUi.video} src={mediaUrls[current.id]} controls muted playsInline preload="none"
          aria-label={`Silent clip: ${current.title}`} aria-describedby={captionId} onEnded={ended}
          onError={() => {playAll.current = false; setPlayError("This clip could not be played. Choose another clip or use the caption, text and photos below.");}}>
          Video playback unavailable. Read the caption and finding below.
        </video>
        <figcaption id={captionId}>{current.caption}</figcaption>
      </figure>}
      {playError && <p role="status">{playError}</p>}
    </section>}
    {!report.findings.length && <p className={ui.empty}>No findings are included in this report.</p>}
    {ordered.map((finding, index) => <section key={finding.key}>
      {(index === 0 || group(ordered[index - 1]) !== group(finding)) && <h2>{group(finding)}</h2>}
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
      {finding.clips?.map((clip, i) => <figure key={clip.id} className={clipUi.clip}>
        <figcaption>{clip.caption}<small> · {clip.durationSeconds.toFixed(1)}s · silent</small></figcaption>
        {mediaUrls[clip.id] ? <button type="button" aria-label={`Play silent clip ${i + 1} for ${finding.title}`}
          onClick={() => select(clip.id)}>Play selected clip</button> : <p><small>Video not loaded. Use this caption, the finding text and any photos above.</small></p>}
      </figure>)}
    </section>)}
    <footer>This report shares findings only. It is not a repair authorization, an estimate, or a vehicle safety clearance. Contact the shop to discuss next steps. Publishing this report does not send it, synchronize it with another provider, or authorize work.</footer>
  </article>;
}
