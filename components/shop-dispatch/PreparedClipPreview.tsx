"use client";
import {useEffect, useState} from "react";
import ui from "./SilentClips.module.css";

/** Only the authorized, prepared-media endpoint is eligible for a staff preview. */
export function PreparedClipPreview({visitId, recordingId, mediaId, caption}: {
  visitId: string; recordingId: string; mediaId: string; caption: string;
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true, owned = "";
    const controller = new AbortController();
    setUrl(""); setError(false);
    void fetch(`/api/shop-dispatch/inspection/recordings?${new URLSearchParams({visitId, id: recordingId, mediaId})}`,
      {credentials: "include", cache: "no-store", signal: controller.signal})
      .then(async response => {
        if (!response.ok) throw Error("Preview unavailable");
        const blob = await response.blob();
        if (blob.type !== "video/mp4") throw Error("Expected silent MP4");
        if (active) {owned = URL.createObjectURL(blob); setUrl(owned);}
      }).catch(() => {if (active) setError(true);});
    return () => {active = false; controller.abort(); if (owned) URL.revokeObjectURL(owned);};
  }, [visitId, recordingId, mediaId, attempt]);
  return <figure className={ui.clip}>
    {url ? <video className={ui.video} src={url} controls muted playsInline preload="metadata" aria-label={caption}
      onError={() => setError(true)}>Video unavailable. Read the caption below.</video> :
      !error && <p role="status">Loading prepared silent clip…</p>}
    <figcaption>{caption}</figcaption>
    {error && <p role="alert">Clip preview unavailable. <button type="button" onClick={() => setAttempt(value => value + 1)}>Retry preview</button></p>}
  </figure>;
}
