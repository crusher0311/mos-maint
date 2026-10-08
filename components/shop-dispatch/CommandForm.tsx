"use client";
import { useState, type FormEvent, type ReactNode } from "react";
import styles from "./pilot.module.css";

export function CommandForm({ children, submit, busy, testId, label = "Save", reset = false, creation = false,
  revision, pinnedRevision, onPinRevision, onReload }: {
  children: ReactNode; submit: (data: FormData, expectedRevision?: number) => Promise<boolean>; busy: boolean;
  testId: string; label?: string; reset?: boolean; creation?: boolean;
  revision?: number; pinnedRevision?: number;
  onPinRevision?: (revision: number) => void; onReload?: () => void;
}) {
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [creationId, setCreationId] = useState(() => creation ? crypto.randomUUID() : "");
  const [baseRevision, setBaseRevision] = useState(revision);
  const [reloadVersion, setReloadVersion] = useState(0);
  const expectedRevision = pinnedRevision ?? baseRevision;
  function pin(value: number) {
    setBaseRevision(value);
    onPinRevision?.(value);
  }
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setSending(true); setMessage("");
    try {
      const ok = await submit(new FormData(form), expectedRevision);
      setMessage(ok ? "Saved to the pilot." : "Not saved. Entries and their base revision are preserved. After a conflict, refresh the board, then explicitly reload this form to review latest values before resubmitting.");
      if (ok && expectedRevision !== undefined) pin(expectedRevision + 1);
      if (ok && reset) {
        form.reset();
        // Keep the same creation identity across failed/uncertain saves, but
        // generate a fresh one after confirmed success for the next record.
        if (creation) setCreationId(crypto.randomUUID());
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : "Check your entries and try again."); }
    finally { setSending(false); }
  }
  return <form className={styles.form} data-testid={testId} onSubmit={onSubmit}>
    {creation && <input type="hidden" name="creationId" value={creationId} readOnly />}
    {revision !== undefined && <div className={styles.actions}>
      <small data-testid={`${testId}-base-revision`}>Form base revision {expectedRevision} · latest snapshot {revision}. Refreshing the board does not rebase this draft.</small>
      <button type="button" disabled={busy || sending} data-testid={`${testId}-reload`} onClick={() => {
        if (!window.confirm("Discard this form’s entries and reload the latest fetched values? Refresh the board first if needed.")) return;
        onReload?.();
        pin(revision);
        setReloadVersion(value => value + 1);
        setMessage("Latest fetched values loaded. Review before saving.");
      }}>Reload latest form</button>
    </div>}
    <fieldset key={reloadVersion} disabled={busy || sending} style={{ border: 0, padding: 0, margin: 0, minWidth: 0, display: "grid", gap: 14 }}>{children}
      <div className={styles.actions}><button className={styles.primary} type="submit">{sending ? "Saving…" : label}</button><small role="status">{message}</small></div>
    </fieldset>
  </form>;
}
