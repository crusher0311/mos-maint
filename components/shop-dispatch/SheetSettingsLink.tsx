"use client";
import Link from "next/link";
import { useSheetCatalog } from "./use-sheet-catalog";
import styles from "./sheet-manager.module.css";

/** Discoverability uses the DVI endpoint's permission, never workflow or manager role. */
export function SheetSettingsLink() {
  const api = useSheetCatalog();
  if (api.forbidden || api.loading) return null;
  if (!api.data) return api.error ? <div className={styles.workspace}><div className={styles.notice}>
    <p>Inspection checklist access could not be checked. This is not a permission decision.</p>
    <button onClick={() => void api.reload()}>Retry checklist access</button>
  </div></div> : null;
  return <section className={styles.workspace} aria-label="Reusable DVI checklists"><div className={styles.hero}>
    <div className={styles.row}><div><div className={styles.eyebrow}>DVI / {api.data.scopeLabel}</div><h2>Reusable inspection sheets</h2></div>
      <Link href="/dashboard/settings/dvi-sheets" className={styles.settingsLink}>View inspection sheets</Link></div>
    <p>{api.data.canManage ? "Create and publish versioned checklists for your technicians." : "Preview approved checklists maintained by your managing organization."} This library is separate from service-recommendation mappings below.</p>
    {!api.data.inspectionEnabled && <small>Technician inspections are disabled. Managing checklists does not change rollout or enable new inspections.</small>}
  </div></section>;
}
