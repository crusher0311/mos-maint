"use client";
import { useStaffInspection } from "./use-staff-inspection";
import styles from "./pilot.module.css";

/** Availability comes from the inspection endpoint, never the workflow role or shop ID. */
export function DviEntry({ visitId, shopId, closed, busy, onOpen }: {
  visitId: string; shopId?: number; closed: boolean; busy: boolean; onOpen: () => void;
}) {
  if (closed) return null;
  return <OpenDviEntry visitId={visitId} shopId={shopId} busy={busy} onOpen={onOpen} />;
}
function OpenDviEntry({ visitId, shopId, busy, onOpen }: {
  visitId: string; shopId?: number; busy: boolean; onOpen: () => void;
}) {
  const api = useStaffInspection(visitId, shopId);
  if (api.loading) return <small role="status">Checking DVI access…</small>;
  if (!api.data) return <span className={styles.actions}><small>DVI availability could not be checked.</small><button type="button" disabled={busy} onClick={() => void api.reload()}>Check DVI access again</button></span>;
  if (!api.data.enabled || !api.data.canEdit || api.data.record?.closed) return null;
  return <button type="button" className={styles.primary} data-testid={`dvi-entry-${visitId}`} disabled={busy} onClick={onOpen}>
    {api.data.inspection || api.data.bindingRequest ? "Continue DVI" : "Start DVI"}
  </button>;
}
