"use client";

import { useEffect, useRef, useState } from "react";
import { CATALOG, type Sheet } from "@/lib/auto-dvi/visit-model";
import s from "./VisitInspection.module.css";

export function SheetEditor({ initial, busy, canSave, onClose, onSave }: {
  initial: Sheet | null; busy: boolean; canSave: boolean; onClose: () => void; onSave: (sheet: Sheet) => Promise<boolean>;
}) {
  const [name, setName] = useState(initial?.name || "");
  const [itemIds, setItemIds] = useState(initial?.itemIds || []);
  const [required, setRequired] = useState<Record<string, string[]>>(initial?.requiredFields || {});
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDivElement>(null);
  const dirty = useRef(false);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const busyRef = useRef(busy); busyRef.current = busy;
  const close = () => {
    if (!busyRef.current && (!dirty.current || window.confirm("Discard unsaved sheet changes?"))) closeRef.current();
  };
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLInputElement>("input")?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (!busyRef.current && (!dirty.current || window.confirm("Discard unsaved sheet changes?"))) closeRef.current();
      }
      if (event.key === "Tab") {
        const nodes = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)');
        if (!nodes?.length) return;
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); previous?.focus(); };
  }, []);
  return <div className={s.overlay}><div className={s.dialog} role="dialog" aria-modal="true" aria-labelledby="visit-sheet-title" ref={dialog}>
    <div className={`${s.row} ${s.spread}`}><h2 id="visit-sheet-title">{initial ? "Edit reusable sheet" : "Create inspection sheet"}</h2><button className={s.button} onClick={close} disabled={busy}>Close</button></div>
    <p className={s.muted}>Choose catalog items and required measurements. Saved sheets do not change any existing visit snapshot.</p>
    <label className={s.field}>Sheet name<input value={name} maxLength={100} onChange={e => { dirty.current = true; setName(e.target.value); }} /></label>
    <div className={s.catalog}>{CATALOG.map(item => <div className={s.catalogItem} key={item.id}>
      <label className={s.check}><input type="checkbox" checked={itemIds.includes(item.id)} onChange={e => { dirty.current = true; setItemIds(ids => e.target.checked ? [...ids, item.id] : ids.filter(id => id !== item.id)); }} /><strong>{item.name}</strong></label>
      {itemIds.includes(item.id) && <div className={s.row}>{item.fields.map(field => <label className={s.check} key={field.id}>
        <input type="checkbox" checked={(required[item.id] || []).includes(field.id)} onChange={e => {
          dirty.current = true;
          setRequired(prev => ({ ...prev, [item.id]: e.target.checked ? [...(prev[item.id] || []), field.id] : (prev[item.id] || []).filter(id => id !== field.id) }));
        }} /> Require {field.label}{field.unit ? ` (${field.unit})` : ""}
      </label>)}</div>}
    </div>)}</div>
    {error && <div className={s.error} role="alert">{error}</div>}
    {!canSave && <div className={s.notice}>Sheet management is no longer authorized. Your changes remain here, but saving is disabled.</div>}
    <div className={s.row}><button className={`${s.button} ${s.primary}`} disabled={busy || !canSave} onClick={async () => {
      if (!name.trim() || !itemIds.length) { setError("Enter a name and select at least one inspection item."); return; }
      const sheet: Sheet = {
        id: initial?.id || `custom-${crypto.randomUUID()}`, name: name.trim(), itemIds,
        requiredFields: Object.fromEntries(itemIds.map(id => [id, required[id] || []])),
      };
      if (await onSave(sheet)) { dirty.current = false; onClose(); }
    }}>{busy ? "Saving…" : "Save reusable sheet"}</button><button className={s.button} disabled={busy} onClick={close}>Cancel</button></div>
  </div></div>;
}
