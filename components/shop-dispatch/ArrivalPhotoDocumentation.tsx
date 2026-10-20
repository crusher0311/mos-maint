"use client";
import { useEffect, useState } from "react";
import { safeLocalHref } from "../ro-session-store";
import styles from "./pilot.module.css";
import ui from "./StaffInspectionPanel.module.css";

type Photo = { id: string; mime: string; url: string };
export function ArrivalPhotoDocumentation({ visitId, targets = [], disabled = true, onAssociate }: {
  visitId: string; targets?: {key: string; label: string; associated: string[]}[];
  disabled?: boolean; onAssociate?: (target: string, mediaId: string) => void;
}) {
  const [target, setTarget] = useState("");
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(""); setPhotos([]);
    void (async () => {
      try {
        const response = await fetch(`/api/dashboard/protractor/arrival-photos?${new URLSearchParams({ visitId })}`, {
          credentials: "include", cache: "no-store", signal: controller.signal,
        });
        const data = await response.json();
        if (!response.ok || !Array.isArray(data.photos) || !data.photos.every((photo: Photo) =>
          photo && typeof photo.id === "string" && ["image/jpeg", "image/png", "image/webp"].includes(photo.mime) && safeLocalHref(photo.url)))
          throw new Error("Arrival documentation could not be loaded. Inspection findings are unchanged.");
        if (!controller.signal.aborted) setPhotos(data.photos);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Arrival documentation unavailable.");
      } finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [visitId, attempt]);
  return <details className={styles.panel} data-testid="arrival-photo-documentation">
    <summary>Arrival documentation · {loading ? "loading" : error ? "unavailable" : `${photos.length} photo${photos.length === 1 ? "" : "s"}`}</summary>
    <p><small>Advisor arrival photos do not set ratings or satisfy required inspection photos. Save an item evaluation, then explicitly associate a relevant photo. Required measurements and notes remain unchanged.</small></p>
    {onAssociate && <label>Evaluated checklist item<select aria-label="Arrival photo checklist item" value={target} disabled={disabled} onChange={e => setTarget(e.target.value)}>
      <option value="">Choose a saved evaluation</option>{targets.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
    </select></label>}
    {loading ? <div className={styles.skeleton} role="status" aria-label="Loading arrival photos" /> :
      error ? <div role="alert"><p className={styles.error}>{error}</p><button onClick={() => setAttempt(value => value + 1)}>Retry arrival photos</button></div> :
        photos.length ? <ul className={ui.photos}>{photos.map((photo, index) => <li key={photo.id}>
          <a href={photo.url} target="_blank" rel="noreferrer"><img src={photo.url} loading="lazy" alt={`Vehicle arrival documentation ${index + 1}`} />Open arrival photo {index + 1}</a>
          {onAssociate && <button disabled={disabled || !targets.some(t => t.key === target) || targets.find(t => t.key === target)?.associated.includes(photo.id)}
            onClick={() => onAssociate(target, photo.id)}>{targets.find(t => t.key === target)?.associated.includes(photo.id) ? "Associated with selected item" : `Associate arrival photo ${index + 1}`}</button>}
        </li>)}</ul> : <div className={styles.empty}><strong>No arrival photos attached</strong><p><small>Continue the inspection normally. Arrival documentation is optional and separate from checklist requirements.</small></p></div>}
  </details>;
}
