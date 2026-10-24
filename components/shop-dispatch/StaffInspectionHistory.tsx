"use client";
import {useState} from "react";
import type {inspectionHistory} from "@/lib/auto-dvi/staff/history";
import styles from "./pilot.module.css";
type History = Awaited<ReturnType<typeof inspectionHistory>>;
export function StaffInspectionHistory({visitId}: {visitId: string}) {
  const [data, setData] = useState<History | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true); setError(""); setData(null);
    try {
      const response = await fetch(`/api/shop-dispatch/inspection/history?${new URLSearchParams({visitId})}`, {cache: "no-store"});
      const value = await response.json();
      if (!response.ok) throw Error(value.error || "Historical references unavailable");
      setData(value);
    } catch (cause) {setError(cause instanceof Error ? cause.message : "History unavailable");}
    finally {setBusy(false);}
  }
  return <details className={styles.panel}><summary>Historical inspection references · read only</summary>
    <p>Legacy records are not findings for this visit. Nothing here can be copied into current inspection evidence or exported as a new inspection.</p>
    <button disabled={busy} onClick={() => void load()}>{busy ? "Loading…" : "Load historical references"}</button>
    {error && <p role="alert">{error}</p>}
    {data && <><p>{data.notice}</p>{!data.rows.length && <p>No retained legacy or intermediate references found.</p>}
      {data.rows.map(row => <details key={row.id}><summary>{row.source} · {row.date || "Date unavailable"}</summary>
        {row.items.map(item => <section key={item.id}><h4>{item.title}</h4><p>Historical rating: {item.rating || "Not recorded"}</p>
          <p>{item.notes}</p><p>Historical recommendation: {item.recommendation || "None"}</p>
          <dl>{Object.entries(item.values).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl>
          {item.media.map(media => <a key={media.id} target="_blank" rel="noreferrer"
            href={`/api/shop-dispatch/inspection/history?${new URLSearchParams({visitId, recordId: row.id, mediaId: media.id})}`}>
            Open historical {media.kind}: {media.name || media.id}{" "}
          </a>)}
        </section>)}
      </details>)}</>}
  </details>;
}
