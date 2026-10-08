"use client";
import type { Board } from "@/lib/shop-dispatch/model";
import { dateLabel } from "./helpers";
import styles from "./pilot.module.css";

export function AuditView({ board }: { board: Board }) {
  function download() {
    const blob = new Blob([JSON.stringify({ revision: board.revision, updatedAt: board.updatedAt, audit: board.audit }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url; link.download = `dispatch-audit-r${board.revision}.json`; link.click(); URL.revokeObjectURL(url);
  }
  return <section className={styles.panel}><div className={styles.row}><h2>Dispatch audit</h2><button onClick={download} data-testid="audit-download">Download local JSON</button></div>
    <p><small>Actor and changes recorded by the server · revision {board.revision}. Download stays on this device and may contain employee or operational details; store it securely.</small></p>
    {!board.audit.length ? <div className={styles.empty}>No recorded changes yet. Saved pilot actions will appear here.</div> :
      <div className={styles.audit}><table><thead><tr><th>Time</th><th>Actor</th><th>Action / target</th><th>Details</th></tr></thead><tbody>{[...board.audit].reverse().map((a, i) => <tr key={`${a.at}-${i}`}><td>{dateLabel(a.at)}</td><td>{a.actor}</td><td>{a.action}<br /><small>{a.target}</small></td><td>{a.detail || "—"}</td></tr>)}</tbody></table></div>}
  </section>;
}
