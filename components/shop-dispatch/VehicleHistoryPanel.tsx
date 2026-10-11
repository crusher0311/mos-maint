"use client";
import { useState } from "react";
import { CATALOG } from "@/lib/auto-dvi/visit-model";
import { normalizeHistoryVin } from "@/lib/vehicle-history/model";
import { useHistoryRead, type DispatchVehicleHistory, type DviHistory, type DviSnapshot } from "./use-vehicle-history";
import styles from "./pilot.module.css";
import css from "./VehicleHistoryPanel.module.css";

function date(value: string | null | undefined) {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString() : "Date unavailable";
}
function mileage(value: number | null, unit?: string | null) {
  return value === null ? "Mileage unavailable" : `${value.toLocaleString()} ${unit === "kilometers" ? "km" : unit === "miles" ? "mi" : "(unit not supplied)"}`;
}

/** Keyed inner state guarantees no opened section or evidence survives a context change. */
export function VehicleHistoryPanel({ visitId, shopId }: { visitId: string; shopId: number }) {
  return <HistoryContext key={`${shopId}:${visitId}`} visitId={visitId} shopId={shopId} />;
}
function HistoryContext({ visitId, shopId }: { visitId: string; shopId: number }) {
  const [open, setOpen] = useState(false);
  const [location, setLocation] = useState("all");
  const identity = `${shopId}:${visitId}`;
  const { data, failure, loading, retry } = useHistoryRead<DispatchVehicleHistory>(
    identity, `/api/shop-dispatch/vehicle-history?visitId=${encodeURIComponent(visitId)}`, open,
    value => !!value && value.visitId === visitId && value.currentShopId === shopId &&
      (value.vin === null || normalizeHistoryVin(value.vin) === value.vin) &&
      typeof value.sharing?.enabled === "boolean" && Array.isArray(value.events) && Array.isArray(value.locations) &&
      value.events.every(event => event.readOnly === true) && (value.vin !== null || value.events.length === 0),
  );
  const events = data?.events.filter(event => location === "all" || String(event.shopId) === location) ?? [];
  const partial = data?.locations.some(item => item.state !== "available" || item.hasMore);
  return <section className={css.panel} data-testid="vehicle-history-panel" aria-label="Vehicle history">
    <div className={css.heading}><div><h3>Vehicle history</h3><small>Local records and permitted shared evidence · read-only</small></div>
      <button type="button" data-testid="vehicle-history-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? "Hide history" : "View vehicle history"}</button></div>
    {open && <div className={css.content} aria-live="polite" aria-busy={loading}>
      <p><small>Records returned by accessible locations, not a complete lifetime history. Viewing evidence does not change this visit or its schedule.</small></p>
      {loading ? <div role="status"><small>Checking records and location coverage…</small><div className={css.skeleton} /><div className={css.skeleton} /></div> :
        failure ? <div className={styles.notice} role="alert">{failure.text}</div> : data && <>
          {!data.vin ? <div className={styles.notice} data-testid="history-missing-vin"><strong>Vehicle history needs a valid VIN</strong><p>{data.reason || "No valid VIN is available on this visit. No vehicle records were requested."}</p></div> : <>
            <small>VIN {data.vin} · Checked {date(data.checkedAt)}</small>
            {!data.sharing.enabled && <p data-testid="history-local-only"><small>Local history remains available. Shared history is off or unavailable. {data.sharing.reason}</small></p>}
            {data.reason && <p className={styles.notice}>{data.reason}</p>}
            <h4>{partial ? "Partial location coverage" : "Location coverage"}</h4>
            <ul className={css.coverage} data-testid="history-coverage">{data.locations.map(item => <li key={item.shopId}>
              <strong>{item.name}{item.shopId === shopId ? " · Current shop" : " · Shared location"}</strong> · {item.state === "available" ? "Available" : item.state === "incomplete" ? "Incomplete" : "Unavailable"}
              {item.hasMore && " · More records not shown"}{item.reason && <div>{item.reason}</div>}
              <div>{item.fetchedAt ? `Fetched ${date(item.fetchedAt)}` : "No fetch verified"}</div>
            </li>)}</ul>
            {!data.locations.length && <p className={styles.notice}>No location coverage was verified. This is not evidence of an empty history.</p>}
            <label className={css.filters}>Location<select data-testid="history-location-filter" value={location} onChange={event => setLocation(event.target.value)}>
              <option value="all">All accessible locations</option>{data.locations.map(item => <option key={item.shopId} value={item.shopId}>{item.name}{item.state === "unavailable" ? " · unavailable" : ""}</option>)}
            </select></label>
            {!events.length ? <div className={styles.empty} data-testid="history-empty">No matching records returned{partial || !data.locations.length ? " within the verified coverage; other work may exist." : " from the locations shown. This is not a complete lifetime history."}</div> :
              <ul className={css.events} data-testid="history-events">{events.map(event => <li key={`${event.shopId}:${event.id}`}>
                <div className={css.heading}><h4>{event.title}</h4><span className={styles.chip}>{event.status === "completed" ? "Performed" : event.status === "declined" ? "Deferred / declined" : "Status unknown"}</span></div>
                <p>{event.location} · {date(event.date)} · {mileage(event.mileage, event.mileageUnit)}</p>
                <small>{event.provider} · {event.workOrderNumber ? `RO #${event.workOrderNumber}` : "RO number unavailable"} · Read-only</small>
                {event.resolution && <p><small>{event.resolution.state === "completed_elsewhere" ? "Completion evidence elsewhere" : event.resolution.state === "partial" ? "Partial completion evidence elsewhere" : "Outstanding evidence"}{event.resolution.remainingComponents.length > 0 && ` · Remaining: ${event.resolution.remainingComponents.join(", ")}`} · Original work unchanged.</small></p>}
              </li>)}</ul>}
            <DviCurrentSnapshot key={`snapshot:${identity}:${data.vin}`} vin={data.vin} shopId={shopId} identity={identity} currentLocation={data.locations.find(item => item.shopId === shopId)?.name || "Current shop"} />
            <DviEvidence key={`${identity}:${data.vin}`} vin={data.vin} shopId={shopId} identity={identity} currentLocation={data.locations.find(item => item.shopId === shopId)?.name || "Current shop"} />
          </>}
        </>}
      <div className={styles.actions}><button type="button" data-testid="history-retry" disabled={loading} onClick={retry}>Retry / refresh history</button></div>
    </div>}
  </section>;
}

function DviCurrentSnapshot({ vin, shopId, identity, currentLocation }: { vin: string; shopId: number; identity: string; currentLocation: string }) {
  const [open, setOpen] = useState(false);
  const { data, failure, loading, retry } = useHistoryRead<DviSnapshot>(
    `${identity}:${vin}`, `/api/auto-dvi/results?vin=${encodeURIComponent(vin)}`, open,
    value => !!value && value.ok === true && (value.results === null ||
      (value.results?.shopId === shopId && value.results.vin === vin && Array.isArray(value.results.items))),
  );
  const snapshot = data?.results;
  return <section data-testid="dvi-current-snapshot"><div className={css.heading}><h4>Current local inspection snapshot</h4>
    <button type="button" data-testid="dvi-snapshot-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? "Hide current findings" : "View current findings"}</button></div>
    {open && <div aria-live="polite" aria-busy={loading}>
      <p><small>{currentLocation} · Current snapshot only, not full inspection history. Findings are observations, not performed repairs. Read-only; photos are not loaded.</small></p>
      {loading ? <div role="status"><small>Checking current inspection findings…</small><div className={css.skeleton} /></div> :
        failure ? <p className={styles.notice} role="alert">{failure.forbidden ? "Current inspection snapshot unavailable for this location or your access. No inspection absence is inferred." : failure.text}</p> :
          data && !snapshot ? <p className={styles.empty}>No current local inspection snapshot returned. This does not mean no inspections exist.</p> :
            snapshot && <>
              <p><small>Updated {date(snapshot.updatedAt)} · {snapshot.status === "pushed" ? "Pushed snapshot — not a completed visit history" : "In-progress snapshot — findings may change"}</small></p>
              {!snapshot.items.length && <p className={styles.empty}>No findings in the current snapshot. Other inspections may exist.</p>}
              {snapshot.items.map(item => <div className={css.finding} key={item.itemId}>
                <strong>{item.name || item.itemId}</strong> · {item.rating === "green" ? "Good" : item.rating === "yellow" ? "Monitor / recommended" : item.rating === "red" ? "Attention needed" : "Not rated"}
                {item.notes && <p>{item.notes}</p>}{item.recommendation && <p>Recommendation: {item.recommendation}</p>}
                {!!item.media?.length && <small>{item.media.length} media attachments · not loaded</small>}
              </div>)}
            </>}
      <button type="button" disabled={loading} onClick={retry}>Retry / refresh current findings</button>
    </div>}
  </section>;
}

function DviEvidence({ vin, shopId, identity, currentLocation }: { vin: string; shopId: number; identity: string; currentLocation: string }) {
  const [open, setOpen] = useState(false);
  const { data, failure, loading, retry } = useHistoryRead<DviHistory>(
    `${identity}:${vin}`, `/api/auto-dvi/visits?vin=${encodeURIComponent(vin)}`, open,
    value => !!value && value.ok === true && Array.isArray(value.record?.visits) && Array.isArray(value.history),
  );
  const entries = data ? [
    ...data.record.visits.map(visit => ({ shopId, shopName: currentLocation, visit })),
    ...data.history.filter(entry => entry.visit.status === "complete"),
  ] : [];
  return <section data-testid="dvi-history"><div className={css.heading}><h4>Inspection history</h4><button type="button" data-testid="dvi-history-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? "Hide inspections" : "View inspection history"}</button></div>
    {open && <div aria-live="polite" aria-busy={loading}><small>Inspection findings are observations, not evidence of performed repairs. Reports are read-only; photos are not loaded here.</small>
      {loading ? <div role="status"><small>Checking inspection access…</small><div className={css.skeleton} /></div> :
        failure ? <p className={styles.notice} role="alert">{failure.forbidden ? "Inspection history unavailable: visit-based DVI may be release-held or unavailable for your access. This does not mean no inspections exist. Current local findings are available separately above when permitted." : failure.text}</p> : data && <>
          {data.sharingReason && <p className={styles.notice}>{data.sharingReason}</p>}
          {!entries.length && <p className={styles.empty}>No accessible inspection reports returned. This is not a complete inspection history.</p>}
          <ul className={css.events}>{entries.map(entry => <li key={`${entry.shopId}:${entry.visit.id}`}>
            <h4>{entry.shopName} · {entry.shopId === shopId ? "Current / local inspection" : "Shared completed inspection"}</h4>
            <p>RO {entry.visit.roNumber} · {date(entry.visit.completedAt || entry.visit.createdAt)} · {mileage(entry.visit.mileage)} · {entry.visit.status === "complete" ? "Complete report" : "In-progress report — findings may change"}</p>
            <small>{entry.visit.sheet.name} · Read-only findings</small>
            {Object.entries(entry.visit.results).map(([id, result]) => <div key={id} className={css.finding}>
              <strong>{CATALOG.find(item => item.id === id)?.name || id}</strong> · {result.rating === "green" ? "Good" : result.rating === "yellow" ? "Monitor / recommended" : result.rating === "red" ? "Attention needed" : "Not rated"}
              {result.notes && <p>{result.notes}</p>}{result.recommendation && <p>Recommendation: {result.recommendation}</p>}
              {Object.entries(result.values).map(([field, value]) => { const definition = CATALOG.find(item => item.id === id)?.fields.find(item => item.id === field); return <p key={field}><small>{definition?.label || field}: {value}{definition?.unit ? ` ${definition.unit}` : ""}</small></p>; })}
              {!!result.media?.length && <small>{result.media.length} media attachments · not loaded</small>}
            </div>)}
          </li>)}</ul>
        </>}
      <button type="button" disabled={loading} onClick={retry}>Retry / refresh inspections</button>
    </div>}
  </section>;
}
