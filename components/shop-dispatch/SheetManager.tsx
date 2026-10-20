"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { sheetSchema, type StaffItem, type StaffSheet } from "@/lib/auto-dvi/staff/model";
import { useSheetCatalog, type SheetCatalog, type SheetCommand } from "./use-sheet-catalog";
import styles from "./sheet-manager.module.css";

const keyOf = (sheet: StaffSheet) => `${sheet.id}@${sheet.version}`;
const uniqueId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
const copy = <T,>(value: T): T => structuredClone(value);
const latestSheets = (sheets: StaffSheet[]) => [...sheets.reduce((map, sheet) => {
  if (!map.has(sheet.id) || map.get(sheet.id)!.version < sheet.version) map.set(sheet.id, sheet);
  return map;
}, new Map<string, StaffSheet>()).values()];
const blankItem = (): StaffItem => {
  const id = uniqueId("item");
  return { id, name: "", procedure: id, position: "", fields: [], required: true, requiredFields: [],
    notesRequired: false, photoRequired: false, recommendationRequired: false };
};

export function SheetManager({ api: supplied, onLockChange }: { api?: SheetCatalog; onLockChange?: (locked: boolean) => void }) {
  const local = useSheetCatalog(!supplied);
  const api = supplied ?? local;
  const { data, forbidden, loading, busy, pending, conflict, error, notice } = api;
  const [selection, setSelection] = useState("");
  const [draft, setDraft] = useState<StaffSheet | null>(null);
  const [makeDefault, setMakeDefault] = useState(false);
  const [validation, setValidation] = useState("");
  const [filter, setFilter] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [reuseKey, setReuseKey] = useState("");
  const [confirmation, setConfirmation] = useState<SheetCommand | null>(null);
  const locked = !!draft || !!pending || busy || conflict || !!confirmation;
  const lockCallback = useRef(onLockChange);
  lockCallback.current = onLockChange;
  useEffect(() => { lockCallback.current?.(locked); }, [locked]);
  useEffect(() => () => { lockCallback.current?.(false); }, []);
  useEffect(() => {
    if (!locked) return;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    // Prevent in-app links from silently destroying an unresolved draft/request.
    const leave = (event: MouseEvent) => {
      if ((event.target as Element)?.closest?.("a[href]")) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", leave, true);
    return () => { window.removeEventListener("beforeunload", unload); document.removeEventListener("click", leave, true); };
  }, [locked]);
  const latest = useMemo(() => latestSheets(data?.sheets ?? []), [data?.sheets]);
  const reusable = useMemo(() => [...(data?.sheets ?? []), ...(data?.templates ?? [])].flatMap((sheet, source) =>
    sheet.items.map(item => ({ key: `${source}/${keyOf(sheet)}/${item.id}`, sheet, item }))), [data?.sheets, data?.templates]);
  const selected = data?.sheets.find(sheet => keyOf(sheet) === selection) ??
    (selection.startsWith("template:") ? data?.templates.find(sheet => `template:${keyOf(sheet)}` === selection) : undefined) ??
    latest.find(sheet => !data?.archivedSheetIds.includes(sheet.id)) ?? latest[0] ?? data?.templates[0];
  const isTemplate = !!selected && !data?.sheets.includes(selected);
  const archived = !!selected && !!data?.archivedSheetIds.includes(selected.id) && !isTemplate;
  const isDefault = !!selected && data?.defaultSheet === keyOf(selected) && !isTemplate;
  const defaultFamily = data?.defaultSheet.split("@")[0];
  const editingBlocked = busy || !!pending || conflict || loading;

  function start(sheet?: StaffSheet, duplicate = false) {
    if (locked || !data?.canManage) return;
    setValidation(""); setReuseKey(""); setMakeDefault(false);
    if (!sheet) setDraft({ id: uniqueId("sheet"), version: 0, name: "", items: [] });
    else if (duplicate) setDraft({ ...copy(sheet), id: uniqueId("sheet"), version: 0, name: `${sheet.name.slice(0, 80)} (copy)` });
    else setDraft(copy(latest.find(value => value.id === sheet.id) ?? sheet));
  }
  function updateItem(index: number, patch: Partial<StaffItem>) {
    setDraft(previous => previous ? { ...previous, items: previous.items.map((item, i) => i === index ? { ...item, ...patch } : item) } : previous);
  }
  function moveItem(index: number, direction: number) {
    if (!draft) return;
    const items = [...draft.items];
    [items[index], items[index + direction]] = [items[index + direction], items[index]];
    setDraft({ ...draft, items });
  }
  async function save() {
    if (!draft || editingBlocked) return;
    const invalidChoices = draft.items.flatMap(item => item.fields.filter(field => field.type === "select" &&
      (!field.options?.length || field.options.some(option => !option.trim()) ||
        new Set(field.options).size !== field.options.length)).map(field => `${item.name || "Untitled item"} / ${field.label || "Untitled field"}: select options must be nonempty and unique.`));
    if (invalidChoices.length) { setValidation(invalidChoices.join(" · ")); return; }
    const result = sheetSchema.safeParse({ ...draft, version: Math.max(1, draft.version) });
    if (!result.success) {
      setValidation(result.error.issues.map(issue => `${issue.path.join(".") || "Sheet"}: ${issue.message}`).join(" · "));
      return;
    }
    setValidation("");
    // version is the expected base version; the server allocates the next immutable version.
    const receipt = await api.command({ type: "save", sheet: { ...result.data, version: draft.version }, makeDefault });
    if (receipt) {
      const saved = latestSheets(receipt.sheets).find(sheet => sheet.id === draft.id);
      if (saved) setSelection(keyOf(saved));
      setDraft(null);
    }
  }
  async function retry() {
    const receipt = await api.retry();
    if (receipt && draft) {
      const saved = latestSheets(receipt.sheets).find(sheet => sheet.id === draft.id);
      if (saved) setSelection(keyOf(saved));
      setDraft(null);
    }
    if (receipt) setConfirmation(null);
  }
  async function discard() {
    if (await api.discardAndReload()) { setDraft(null); setConfirmation(null); setValidation(""); setReuseKey(""); setMakeDefault(false); }
  }
  async function confirm() {
    if (!confirmation) return;
    const receipt = await api.command(confirmation);
    if (receipt) setConfirmation(null);
  }

  if (forbidden && !locked) return <section className={styles.workspace}><div className={styles.empty}><h2>Inspection sheets are not available</h2><p>Your signed-in account does not have DVI access for this location. No permissions were changed.</p></div></section>;
  return <section className={styles.workspace} data-testid="sheet-manager" aria-label="Inspection sheet management">
    <header className={styles.hero}>
      <div className={styles.row}><div><div className={styles.eyebrow}>DVI / approved checklist library</div><h2>Inspection sheets</h2></div>
        <span className={styles.badge}>{data ? `${data.scopeLabel} · ${data.scope === "enterprise" ? "Enterprise owned" : "Shop owned"}` : "Checking DVI access"}</span></div>
      <p>Define the checklist once. Keep the work already done.</p>
      <small>Managers publish new, immutable versions. Technicians use approved sheets; publishing, changing the default or archiving never rewrites sheets or findings already attached to a visit. Matching item, procedure, position and measurement identities allow same-visit reuse without repeating work.</small>
    </header>
    {error && <div className={styles.error} role="alert"><strong>{error}</strong>
      {!pending && !conflict && !draft && <div className={styles.actions}><button disabled={busy || loading} onClick={() => void api.reload()}>Retry loading sheets</button></div>}</div>}
    {pending && <div className={styles.notice} role="alert"><strong>{busy ? "Waiting for a save receipt." : "The last save is unconfirmed."}</strong><p>The exact request and draft are retained. Do not create another change or leave this workspace. Retry uses the same request ID and payload.</p>
      <button disabled={busy} onClick={() => void retry()}>Retry exact save</button></div>}
    {conflict && <div className={styles.notice} role="alert"><strong>The catalog changed. Your draft has not been rebased.</strong><p>Review or copy your draft below before explicitly discarding it. Reloading replaces the base revision; it does not merge changes.</p><button disabled={busy || loading} onClick={() => void discard()}>Discard draft and reload latest</button></div>}
    {notice && <div className={styles.notice} role="status">{notice}</div>}
    {validation && <div className={styles.error} role="alert">{validation}</div>}
    {!data ? loading ? <div aria-busy="true" aria-label="Loading inspection sheets"><div className={styles.skeleton} /><div className={styles.skeleton} /></div> :
      <div className={styles.empty}><h3>No catalog loaded</h3><p>A network error is not a permission decision. Retry to check DVI access again.</p></div> : <>
      {!data.canManage && <div className={styles.notice}><strong>Read-only · {data.scopeLabel} owns these definitions.</strong><p>{data.scope === "enterprise" ? "An enterprise manager maintains these approved templates. Local managers and technicians cannot change them here." : "Your account can preview approved sheets. A manager with sheet-management permission must publish changes."} Technician inspection access is separate from management access.</p></div>}
      {!data.inspectionEnabled && <div className={styles.notice}>Technician inspections are currently disabled. Publishing or managing sheets does not enable inspection admissions or change the DVI rollout. Catalog access and technician inspection access are separate.</div>}
      <div className={styles.row}><div className={styles.actions}><span className={styles.badge}>{latest.filter(sheet => !data.archivedSheetIds.includes(sheet.id)).length} active definitions</span><small>Catalog revision {data.revision}</small></div>
        <div className={styles.actions}><button disabled={locked || loading} onClick={() => void api.reload()}>Refresh catalog</button>{data.canManage && <button className={styles.primary} disabled={locked || loading} onClick={() => start()}>Create sheet</button>}</div></div>
      <p><small>The default starts new inspections only. Archived definitions and every approved version remain available for historical reference.</small></p>
      <div className={styles.layout}>
        <aside className={styles.library} aria-label="Sheet library">
          <label>Find sheet<input type="search" value={filter} disabled={locked} onChange={event => setFilter(event.target.value)} placeholder="Name or sheet ID" /></label>
          <label className={styles.check}><input type="checkbox" checked={showArchived} disabled={locked} onChange={event => setShowArchived(event.target.checked)} />Include archived definitions</label>
          {latest.filter(sheet => (showArchived || !data.archivedSheetIds.includes(sheet.id)) && `${sheet.name} ${sheet.id}`.toLowerCase().includes(filter.toLowerCase())).map(sheet =>
            <button key={sheet.id} className={styles.entry} disabled={locked} aria-pressed={!isTemplate && selected?.id === sheet.id} onClick={() => setSelection(keyOf(sheet))}>
              <strong>{sheet.name}</strong><small>v{sheet.version} · {sheet.items.length} items{data.archivedSheetIds.includes(sheet.id) ? " · Archived" : ""}</small>
              {defaultFamily === sheet.id && <span className={styles.badge}>Default: {data.defaultSheet}</span>}
            </button>)}
          {!latest.length && <div className={styles.empty}><strong>No approved sheets yet</strong><p>Start with a template or build a checklist.</p></div>}
          <h3>Starting templates</h3><small>Templates are not approved until a manager saves a sheet.</small>
          {data.templates.map(sheet => <button key={keyOf(sheet)} disabled={locked} className={styles.entry} aria-pressed={isTemplate && selected === sheet} onClick={() => setSelection(`template:${keyOf(sheet)}`)}><strong>{sheet.name}</strong><small>{sheet.items.length} reusable items · template</small></button>)}
        </aside>
        <div className={styles.panel}>
          {draft ? <>
            <div className={styles.row}><h3>{draft.version === 0 ? "New sheet" : `New version · based on v${draft.version}`}</h3><span className={styles.badge}>Unpublished draft</span></div>
            <p><small>Duplicating a sheet or copying reusable items retains their identities. For a genuinely different measurement, assign a new procedure and field identity. Changing meaning under an existing procedure may be rejected by the server.</small></p>
            <fieldset disabled={editingBlocked} className={styles.form}>
              <label>Sheet name<input maxLength={100} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
              <small className={styles.identity}>Sheet ID: {draft.id} · expected base version {draft.version}</small>
              <div className={styles.row}><h3>Checklist items · {draft.items.length}/60</h3><button disabled={draft.items.length >= 60} onClick={() => setDraft({ ...draft, items: [...draft.items, blankItem()] })}>Add custom item</button></div>
              <div className={styles.fields}><label>Copy a reusable item<select value={reuseKey} onChange={event => setReuseKey(event.target.value)}><option value="">Choose a source item</option>{reusable.filter(source => !draft.items.some(item => item.id === source.item.id)).map(source =>
                <option key={source.key} value={source.key}>{source.sheet.name} v{source.sheet.version} / {source.item.name} [{source.item.id}]</option>)}</select></label>
                <div className={styles.actions}><button disabled={!reuseKey || draft.items.length >= 60} onClick={() => { const source = reusable.find(value => value.key === reuseKey); if (source && !draft.items.some(item => item.id === source.item.id)) { setDraft({ ...draft, items: [...draft.items, copy(source.item)] }); setReuseKey(""); } }}>Copy item with identity</button></div></div>
              {!draft.items.length && <div className={styles.empty}>Add a custom item or copy a reusable item. A sheet needs at least one item.</div>}
              {draft.items.map((item, index) => <details className={styles.item} key={`${index}/${item.id}`} open>
                <summary>{index + 1}. {item.name || "Untitled item"} <small> / {item.fields.length} fields</small></summary>
                <div className={styles.form}>
                  <div className={styles.row}><small className={styles.identity}>Item ID: {item.id}</small><div className={styles.actions}><button aria-label={`Move item ${index + 1} up`} disabled={index === 0} onClick={() => moveItem(index, -1)}>Move up</button><button aria-label={`Move item ${index + 1} down`} disabled={index === draft.items.length - 1} onClick={() => moveItem(index, 1)}>Move down</button><button onClick={() => { if (window.confirm(`Remove ${item.name || "this item"} from this draft? Existing versions are retained.`)) setDraft({ ...draft, items: draft.items.filter((_, i) => i !== index) }); }}>Remove item</button></div></div>
                  <label>Item name<input maxLength={160} value={item.name} onChange={event => updateItem(index, { name: event.target.value })} /></label>
                  <div className={styles.fields}><label>Procedure identity<input maxLength={100} value={item.procedure} onChange={event => updateItem(index, { procedure: event.target.value })} /></label><label>Position identity<input maxLength={60} value={item.position ?? ""} onChange={event => updateItem(index, { position: event.target.value })} placeholder="For example, lf" /></label></div>
                  <small>Position is part of measurement identity, not the checklist order. Move up / down changes order without changing identity.</small>
                  <div className={styles.fields}>{(["required", "notesRequired", "photoRequired", "recommendationRequired"] as const).map((flag, i) => <label className={styles.check} key={flag}><input type="checkbox" checked={item[flag]} onChange={event => updateItem(index, { [flag]: event.target.checked })} />{["Rating required", "Evaluation notes required", "Photo required", "Recommendation required"][i]}</label>)}</div>
                  <div className={styles.row}><strong>Measurement fields · {item.fields.length}/20</strong><button disabled={item.fields.length >= 20} onClick={() => updateItem(index, { fields: [...item.fields, { id: uniqueId("field"), label: "", type: "text" }] })}>Add field</button></div>
                  {item.fields.map((field, fieldIndex) => {
                    const changeField = (patch: Partial<StaffItem["fields"][number]>) => updateItem(index, { fields: item.fields.map((value, i) => i === fieldIndex ? { ...value, ...patch } : value) });
                    return <div key={fieldIndex} className={styles.measurement}>
                      <div className={styles.fields}><label>Field label<input maxLength={100} value={field.label} onChange={event => changeField({ label: event.target.value })} /></label><label>Field identity<input maxLength={60} value={field.id} onChange={event => { const id = event.target.value; updateItem(index, { fields: item.fields.map((value, i) => i === fieldIndex ? { ...value, id } : value), requiredFields: item.requiredFields.map(value => value === field.id ? id : value) }); }} /></label>
                        <label>Field type<select value={field.type} onChange={event => { const type = event.target.value as "text" | "number" | "select"; const { options: _options, ...rest } = field; updateItem(index, { fields: item.fields.map((value, i) => i === fieldIndex ? { ...rest, type, ...(type === "select" ? { options: [""] } : {}) } : value) }); }}><option value="text">Text</option><option value="number">Number</option><option value="select">Select</option></select></label><label>Unit (optional)<input maxLength={30} value={field.unit ?? ""} onChange={event => changeField({ unit: event.target.value })} /></label></div>
                      {field.type === "select" && <label>Options (one per line, up to 30)<textarea rows={3} value={(field.options ?? []).join("\n")} onChange={event => changeField({ options: event.target.value.split("\n") })} /></label>}
                      <div className={styles.row}><label className={styles.check}><input type="checkbox" checked={item.requiredFields.includes(field.id)} onChange={event => updateItem(index, { requiredFields: event.target.checked ? [...new Set([...item.requiredFields, field.id])] : item.requiredFields.filter(id => id !== field.id) })} />Measurement required</label><button onClick={() => { if (window.confirm(`Remove ${field.label || "this field"} from this draft?`)) updateItem(index, { fields: item.fields.filter((_, i) => i !== fieldIndex), requiredFields: item.requiredFields.filter(id => id !== field.id) }); }}>Remove field</button></div>
                    </div>;
                  })}
                </div>
              </details>)}
              {draft.version > 0 && defaultFamily === draft.id ? <p className={styles.notice}>This is the current default definition. Publishing automatically advances the default to the new version for new inspections. Existing visits keep their attached versions and findings.</p> :
                <label className={styles.check}><input type="checkbox" checked={makeDefault} onChange={event => setMakeDefault(event.target.checked)} />Make this new approved version the default for new inspections</label>}
            </fieldset>
            <div className={`${styles.row} ${styles.footer}`}><small>{pending ? "Exact request retained until acknowledged." : "Draft stays local until you publish. Other workspace navigation is locked."}</small><div className={styles.actions}><button disabled={busy || !!pending || loading} onClick={() => { if (window.confirm("Discard this local draft and load the latest catalog?")) void discard(); }}>Discard draft</button><button className={styles.primary} disabled={editingBlocked} onClick={() => void save()}>Publish new version</button></div></div>
          </> : selected ? <>
            <div className={styles.row}><div><div className={styles.eyebrow}>{isTemplate ? "Starting template / not approved" : archived ? "Archived definition" : "Approved definition"}</div><h2>{selected.name}</h2></div>{isDefault && <span className={styles.badge}>Default for new inspections</span>}</div>
            <small className={styles.identity}>{keyOf(selected)} · {selected.items.length} items</small>
            {!isTemplate && <label style={{ marginTop: 16 }}>Preview immutable version<select disabled={locked} value={keyOf(selected)} onChange={event => setSelection(event.target.value)}>{data.sheets.filter(sheet => sheet.id === selected.id).sort((a, b) => b.version - a.version).map(sheet => <option key={keyOf(sheet)} value={keyOf(sheet)}>Version {sheet.version}{data.defaultSheet === keyOf(sheet) ? " · default" : ""}</option>)}</select></label>}
            {data.canManage && <div className={styles.actions} style={{ marginTop: 16 }}>
              {!isTemplate && !archived && <button disabled={locked} onClick={() => start(selected)}>Edit latest version</button>}
              <button disabled={locked} onClick={() => start(selected, true)}>{isTemplate ? "Create from template" : "Duplicate sheet"}</button>
              {!isTemplate && !archived && !isDefault && <button disabled={locked} onClick={() => setConfirmation({ type: "default", sheet: keyOf(selected) })}>Set as default</button>}
              {!isTemplate && <button disabled={locked || (!archived && defaultFamily === selected.id)} onClick={() => setConfirmation({ type: "archive", sheetId: selected.id, archived: !archived })}>{archived ? "Restore definition" : "Archive definition"}</button>}
            </div>}
            {!archived && !isTemplate && defaultFamily === selected.id && <p><small>To archive this definition, first select another approved sheet and set it as the default. Archiving applies to all versions.</small></p>}
            <ol className={styles.previewList}>{selected.items.map(item => <li key={item.id}><h3>{item.name}</h3><small className={styles.identity}>{item.id} / {item.procedure}{item.position ? ` / ${item.position}` : ""}</small><p><small>{[item.required ? "Rating required" : "Optional rating", ...(item.notesRequired ? ["Notes required"] : []), ...(item.photoRequired ? ["Photo required"] : []), ...(item.recommendationRequired ? ["Recommendation required"] : [])].join(" · ")}</small></p>
              {item.fields.length > 0 && <dl>{item.fields.map(field => <div key={field.id} style={{ display: "contents" }}><dt>{field.label}{item.requiredFields.includes(field.id) ? " · required" : ""}</dt><dd>{field.type}{field.unit ? ` / ${field.unit}` : ""}{field.options ? ` / ${field.options.join(", ")}` : ""}<br /><small className={styles.identity}>{field.id}</small></dd></div>)}</dl>}
            </li>)}</ol>
          </> : <div className={styles.empty}><h3>Your next inspection starts here</h3><p>{data.canManage ? "Create a sheet or choose a starting template. Nothing is approved automatically." : "Your managing organization has not approved any sheets yet."}</p></div>}
        </div>
      </div>
      {confirmation && <div className={styles.notice} role="alertdialog" aria-label="Confirm catalog change"><h3>{confirmation.type === "default" ? "Change the default sheet?" : confirmation.type === "archive" && confirmation.archived ? "Archive this definition?" : "Restore this definition?"}</h3><p>This affects future checklist selection only. Every existing inspection keeps its approved version and findings.</p><div className={styles.actions}><button disabled={busy || !!pending || conflict} onClick={() => setConfirmation(null)}>Cancel change</button><button className={styles.primary} disabled={busy || !!pending || conflict || loading} onClick={() => void confirm()}>Confirm change</button></div></div>}
    </>}
  </section>;
}
export default SheetManager;
