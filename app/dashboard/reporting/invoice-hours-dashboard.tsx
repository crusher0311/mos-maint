"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, FileSpreadsheet, Play } from "lucide-react";
import type { DeclarativeReportResult, ReportDefinitionV1 } from "@/lib/report-definition-contract";
import { buildReportRunRequest } from "@/lib/report-run-request";
import { reportFailureText, type ReportRunFailure } from "@/lib/report-run-failure";
import { hoursDisplay, summarizeInvoiceHours } from "./invoice-hours-summary";
import styles from "./invoice-hours-dashboard.module.css";

type Scope = { kind: "shop" | "enterprise" | "platform"; shopId?: number; enterpriseId?: string };
type Result = DeclarativeReportResult & { metadata: DeclarativeReportResult["metadata"] & {
  executedRange?: { start: string; end: string };
  executedScope?: { kind: Scope["kind"]; shopIds: number[]; enterpriseId?: string };
} };
type RunResponse = {
  runId?: string; status?: string; stage?: string; result?: Result; generatedAt?: string;
  stale?: boolean; cache?: string; error?: ReportRunFailure;
};
type Snapshot = { result: Result; stale: boolean };

function defaultRange(initial?: { start?: string; end?: string }) {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 29);
  return { start: initial?.start || start.toISOString().slice(0, 10), end: initial?.end || end.toISOString().slice(0, 10) };
}
function coverage(covered: number | null, count: number | null) {
  return `${covered === null ? "Unknown" : covered.toLocaleString()} covered / ${count === null ? "unknown" : count.toLocaleString()} eligible invoices`;
}
function executedLocation(result: Result) {
  const filter = result.metadata.selectedFilters?.find(item => item.dimension === "location" && item.operator === "eq");
  if (!filter) return "All authorized locations";
  const row = result.rows.find(item => item.key === filter.value || String(item.shopId) === filter.value);
  return row?.label || "Selected location (name unavailable)";
}

export function InvoiceHoursDashboard({ scope, initialRange }: {
  scope: Scope; initialRange?: { start?: string; end?: string; locationId?: string };
}) {
  const [range, setRange] = useState(() => defaultRange(initialRange));
  const [location, setLocation] = useState(initialRange?.locationId || "");
  const [locations, setLocations] = useState<Array<{ key: string; label: string }>>([]);
  const [locationsError, setLocationsError] = useState("");
  const [locationsAttempt, setLocationsAttempt] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setLocations([]);
    setLocationsError("");
    const params = new URLSearchParams({ scope: scope.kind });
    if (scope.shopId != null) params.set("shopId", String(scope.shopId));
    if (scope.enterpriseId) params.set("enterpriseId", scope.enterpriseId);
    fetch(`/api/reports/locations?${params}`, { signal: abort.signal, cache: "no-store" })
      .then(async response => {
        if (!response.ok) throw new Error("locations");
        const json = await response.json();
        if (!Array.isArray(json.locations)) throw new Error("locations");
        if (!abort.signal.aborted) setLocations(json.locations);
      })
      .catch(() => {
        if (!abort.signal.aborted) setLocationsError("Could not load authorized locations. Retry loading locations or switch reporting scope.");
      });
    return () => abort.abort();
  }, [scope.kind, scope.shopId, scope.enterpriseId, locationsAttempt]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [run, setRun] = useState<RunResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const activeRun = useRef("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => {
    generation.current += 1;
    activeRun.current = "";
    controller.current?.abort();
  }, []);

  const accept = (json: RunResponse) => {
    setRun(json);
    if (json.result) {
      setSnapshot({ result: json.result, stale: Boolean(json.stale || json.cache === "stale" || json.cache === "refreshing") });
    }
    if (json.error) setError(reportFailureText(json.error));
    if (json.status === "succeeded") setNotice("Report complete.");
    else if (json.status === "failed") {
      setNotice("");
      setError(json.error ? reportFailureText(json.error) : "Report failed. Click Run to retry.");
    }
    else if (json.status === "cancelled") setNotice("Report cancelled. Click Run to try again.");
  };

  const runReport = async () => {
    if (!range.start || !range.end || range.start > range.end) return;
    const token = ++generation.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    activeRun.current = "";
    setSubmitting(true); setRun(null); setError(""); setNotice("Queuing report…");
    const definition: ReportDefinitionV1 = {
      version: 1, id: "invoice-hours-dashboard-v1", name: "Invoice hours dashboard",
      dateRange: { ...range },
      // The deployed KPI catalog supplies these two invoice metrics.
      metrics: ["averagePresentedHoursPerInvoice", "averageSoldHoursPerInvoice"] as ReportDefinitionV1["metrics"],
      dimensions: ["location"], comparison: { mode: "none" },
      filters: location ? [{ dimension: "location", operator: "eq", value: location }] : [],
      presentation: { kind: "table", limit: 500, orderBy: "dimension", direction: "asc" },
    };
    try {
      const response = await fetch("/api/reports/runs", {
        method: "POST", credentials: "include", signal: abort.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildReportRunRequest({ appliedDefinition: definition, scope, force: Boolean(snapshot || run?.status === "failed" || run?.status === "cancelled") })),
      });
      const json = await response.json();
      if (token !== generation.current) return;
      if (!response.ok) throw new Error(typeof json.error === "string" ? json.error : "Report could not be queued. Click Run to retry.");
      activeRun.current = json.runId || "";
      setNotice("");
      accept(json);
      if (json.status === "queued" || json.status === "running") setNotice("Building in the background. Previous results remain visible.");
      if (json.cache === "hit") setNotice("Loaded the latest cached result.");
    } catch (failure) {
      if (token === generation.current) { setError(failure instanceof Error ? failure.message : "Report could not be queued."); setNotice(""); }
    } finally { if (token === generation.current) setSubmitting(false); }
  };

  useEffect(() => {
    const id = run?.runId;
    if (!id || (run.status !== "queued" && run.status !== "running")) return;
    const token = generation.current;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const abort = new AbortController();
    const poll = async () => {
      try {
        const response = await fetch(`/api/reports/runs/${encodeURIComponent(id)}`, { credentials: "include", signal: abort.signal });
        const json: RunResponse = await response.json();
        if (disposed || token !== generation.current || activeRun.current !== id) return;
        if (!response.ok) throw new Error("Progress could not be loaded. Retrying automatically; previous results remain visible.");
        setError("");
        accept({ ...json, runId: id });
      } catch (failure) {
        if (!disposed && token === generation.current) setError(failure instanceof Error ? failure.message : "Progress unavailable. Retrying automatically.");
      }
      if (!disposed) timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, 2000);
    return () => { disposed = true; clearTimeout(timer); abort.abort(); };
    // Snapshot acceptance is deliberately not a polling dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.runId, run?.status]);

  const result = snapshot?.result;
  const summary = result ? summarizeInvoiceHours(result.rows) : null;
  const pending = submitting || run?.status === "queued" || run?.status === "running";
  const valid = Boolean(range.start && range.end && range.start <= range.end);
  const metadata = result?.metadata;
  const executed = metadata?.executedRange;
  const executedScope = metadata?.executedScope;
  const changed = Boolean(result && (range.start !== executed?.start || range.end !== executed?.end
    || location !== (metadata?.selectedFilters?.find(filter => filter.dimension === "location" && filter.operator === "eq")?.value || "")));

  return <section className={`${styles.dashboard} space-y-4`} aria-label="Invoice hours dashboard">
    <div className="panel p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-2"><div><h2 className="text-lg font-bold tracking-tight">Invoice hours</h2><p className="mt-1 text-xs text-slate-500">Presented and sold labor, measured against the same verified invoices. Open work is excluded.</p></div><span className="rounded border border-[#c7dfef] bg-[#edf7fd] px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-[#28679f]">Invoice-based · no comparison</span></div>
      <form onSubmit={event => { event.preventDefault(); void runReport(); }} className="grid items-end gap-3 md:grid-cols-[1fr_1fr_1.4fr_auto]">
        <label className="text-xs font-bold text-slate-700">Start date<input required type="date" value={range.start} onChange={event => setRange(current => ({ ...current, start: event.target.value }))} className="filter mt-1 block w-full" /></label>
        <label className="text-xs font-bold text-slate-700">End date<input required type="date" min={range.start} value={range.end} onChange={event => setRange(current => ({ ...current, end: event.target.value }))} className="filter mt-1 block w-full" /></label>
        <label className="text-xs font-bold text-slate-700">Location<select aria-label="Location" value={location} onChange={event => setLocation(event.target.value)} className="filter mt-1 block w-full"><option value="">All authorized locations</option>{location && !locations.some(item => item.key === location) && <option value={location}>Linked location — run to resolve name</option>}{locations.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label>
        <button type="submit" className="action primary justify-center" disabled={pending || !valid}><Play className="h-4 w-4" />{submitting ? "Queuing…" : pending ? "Building…" : "Run"}</button>
      </form>
      <p className="mt-3 text-xs text-slate-500">{!valid ? "Choose a valid start and end date." : changed ? "Selection changed. Click Run to apply; displayed results still use the executed context below." : "Nothing runs when you change a control. Choose a location before clicking Run to narrow large reports."}</p>
      {locationsError && <p role="alert" className="mt-2 text-xs text-red-700">{locationsError} <button type="button" className="underline" onClick={() => setLocationsAttempt(value => value + 1)}>Retry loading locations</button></p>}
    </div>
    {error && <div role="alert" className="rounded-md border border-red-300 bg-red-50 p-3 text-xs text-red-900">{error}{!pending && " Use Run above to retry."}</div>}
    {notice && <p role="status" className="text-xs text-[#28679f]">{notice}{pending && run?.stage ? ` Stage: ${run.stage.replaceAll("_", " ")}.` : ""}</p>}
    {result && <div className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
      <div><strong className="block text-slate-800">Executed results · {executedLocation(result)}</strong><span>{executed ? `${executed.start} – ${executed.end} · UTC invoice dates` : "Executed dates unavailable"} · {executedScope ? `${executedScope.kind} scope · ${executedScope.shopIds.length} authorized location${executedScope.shopIds.length === 1 ? "" : "s"}` : "Executed scope unavailable"}</span></div>
      <div>Generated {result.generatedAt && !Number.isNaN(Date.parse(result.generatedAt)) ? new Date(result.generatedAt).toLocaleString() : "time unavailable"}<span className="mt-1 block font-semibold">{snapshot.stale ? "Stale cached result" : pending ? "Previous result · refresh in progress" : "Latest returned result"}</span></div>
    </div>}
    {result && (!executed || !executedScope) && <p className="text-xs text-amber-800">Executed context metadata is unavailable. Draft selections are not used to label these results.</p>}
    {result && <p className="text-xs leading-5 text-slate-600">Coverage is based on stored records, not a guarantee that all provider history was imported. Only verified Protractor invoices are currently supported; other providers, separate credits and invoices without verifiable identity or dates remain unavailable.</p>}
    {summary && (summary.unknown === null || summary.unknown > 0) && <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs leading-5 text-amber-900"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span><strong>Invoice population uncertain.</strong> {summary.unknown === null ? "Population coverage was not supplied." : `${summary.unknown.toLocaleString()} record(s) have an unverified invoice population.`} Unsupported populations cannot produce a reliable per-invoice average; this is distinct from missing labor-hour coverage.</span></div>}
    <div className="grid gap-4 md:grid-cols-2">
      {(["presented", "sold"] as const).map(kind => <article key={kind} className={`${styles.card} ${kind === "sold" ? styles.cardSold : ""}`}>
        <h3 className="text-xs font-bold uppercase tracking-[.08em] text-slate-600">Average {kind} hours per invoice</h3>
        {!summary && pending ? <div className={styles.skeleton} aria-label="Waiting for results" /> : <p className={`${styles.value} mt-4 ${summary?.[kind].value != null ? "text-5xl" : "text-2xl"} font-semibold text-[#174b78]`}>{summary ? hoursDisplay(summary[kind].value, summary.count, summary.unknown) : "Not run yet"}</p>}
        <p className="mt-2 text-xs text-slate-500">{summary?.[kind].value != null ? "hours / invoice" : "Only complete, verified data produces an average."}</p>
        <p className="mt-5 border-t border-slate-200 pt-3 text-xs font-semibold text-slate-700">{summary ? coverage(summary[kind].covered, summary.count) : "Coverage will appear after Run"}</p>
      </article>)}
    </div>
    <div className="panel overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4"><h3 className="text-sm font-bold">By location</h3><span className="text-xs text-slate-500">{result ? `${result.rows.length} returned locations` : "Executed results"}</span></div>
      {result?.rows.length ? <div className="overflow-x-auto"><table className={styles.table}><caption className="sr-only">Invoice labor hours and coverage by location for the executed report</caption><thead><tr><th scope="col">Location</th><th scope="col">Eligible invoices</th><th scope="col">Presented hrs / invoice</th><th scope="col">Sold hrs / invoice</th><th scope="col">Population unknown</th></tr></thead><tbody>{result.rows.map(row => {
        const item = summarizeInvoiceHours([row]);
        return <tr key={row.key}><th scope="row" className="!bg-transparent !text-xs !normal-case !tracking-normal text-slate-800">{row.label}</th><td>{item.count?.toLocaleString() ?? "Unknown"}</td>{(["presented", "sold"] as const).map(kind => <td key={kind}><strong className={item[kind].value === null ? "text-amber-800" : "text-slate-800"}>{hoursDisplay(item[kind].value, item.count, item.unknown)}</strong><span className="mt-1 block whitespace-nowrap text-[11px] text-slate-500">{coverage(item[kind].covered, item.count)}</span></td>)}<td className={item.unknown ? "font-semibold text-amber-800" : "text-slate-500"}>{item.unknown?.toLocaleString() ?? "Unknown"}</td></tr>;
      })}</tbody></table></div> : <div className="px-6 py-10 text-center"><FileSpreadsheet className="mx-auto mb-3 h-6 w-6 text-[#8aacc7]" /><p className="text-sm font-semibold text-slate-700">{result ? "No invoices found for this execution" : pending ? "Your first report is building" : "Ready when you are"}</p><p className="mt-1 text-xs text-slate-500">{result ? "Change the dates or location, then click Run." : "Choose dates and click Run. No report queries are made until then."}</p></div>}
      {metadata?.truncated && <p className="border-t border-amber-200 bg-amber-50 px-5 py-3 text-xs text-amber-900">Results are limited to 500 locations. Cards combine only the returned rows, not the full scope.</p>}
    </div>
    <details className="panel px-5 py-4"><summary className="cursor-pointer text-xs font-bold text-[#28679f]">How these numbers are calculated</summary><div className="mt-3 max-w-3xl space-y-2 text-xs leading-5 text-slate-600"><p><strong>Sold:</strong> invoiced labor hours divided by the same verified invoices.</p><p><strong>Presented:</strong> sold labor plus explicitly declined or deferred labor on those same invoices, divided by those invoices. Open work is excluded.</p><p>Each metric needs complete labor-hour coverage and a verified invoice population. Presented and sold coverage are checked independently. Missing hours are not zero; uncertain or unsupported invoice populations do not produce an average.</p><p>Cards add unrounded labor-hour totals and invoice counts across returned locations, then divide. They never average the location averages.</p><p className="rounded border border-[#c7dfef] bg-[#edf7fd] p-3 text-[#174b78]"><strong>Fictional example, not your data:</strong> 100 verified invoices with 300 presented hours and 200 sold hours yield <strong>3.00</strong> presented and <strong>2.00</strong> sold hours per invoice.</p></div></details>
  </section>;
}
