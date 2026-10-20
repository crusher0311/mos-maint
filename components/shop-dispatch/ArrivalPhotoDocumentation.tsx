"use client";
import { useEffect, useState } from "react";
import { safeLocalHref } from "../ro-session-store";
import styles from "./pilot.module.css";
import ui from "./StaffInspectionPanel.module.css";

type Photo = { id: string; mime: string; url: string };
export function ArrivalPhotoDocumentation({ visitId }: { visitId: string }) {
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
    <p><small>Advisor arrival photos only. These do not set ratings, satisfy required item photos, or count as saved checklist evidence. Evaluate each inspection item separately.</small></p>
    {loading ? <div className={styles.skeleton} role="status" aria-label="Loading arrival photos" /> :
      error ? <div role="alert"><p className={styles.error}>{error}</p><button onClick={() => setAttempt(value => value + 1)}>Retry arrival photos</button></div> :
        photos.length ? <ul className={ui.photos}>{photos.map((photo, index) => <li key={photo.id}>
          <a href={photo.url} target="_blank" rel="noreferrer"><img src={photo.url} loading="lazy" alt={`Vehicle arrival documentation ${index + 1}`} />Open arrival photo {index + 1}</a>
        </li>)}</ul> : <div className={styles.empty}><strong>No arrival photos attached</strong><p><small>Continue the inspection normally. Arrival documentation is optional and separate from checklist requirements.</small></p></div>}
  </details>;
}
