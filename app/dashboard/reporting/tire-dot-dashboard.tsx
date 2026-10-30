"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Download, FileSpreadsheet, Play, RefreshCw } from "lucide-react";
import type { TireDotResult } from "@/lib/tire-dot-report-contract";

type Scope = { kind: "shop" | "enterprise" | "platform"; shopId?: number; enterpriseId?: string };
type Location = { shopId: number; name: string };
type Run = {
  runId: string; status: "queued" | "running" | "succeeded" | "failed";
  stage: string; result?: TireDotResult; error?: string; stale?: boolean;
};
type Snapshot = { runId: string; result: TireDotResult; stale: boolean };
type View = "details" | "exceptions" | "invoices";
const PAGE_SIZE = 50;
const cell = "border-b border-slate-100 px-4 py-3 text-left align-top text-xs";

function presetRange(preset: string) {
  const now = new Date();
  const end = now.toISOString().slice(0, 10);
  const start = new Date(`${end}T00:00:00Z`);
  if (preset === "month") start.setUTCDate(1);
  else start.setUTCDate(start.getUTCDate() - (preset === "7" ? 6 : 29));
  return { start: start.toISOString().slice(0, 10), end };
}
function validDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function errorText(value: unknown, fallback: string) {
  if (value && typeof value === "object" && "error" in value && typeof value.error === "string") return value.error;
  return fallback;
}
function display(value: string | number | null | undefined) {
  return value == null || value === "" ? "—" : typeof value === "number" ? value.toLocaleString() : value;
}

export function TireDotDashboard({ scope, initialRange }: {
  scope: Scope; initialRange?: { start?: string; end?: string; locationId?: string };
}) {
  const [range, setRange] = useState(() => ({ ...presetRange("30"), ...initialRange?.start && { start: initialRange.start }, ...initialRange?.end && { end: initialRange.end } }));
  const [preset, setPreset] = useState(initialRange?.start || initialRange?.end ? "custom" : "30");
  const [locations, setLocations] = useState<Location[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [locationsLoading, setLocationsLoading] = useState(true);
  const [locationsError, setLocationsError] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState<View>("details");
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState<"details" | "invoices" | null>(null);
  const [exportError, setExportError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const locationGeneration = useRef(0);
  const request = useRef<AbortController | null>(null);
  const exportRequest = useRef<AbortController | null>(null);
  const locationRequest = useRef<AbortController | null>(null);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const submittedIds = useRef<number[]>([]);
  const initialized = useRef(false);
  const initialLocation = useRef(initialRange?.locationId);
  const supported = scope.kind !== "platform";

  const clearSensitive = useCallback((message: string) => {
    generation.current += 1;
    request.current?.abort();
    exportRequest.current?.abort();
    submittedIds.current = [];
    snapshotRef.current = null;
    setSnapshot(null); setRun(null); setSubmitting(false); setExporting(null);
    setExportError(""); setNotice(""); setError(message);
  }, []);

  const loadLocations = useCallback(async () => {
    if (scope.kind === "platform") { setLocationsLoading(false); return; }
    const token = ++locationGeneration.current;
    locationRequest.current?.abort();
    const abort = new AbortController();
    locationRequest.current = abort;
    setLocationsLoading(true); setLocationsError("");
    const params = new URLSearchParams({ scope: scope.kind });
    if (scope.shopId !== undefined) params.set("shopId", String(scope.shopId));
    if (scope.enterpriseId) params.set("enterpriseId", scope.enterpriseId);
    try {
      const response = await fetch(`/api/reports/tire-dot/locations?${params}`, { credentials: "include", signal: abort.signal, cache: "no-store" });
      const json = await response.json().catch(() => null);
      if (token !== locationGeneration.current || abort.signal.aborted) return;
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          setLocations([]); setSelected([]); initialized.current = false;
          clearSensitive("Access changed. Previous report data has been cleared.");
        }
        throw new Error(errorText(json, "Authorized Tekmetric locations could not be loaded."));
      }
      if (!Array.isArray(json?.locations)) throw new Error("Location response was invalid. Please retry.");
      const next: Location[] = json.locations;
      const allowed = new Set(next.map(item => item.shopId));
      const previousIds = [...(snapshotRef.current?.result.shopIds ?? []), ...submittedIds.current];
      if (previousIds.some(id => !allowed.has(id))) clearSensitive("Location access changed. Previous results were cleared; review your selection and run again.");
      setLocations(next);
      if (!initialized.current) {
        initialized.current = true;
        const initial = Number(initialLocation.current);
        setSelected(initialLocation.current ? next.filter(item => item.shopId === initial).map(item => item.shopId) : next.map(item => item.shopId));
      } else setSelected(current => current.filter(id => allowed.has(id)));
    } catch (failure) {
      if (token === locationGeneration.current && !abort.signal.aborted) setLocationsError(failure instanceof Error ? failure.message : "Unable to load locations.");
    } finally {
      if (token === locationGeneration.current && !abort.signal.aborted) setLocationsLoading(false);
    }
  }, [scope.kind, scope.shopId, scope.enterpriseId, clearSensitive]);

  useEffect(() => {
    void loadLocations();
    const checkAccess = () => { if (document.visibilityState === "visible") void loadLocations(); };
    window.addEventListener("focus", checkAccess);
    document.addEventListener("visibilitychange", checkAccess);
    return () => {
      generation.current += 1; locationGeneration.current += 1;
      request.current?.abort(); exportRequest.current?.abort(); locationRequest.current?.abort();
      window.removeEventListener("focus", checkAccess);
      document.removeEventListener("visibilitychange", checkAccess);
    };
  }, [loadLocations]);

  const accept = (next: Run) => {
    setRun(next);
    if (next.result) {
      setSnapshot({ runId: next.runId, result: next.result, stale: Boolean(next.stale) });
      setPage(1); setExportError("");
    }
    if (next.status === "failed") setError(next.error || "Report failed. Use Run report to try again.");
    else if (next.status === "succeeded" && !next.result) setError("The completed report did not include results. Use Run report to retry.");
  };

  const valid = validDate(range.start) && validDate(range.end) && range.start <= range.end && selected.length > 0;
  const pending = submitting || run?.status === "queued" || run?.status === "running";
  const runReport = async () => {
    if (!supported || !valid || pending || locationsLoading || locationsError) return;
    const token = ++generation.current;
    request.current?.abort(); exportRequest.current?.abort(); setExporting(null); setExportError("");
    const abort = new AbortController();
    request.current = abort;
    submittedIds.current = [...selected];
    setSubmitting(true); setRun(null); setError(""); setNotice("");
    try {
      const response = await fetch("/api/reports/runs", {
        method: "POST", credentials: "include", signal: abort.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "tekmetric-tire-dot", scope, dateRange: range, locationIds: selected, force: Boolean(snapshot || run?.status === "failed") }),
      });
      const json = await response.json().catch(() => null);
      if (token !== generation.current || abort.signal.aborted) return;
      if (response.status === 401 || response.status === 403) {
        clearSensitive("Report access is no longer available. Previous data has been cleared.");
        setLocations([]); setSelected([]); setLocationsError("Reload authorized locations before running again."); return;
      }
      if (!response.ok) throw new Error(errorText(json, "Report could not be queued. Please retry."));
      if (!json?.runId || !["queued", "running", "succeeded", "failed"].includes(json.status)) throw new Error("Invalid run response. Please retry.");
      accept(json);
    } catch (failure) {
      if (token === generation.current && !abort.signal.aborted) setError(failure instanceof Error ? failure.message : "Report could not be queued.");
    } finally {
      if (token === generation.current && !abort.signal.aborted) setSubmitting(false);
    }
  };

  useEffect(() => {
    if (!run?.runId || !["queued", "running"].includes(run.status)) return;
    const id = run.runId;
    const token = generation.current;
    const abort = new AbortController();
    request.current = abort;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let again = true;
      try {
        const response = await fetch(`/api/reports/tire-dot/runs/${encodeURIComponent(id)}`, { credentials: "include", signal: abort.signal, cache: "no-store" });
        const json = await response.json().catch(() => null);
        if (disposed || token !== generation.current || abort.signal.aborted) return;
        if (response.status === 401 || response.status === 403) {
          clearSensitive("Report access changed. Previous data has been cleared.");
          setLocations([]); setSelected([]); setLocationsError("Reload authorized locations to check access."); return;
        }
        if (!response.ok) throw new Error(errorText(json, "Progress is temporarily unavailable. Retrying automatically."));
        if (!json || !["queued", "running", "succeeded", "failed"].includes(json.status)) throw new Error("Invalid progress response. Retrying automatically.");
        setError("");
        accept({ ...json, runId: id });
        again = json.status === "queued" || json.status === "running";
      } catch (failure) {
        if (!disposed && token === generation.current && !abort.signal.aborted) setError(failure instanceof Error ? failure.message : "Progress unavailable. Retrying automatically.");
      }
      if (again && !disposed && !abort.signal.aborted && token === generation.current) timer = setTimeout(poll, 2500);
    };
    timer = setTimeout(poll, 1500);
    return () => { disposed = true; clearTimeout(timer); abort.abort(); };
    // Only run identity and status control the polling lifecycle, never draft filters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.runId, run?.status, clearSensitive]);

  const download = async (exportView: "details" | "invoices") => {
    if (!snapshot || exporting || locationsLoading || locationsError) return;
    const token = generation.current;
    const abort = new AbortController();
    exportRequest.current?.abort(); exportRequest.current = abort;
    setExporting(exportView); setExportError("");
    try {
      const params = new URLSearchParams({ kind: "tekmetric-tire-dot", runId: snapshot.runId, view: exportView });
      const response = await fetch(`/api/reports/export?${params}`, { credentials: "include", signal: abort.signal, cache: "no-store" });
      if (token !== generation.current || abort.signal.aborted) return;
      if (response.status === 401 || response.status === 403) {
        clearSensitive("Export access changed. Previous data has been cleared.");
        setLocations([]); setSelected([]); setLocationsError("Reload authorized locations to check access."); return;
      }
      if (!response.ok || response.status === 202 || response.headers.get("content-type")?.includes("json")) {
        const json = await response.json().catch(() => null);
        throw new Error(response.status === 202 ? "CSV is still preparing. Please try this export again shortly." : errorText(json, "CSV could not be downloaded. Please retry."));
      }
      const blob = await response.blob();
      if (token !== generation.current || abort.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = `tekmetric-tire-dot-${exportView}-${snapshot.result.dateRange.start}-${snapshot.result.dateRange.end}.csv`;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) {
      if (token === generation.current && !abort.signal.aborted) setExportError(failure instanceof Error ? failure.message : "Export failed. Please retry.");
    } finally {
      if (token === generation.current && !abort.signal.aborted) setExporting(null);
    }
  };

  const result = snapshot?.result;
  const mismatch = Boolean(result && (range.start !== result.dateRange.start || range.end !== result.dateRange.end
    || [...selected].sort((a, b) => a - b).join(",") !== [...result.shopIds].sort((a, b) => a - b).join(",")));
  const details = result?.details ?? [];
  const exceptions = details.filter(item => item.exceptions.length > 0);
  const rows = view === "invoices" ? result?.invoices ?? [] : view === "exceptions" ? exceptions : details;
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages);
  const visible = rows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const incomplete = result?.coverage.status === "incomplete";

  if (!supported) return <section className="panel p-6" aria-label="Tekmetric Tire DOT"><div className="flex items-start gap-3"><AlertTriangle className="h-5 w-5 shrink-0 text-amber-700" /><div><h2 className="text-lg font-bold">Choose a shop or enterprise scope</h2><p className="mt-2 text-sm text-slate-600">Tekmetric Tire DOT does not support platform-wide reporting. Change Reporting scope above to use an authorized Tekmetric location.</p></div></div></section>;

  return <section className="space-y-4" aria-label="Tekmetric Tire DOT dashboard">
    <div className="panel p-5">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-bold tracking-tight">Tekmetric Tire DOT</h2><p className="mt-1 text-xs leading-5 text-slate-500">Trace stored tire part lines and DOT entries back to posted invoices.</p></div><span className="rounded border border-[#c7dfef] bg-[#edf7fd] px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-[#28679f]">Stored evidence · Tekmetric only</span></div>
      <form onSubmit={event => { event.preventDefault(); void runReport(); }} className="space-y-4">
        <div className="grid items-end gap-3 md:grid-cols-[1fr_1fr_1fr_auto]">
          <label className="text-xs font-bold text-slate-700">Date preset<select className="filter mt-1 block w-full" value={preset} onChange={event => { setPreset(event.target.value); if (event.target.value !== "custom") setRange(presetRange(event.target.value)); }}><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="month">Month to date</option><option value="custom">Custom dates</option></select></label>
          <label className="text-xs font-bold text-slate-700">Start date (UTC)<input className="filter mt-1 block w-full" type="date" required value={range.start} onChange={event => { setPreset("custom"); setRange(current => ({ ...current, start: event.target.value })); }} /></label>
          <label className="text-xs font-bold text-slate-700">End date (UTC)<input className="filter mt-1 block w-full" type="date" required min={range.start} value={range.end} onChange={event => { setPreset("custom"); setRange(current => ({ ...current, end: event.target.value })); }} /></label>
          <button className="action primary justify-center" disabled={!valid || pending || locationsLoading || Boolean(locationsError)} type="submit"><Play aria-hidden="true" className="h-4 w-4" />{submitting ? "Queuing…" : pending ? "Building…" : "Run report"}</button>
        </div>
        <fieldset className="rounded-md border border-slate-200 px-3 pb-3" disabled={locationsLoading || Boolean(locationsError)}>
          <legend className="px-1 text-xs font-bold text-slate-700">Authorized Tekmetric locations · {selected.length} selected</legend>
          {locationsLoading ? <div role="status" className="mt-2 space-y-2"><span className="sr-only">Loading authorized locations</span><div className="h-4 w-48 rounded bg-slate-100 motion-safe:animate-pulse" /><div className="h-4 w-64 max-w-full rounded bg-slate-100 motion-safe:animate-pulse" /></div> : locationsError ? <p className="mt-2 text-xs text-red-800">Location access could not be verified.</p> : locations.length ? <><div className="my-2 flex gap-3"><button type="button" className="text-xs font-semibold text-[#28679f] hover:underline" onClick={() => setSelected(locations.map(item => item.shopId))}>Select all</button><button type="button" className="text-xs font-semibold text-[#28679f] hover:underline" onClick={() => setSelected([])}>Clear selection</button></div><div className="grid max-h-44 gap-2 overflow-y-auto md:grid-cols-2">{locations.map(location => <label key={location.shopId} className="flex cursor-pointer items-center gap-2 text-xs text-slate-700"><input type="checkbox" className="h-4 w-4 accent-[#347bbd]" checked={selected.includes(location.shopId)} onChange={event => setSelected(current => event.target.checked ? [...current, location.shopId] : current.filter(id => id !== location.shopId))} /><span>{location.name} <span className="text-slate-400">#{location.shopId}</span></span></label>)}</div></> : <p className="mt-2 text-xs text-slate-600">No authorized Tekmetric locations are available in this scope. Other providers are not supported.</p>}
        </fieldset>
        <p className="text-xs leading-5 text-slate-500">Both start and end dates are inclusive, using invoice posted dates in UTC. Changing filters never runs a report.{!valid && " Choose valid dates and at least one location."}</p>
      </form>
      {locationsError && <div role="alert" className="mt-3 flex flex-wrap items-center gap-3 text-xs text-red-800"><span>{locationsError}</span><button className="action secondary" type="button" onClick={() => void loadLocations()}><RefreshCw className="h-3 w-3" aria-hidden="true" />Retry locations</button></div>}
    </div>
    {error && <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-xs leading-5 text-red-900">{error}{pending ? " Monitoring will retry; you may stop waiting below." : " Review your filters and use Run report to retry."}</div>}
    {pending && <div role="status" aria-live="polite" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[#c7dfef] bg-[#edf7fd] px-4 py-3 text-xs text-[#174b78]"><span><strong>{submitting ? "Queuing report" : run?.status === "queued" ? "Report queued" : "Building report"}</strong>{run?.stage ? ` · ${run.stage.replaceAll("_", " ")}` : ""}. {snapshot ? "Previous execution remains visible below." : "Results will appear when ready."}</span><button className="action secondary" type="button" onClick={() => { generation.current += 1; request.current?.abort(); setRun(null); setSubmitting(false); setNotice("Stopped waiting locally. The background run was not cancelled. Run again to request results."); }}>Stop waiting</button></div>}
    {notice && <p role="status" className="text-xs text-[#28679f]">{notice}</p>}
    {result && <div className="panel px-4 py-3 text-xs leading-5 text-slate-600">
      <div className="flex flex-wrap justify-between gap-3"><div><strong className="block text-slate-800">Executed results · {result.dateRange.start} – {result.dateRange.end} UTC</strong><span>{result.locations.map(item => `${item.name} (#${item.shopId})`).join(", ") || `${result.shopIds.length} locations`}</span></div><div><span className="block">Generated {Number.isNaN(Date.parse(result.generatedAt)) ? "time unavailable" : new Date(result.generatedAt).toLocaleString()}</span><strong className={snapshot.stale ? "text-amber-800" : "text-[#28679f]"}>{snapshot.stale ? "Stale result" : pending ? "Previous execution · new run in progress" : "Latest returned execution"}</strong></div></div>
      {mismatch && <p role="status" className="mt-2 border-t border-amber-200 pt-2 font-semibold text-amber-800">Filters differ from this execution. Click Run report to apply them. Tables and exports still use the executed dates and locations above.</p>}
    </div>}
    <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-900">
      <div className="flex items-start gap-2"><AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" /><div><strong>{incomplete ? "Incomplete stored coverage." : "Stored evidence, not a full-history guarantee."}</strong> This report uses stored Tekmetric evidence; it cannot establish that all upstream history was imported. Mileage is taken from the invoice, not the vehicle’s current mileage.</div></div>
      {result && <div className="mt-2 border-t border-amber-200 pt-2"><p>{result.coverage.scanned.toLocaleString()} records scanned · {result.coverage.missingRaw.toLocaleString()} missing raw evidence · {result.coverage.missingPostedDate.toLocaleString()} missing posted dates.</p>{result.coverage.reasons.length > 0 && <ul className="mt-1 list-inside list-disc">{result.coverage.reasons.map((reason, index) => <li key={`${index}:${reason}`}>{reason}</li>)}</ul>}{result.limited && <p className="mt-1 font-bold">Safety limit reached. These results are limited; narrow your dates or locations before reconciling totals.</p>}</div>}
    </div>
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4" aria-label="Separate report counts">
      {([["invoices", "Invoices"], ["partLines", "Tire part lines"], ["tireQuantity", "Tire quantity"], ["dotEntries", "DOT entries"]] as const).map(([key, label]) => <article className="panel border-t-2 !border-t-[#8aacc7] px-4 py-4" key={key}><h3 className="text-[11px] font-bold uppercase tracking-wide text-slate-500">{label}</h3>{!result && pending ? <div className="mt-3 h-8 w-20 rounded bg-slate-100 motion-safe:animate-pulse" aria-label="Awaiting count" /> : <p className="mt-2 text-3xl font-semibold tabular-nums tracking-tight text-[#174b78]">{result ? result.counts[key].toLocaleString() : "—"}</p>}<p className="mt-2 text-[11px] text-slate-500">{result ? "Executed population" : "Available after Run"}</p></article>)}
    </div>
    <div className="panel overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 p-4">
        <div className="flex flex-wrap gap-1" role="group" aria-label="Tire DOT result view">{([["details", "Tire / DOT details"], ["exceptions", "Exceptions"], ["invoices", "Invoice reconciliation"]] as const).map(([key, label]) => <button type="button" key={key} aria-pressed={view === key} onClick={() => { setView(key); setPage(1); }} className={`rounded-md px-3 py-2 text-xs font-bold transition-opacity hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#347bbd] ${view === key ? "bg-[#edf7fd] text-[#174b78]" : "text-slate-500"}`}>{label}</button>)}</div>
        <div className="flex flex-wrap gap-2">{(["details", "invoices"] as const).map(kind => <button key={kind} type="button" className="action secondary text-xs" disabled={!snapshot || exporting !== null || locationsLoading || Boolean(locationsError)} onClick={() => void download(kind)}><Download className="h-3 w-3" aria-hidden="true" />{exporting === kind ? "Preparing…" : kind === "details" ? "Details CSV" : "Invoice CSV"}</button>)}</div>
      </div>
      <p className="border-b border-slate-100 px-4 py-3 text-xs leading-5 text-slate-500">{view === "exceptions" ? "Detail rows with reported exceptions; invoice-level exceptions remain visible in reconciliation. Details CSV includes all detail rows, not just exceptions." : view === "invoices" ? "One row per returned invoice for reconciliation. These counts are not interchangeable with part lines, tire quantity, or DOT entries." : "A part line may have multiple DOT entries. Quantity can repeat across entries; use the separate tire quantity total rather than summing detail rows."} CSV downloads use the executed report, not the current page or draft filters.</p>
      {exportError && <p role="alert" className="border-b border-red-200 bg-red-50 px-4 py-3 text-xs text-red-900">{exportError} Use the CSV button to retry.</p>}
      {visible.length ? <div className="overflow-x-auto"><table className="w-full border-collapse"><caption className="sr-only">{view === "invoices" ? "Invoice reconciliation" : view === "exceptions" ? "Tire DOT detail exceptions" : "Tire DOT details"} · executed date range {result?.dateRange.start} through {result?.dateRange.end}</caption><thead className="bg-slate-50 text-slate-500"><tr>{["Location / invoice", "Posted date (UTC)", "Vehicle / VIN", "Invoice mileage", ...(view === "invoices" ? ["Part lines", "Tire quantity", "DOT entries"] : ["Part / brand", "Quantity", "DOT", "Source identifiers"]), "Exceptions"].map(heading => <th scope="col" className={`${cell} whitespace-nowrap font-bold`} key={heading}>{heading}</th>)}</tr></thead><tbody>{visible.map(row => <tr key={row.key} className="text-slate-700 hover:bg-[#f4f8fc]"><th scope="row" className={`${cell} min-w-40 font-normal`}><strong className="block font-semibold">{row.location}</strong><span className="mt-1 block">Invoice {display(row.invoiceNumber)}</span><span className="mt-1 block text-[10px] text-slate-500">Shop {row.shopId} · RO {row.providerRoId}</span></th><td className={`${cell} whitespace-nowrap`}>{display(row.postedDate)}</td><td className={`${cell} min-w-44`}><span className="block">{display(row.vehicle)}</span><span className="mt-1 block font-mono text-[11px]">{display(row.vin)}</span></td><td className={`${cell} tabular-nums`}>{display(row.mileage)}</td>{"partLines" in row ? <><td className={`${cell} tabular-nums`}>{display(row.partLines)}</td><td className={`${cell} tabular-nums`}>{display(row.tireQuantity)}</td><td className={`${cell} tabular-nums`}>{display(row.dotEntries)}</td></> : <><td className={`${cell} min-w-48`}><span className="block">{display(row.description)}</span><span className="mt-1 block text-slate-500">{display(row.brand)}</span></td><td className={`${cell} tabular-nums`}>{display(row.quantity)}</td><td className={`${cell} whitespace-nowrap font-mono`}>{display(row.dot)}</td><td className={`${cell} min-w-36 font-mono text-[10px]`}>Job {display(row.jobId)}<br />Part {display(row.partId)}<br />Entry {display(row.entryIndex)}</td></>}<td className={`${cell} min-w-44`}>{row.exceptions.length ? <ul className="space-y-1 text-amber-800">{row.exceptions.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}</ul> : <span className="text-slate-400">None reported</span>}</td></tr>)}</tbody></table></div> : <div className="px-6 py-10 text-center" role="status"><FileSpreadsheet aria-hidden="true" className="mx-auto mb-3 h-7 w-7 text-[#8aacc7]" /><h3 className="text-sm font-semibold text-slate-700">{!result ? pending ? "Collecting stored evidence" : "Ready to trace your tire records" : view === "exceptions" ? "No detail exceptions returned" : "No rows returned for this execution"}</h3><p className="mx-auto mt-2 max-w-xl text-xs leading-5 text-slate-500">{!result ? "Select dates and authorized locations, then click Run report. No report is generated automatically." : incomplete || result.limited ? "Coverage is incomplete or limited. An empty view does not mean no tire sales occurred. Review coverage above and narrow the execution if needed." : "This describes only the returned stored evidence, not all upstream sales. Try another date range or location; review invoice reconciliation for invoice-level exceptions."}</p></div>}
      {result && <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 text-xs text-slate-500"><p aria-live="polite">{rows.length ? `${(currentPage - 1) * PAGE_SIZE + 1}–${Math.min(currentPage * PAGE_SIZE, rows.length)} of ${rows.length.toLocaleString()} rows` : "0 rows"} · 50 per page</p><div className="flex items-center gap-3"><button type="button" className="action secondary" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>Previous</button><span>Page {currentPage} of {pages}</span><button type="button" className="action secondary" disabled={currentPage >= pages} onClick={() => setPage(currentPage + 1)}>Next</button></div></div>}
    </div>
    <details className="panel px-5 py-4"><summary className="cursor-pointer text-xs font-bold text-[#28679f]">Reading this report and reconciling exports</summary><div className="mt-3 max-w-3xl space-y-2 text-xs leading-5 text-slate-600"><p>Posted dates use UTC calendar boundaries, inclusive of both selected days. Missing posted dates or raw evidence can prevent records from being included.</p><p>Details preserve job, part and DOT entry identifiers. A missing DOT value is not proof that no tire was sold. Exceptions identify evidence that needs review; an absence of exceptions does not certify compliance.</p><p>Invoice reconciliation rolls returned tire evidence up to invoices. Invoices, tire part lines, tire quantity and DOT entries are distinct measures. Mileage is the value captured on each invoice.</p><p className="rounded border border-[#c7dfef] bg-[#edf7fd] p-3 text-[#174b78]"><strong>The all-invoices export is a different population.</strong> An all-invoices export elsewhere in reporting can include invoices without tire evidence. It is not interchangeable with this report’s Invoice CSV, and totals should not be assumed to match.</p><p>CSV downloads contain the returned execution, including any reported coverage limitations. Local pagination and the Exceptions view do not narrow the CSV.</p></div></details>
  </section>;
}
