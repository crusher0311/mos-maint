"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, CalendarDays, Check, Copy, Download, Eye, Save, Trash2 } from "lucide-react";
import {
  REPORT_DIMENSIONS,
  REPORT_METRICS,
  REPORT_PRESENTATIONS,
  type DeclarativeReportResult,
  type ReportDefinitionV1,
  type ReportDimension,
  type ReportMetric,
  type ReportPresentationKind,
  type ReportFilterOperator,
} from "@/lib/report-definition-contract";
import { REPORTING_KPI_CATALOG } from "@/lib/reporting-kpi-contract";
import type { AiReportProposal } from "@/lib/custom-report-ai";

type Scope = { kind: "shop" | "enterprise" | "platform"; shopId?: number; enterpriseId?: string };
type SavedReport = {
  id: string;
  name: string;
  ownerEmail?: string;
  currentVersion?: number;
  version?: number;
  definition?: ReportDefinitionV1;
  currentDefinition?: ReportDefinitionV1;
  sharing?: { visibility: "private" | "shop" | "enterprise" };
  updatedAt?: string;
};

function initialDefinition(): ReportDefinitionV1 {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 29);
  return {
    version: 1,
    id: crypto.randomUUID(),
    name: "Custom performance report",
    dateRange: { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) },
    metrics: ["billedRevenue", "repairOrderCount"],
    dimensions: ["location"],
    comparison: { mode: "previousPeriod" },
    presentation: { kind: "table", limit: 25, orderBy: "billedRevenue", direction: "desc" },
  };
}

export function CustomReportBuilder({ scope }: { scope: Scope }) {
  const [definition, setDefinition] = useState<ReportDefinitionV1>(() => initialDefinition());
  const [appliedDefinition, setAppliedDefinition] = useState<ReportDefinitionV1>(definition);
  const [saved, setSaved] = useState<SavedReport[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [selectedVersion, setSelectedVersion] = useState<number | undefined>();
  const [visibility, setVisibility] = useState<"private" | "shop" | "enterprise">("private");
  const [aiText, setAiText] = useState("");
  const [proposal, setProposal] = useState<AiReportProposal | null>(null);
  const [result, setResult] = useState<DeclarativeReportResult | null>(null);
  const [busy, setBusy] = useState<"ai" | "preview" | "save" | "export" | "schedule" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [recipientEmail, setRecipientEmail] = useState("");
  const [cadence, setCadence] = useState<"weekly" | "monthly">("weekly");
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");

  const loadSaved = useCallback(async () => {
    try {
      const query = new URLSearchParams({ scope: scope.kind });
      if (scope.shopId) query.set("shopId", String(scope.shopId));
      if (scope.enterpriseId) query.set("enterpriseId", scope.enterpriseId);
      const response = await fetch(`/api/reports/custom?${query}`, { credentials: "include" });
      const json = await response.json();
      if (response.ok) setSaved(Array.isArray(json) ? json : json.reports || []);
    } catch { /* Builder remains usable if the saved-report list is unavailable. */ }
  }, [scope.enterpriseId, scope.kind, scope.shopId]);
  useEffect(() => { void loadSaved(); }, [loadSaved]);

  const selectedMetrics = new Set(definition.metrics);
  const metricDefinitions = useMemo(
    () => REPORTING_KPI_CATALOG.filter(item => definition.metrics.includes(item.key as ReportMetric)),
    [definition.metrics],
  );
  const update = (patch: Partial<ReportDefinitionV1>) => {
    setDefinition(current => ({ ...current, ...patch }));
    setResult(null);
  };
  const isApplied = JSON.stringify(definition) === JSON.stringify(appliedDefinition);
  const applyChanges = () => {
    setAppliedDefinition(structuredClone(definition));
    setResult(null);
    setMessage("Changes applied. You can now preview this definition.");
  };
  const toggleMetric = (metric: ReportMetric) => {
    const metrics = definition.metrics.includes(metric) ? definition.metrics.filter(item => item !== metric) : [...definition.metrics, metric];
    if (!metrics.length || metrics.length > 6) return;
    update({ metrics, presentation: { ...definition.presentation, orderBy: metrics.includes(definition.presentation.orderBy as ReportMetric) ? definition.presentation.orderBy : metrics[0] } });
  };

  const compose = async () => {
    if (!aiText.trim()) return;
    setBusy("ai"); setMessage(null); setProposal(null);
    try {
      const response = await fetch("/api/reports/custom/compose", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: aiText }) });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "Proposal could not be created.");
      setProposal(json.proposal);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Proposal could not be created."); }
    finally { setBusy(null); }
  };
  const applyProposal = () => {
    if (!proposal) return;
    update({
      ...proposal.definition,
      id: definition.id,
      version: 1,
      dateRange: proposal.definition.dateRange ?? definition.dateRange,
      comparison: proposal.definition.comparison ?? definition.comparison,
      filters: proposal.definition.filters ?? definition.filters,
    });
    setProposal(null);
    setMessage("Proposal applied. Review it, then preview when ready.");
  };
  const preview = async () => {
    setBusy("preview"); setMessage(null); setResult(null);
    try {
      const response = await fetch("/api/reports/custom/preview", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ definition: appliedDefinition, scope }) });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "Preview could not be generated.");
       setResult(json.result || json);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Preview could not be generated."); }
    finally { setBusy(null); }
  };
  const save = async () => {
    setBusy("save"); setMessage(null);
    try {
      const payload = { name: definition.name, definition, scope, sharing: { visibility } };
      const response = await fetch(selectedId ? `/api/reports/custom/${selectedId}` : "/api/reports/custom", { method: selectedId ? "PATCH" : "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "Report could not be saved.");
       const report = json.report || json;
       setSelectedId(report.id || json.id || selectedId);
       setSelectedVersion(report.currentVersion || report.version || selectedVersion);
       setMessage(`Report saved${report.currentVersion || report.version ? ` as version ${report.currentVersion || report.version}` : ""}.`);
      await loadSaved();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Report could not be saved."); }
    finally { setBusy(null); }
  };
  const exportSaved = async () => {
    if (!selectedId) { setMessage("Save this report before exporting its governed version."); return; }
    setBusy("export"); setMessage(null);
    try {
      const params = new URLSearchParams({ reportId: selectedId });
      if (selectedVersion) params.set("reportVersion", String(selectedVersion));
      const response = await fetch(`/api/reports/export?${params}`, { credentials: "include" });
      if (!response.ok) { const json = await response.json(); throw new Error(json.error || "Export could not be prepared."); }
      const blob = await response.blob(); const href = URL.createObjectURL(blob); const link = document.createElement("a");
      link.href = href; link.download = `${definition.name.replace(/[^\w]+/g, "-") || "report"}.csv`; link.click(); URL.revokeObjectURL(href);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Export could not be prepared."); }
    finally { setBusy(null); }
  };
  const saveSchedule = async () => {
    if (!selectedId || !selectedVersion) { setMessage("Save the report and its version before scheduling."); return; }
    if (!recipientEmail.trim()) { setMessage("A recipient email is required."); return; }
    setBusy("schedule"); setMessage(null);
    try {
      const payload = { reportId: selectedId, reportVersion: selectedVersion, recipientEmail: recipientEmail.trim(), cadence, timezone, sendHour: 8, dayOfWeek: cadence === "weekly" ? 1 : undefined, dayOfMonth: cadence === "monthly" ? 1 : undefined, scope };
      const response = await fetch("/api/reports/subscriptions", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "Schedule could not be saved.");
      setScheduleOpen(false); setMessage(`Scheduled version ${selectedVersion} for delivery.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Schedule could not be saved."); }
    finally { setBusy(null); }
  };
  const remove = async () => {
    if (!selectedId || !window.confirm("Delete this saved report?")) return;
    const response = await fetch(`/api/reports/custom/${selectedId}`, { method: "DELETE", credentials: "include" });
    if (response.ok) { const next = initialDefinition(); setSelectedId(""); setSelectedVersion(undefined); setDefinition(next); setAppliedDefinition(next); setResult(null); await loadSaved(); }
    else setMessage("Report could not be deleted.");
  };
  const duplicate = async () => {
    if (!selectedId) return;
    setMessage(null);
    const response = await fetch(`/api/reports/custom/${selectedId}/duplicate`, {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `${definition.name} copy` }),
    });
    const json = await response.json();
    if (!response.ok) { setMessage(json.error || "Report could not be duplicated."); return; }
    await loadSaved();
    setSelectedId(json.report.id);
    setDefinition(json.report.definition);
    setAppliedDefinition(json.report.definition);
    setSelectedVersion(json.report.currentVersion || json.report.version);
    setVisibility("private");
    setResult(null);
    setMessage("Private copy created.");
  };
  const selectSaved = (id: string) => {
    setSelectedId(id);
    if (!id) { const next = initialDefinition(); setDefinition(next); setAppliedDefinition(next); setSelectedVersion(undefined); setVisibility("private"); setResult(null); return; }
    const item = saved.find(report => report.id === id);
    const next = item?.definition || item?.currentDefinition;
    if (next) { setDefinition(next); setAppliedDefinition(next); setSelectedVersion(item?.currentVersion || item?.version); setVisibility(item?.sharing?.visibility || "private"); setResult(null); }
  };

  return <section className="panel overflow-hidden">
    <div className="border-b border-slate-100 px-5 py-4">
       <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-base font-bold text-slate-900">Custom report builder</h2><p className="mt-1 text-xs text-slate-500">Choose governed metrics and dimensions. Apply changes before querying a preview.</p>{selectedId && <p className="mt-1 text-xs font-semibold text-[#28679f]">Saved report · version {selectedVersion || "loading"}</p>}</div>
         <div className="flex flex-wrap gap-2"><select aria-label="Saved reports" value={selectedId} onChange={event => selectSaved(event.target.value)} className="filter"><option value="">New report</option>{saved.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><select aria-label="Report visibility" className="filter" value={visibility} onChange={event => setVisibility(event.target.value as typeof visibility)}><option value="private">Private</option>{scope.kind === "shop" && <option value="shop">Shop</option>}{scope.kind === "enterprise" && <option value="enterprise">Enterprise</option>}</select><button className="action secondary" disabled={busy === "save"} onClick={() => void save()}><Save className="h-4 w-4" />Save</button>{selectedId && <><button className="action secondary" disabled={busy === "export"} onClick={() => void exportSaved()}><Download className="h-4 w-4" />Export</button><button className="action secondary" onClick={() => setScheduleOpen(true)}><CalendarDays className="h-4 w-4" />Schedule</button><button className="icon" title="Duplicate report" onClick={() => void duplicate()}><Copy className="h-4 w-4" /></button><button className="icon text-rose-700" title="Delete report" onClick={() => void remove()}><Trash2 className="h-4 w-4" /></button></>}</div>
      </div>
    </div>
    <div className="grid gap-5 p-5 xl:grid-cols-[1fr_1fr]">
      <div className="space-y-5">
        <label className="block text-xs font-bold text-slate-700">Report name<input className="filter mt-1 w-full" maxLength={80} value={definition.name} onChange={event => update({ name: event.target.value })} /></label>
        <fieldset><legend className="text-xs font-bold text-slate-700">Metrics (up to 6)</legend><div className="mt-2 grid gap-2 sm:grid-cols-2">{REPORTING_KPI_CATALOG.map(metric => <label key={metric.key} className={`cursor-pointer rounded-md border p-3 text-xs ${selectedMetrics.has(metric.key as ReportMetric) ? "border-[#4d91c9] bg-[#edf7fd]" : "border-slate-200 bg-white"}`}><input type="checkbox" className="mr-2" checked={selectedMetrics.has(metric.key as ReportMetric)} onChange={() => toggleMetric(metric.key as ReportMetric)} /><strong>{metric.label}</strong><span className="mt-1 block leading-4 text-slate-500">{metric.definition}</span></label>)}</div></fieldset>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-xs font-bold text-slate-700">Group by<select className="filter mt-1 w-full" value={definition.dimensions[0]} onChange={event => { const dimension = event.target.value as ReportDimension; update({ dimensions: [dimension], presentation: { ...definition.presentation, kind: dimension === "none" ? "scorecard" : dimension === "date" ? "timeSeries" : definition.presentation.kind === "scorecard" || definition.presentation.kind === "timeSeries" ? "table" : definition.presentation.kind } }); }}>{REPORT_DIMENSIONS.map(item => <option key={item} value={item}>{item}</option>)}</select></label>
          <label className="text-xs font-bold text-slate-700">Display<select className="filter mt-1 w-full" value={definition.presentation.kind} onChange={event => update({ presentation: { ...definition.presentation, kind: event.target.value as ReportPresentationKind } })}>{REPORT_PRESENTATIONS.filter(item => item === "table" || (item === "scorecard" && definition.dimensions[0] === "none") || (item === "timeSeries" && definition.dimensions[0] === "date")).map(item => <option key={item} value={item}>{item}</option>)}</select></label>
          <label className="text-xs font-bold text-slate-700">Rows<input type="number" min={1} max={100} className="filter mt-1 w-full" value={definition.presentation.limit || 25} onChange={event => update({ presentation: { ...definition.presentation, limit: Math.max(1, Math.min(100, Number(event.target.value))) } })} /></label>
        </div>
        <div className="grid gap-3 sm:grid-cols-2"><label className="text-xs font-bold text-slate-700">Start<input type="date" className="filter mt-1 w-full" value={definition.dateRange.start} onChange={event => update({ dateRange: { ...definition.dateRange, start: event.target.value } })} /></label><label className="text-xs font-bold text-slate-700">End<input type="date" className="filter mt-1 w-full" value={definition.dateRange.end} onChange={event => update({ dateRange: { ...definition.dateRange, end: event.target.value } })} /></label></div>
        <div className="grid gap-3 sm:grid-cols-3"><label className="text-xs font-bold text-slate-700">Compare<select className="filter mt-1 w-full" value={definition.comparison?.mode || "none"} onChange={event => update({ comparison: { mode: event.target.value as NonNullable<ReportDefinitionV1["comparison"]>["mode"] } })}><option value="none">No comparison</option><option value="previousPeriod">Previous period</option><option value="custom">Custom range</option></select></label><label className="text-xs font-bold text-slate-700">Sort by<select className="filter mt-1 w-full" value={definition.presentation.orderBy || "dimension"} onChange={event => update({ presentation: { ...definition.presentation, orderBy: event.target.value as "dimension" | ReportMetric } })}><option value="dimension">Group label</option>{definition.metrics.map(metric => <option key={metric} value={metric}>{metric}</option>)}</select></label><label className="text-xs font-bold text-slate-700">Order<select className="filter mt-1 w-full" value={definition.presentation.direction || "desc"} onChange={event => update({ presentation: { ...definition.presentation, direction: event.target.value as "asc" | "desc" } })}><option value="desc">Descending</option><option value="asc">Ascending</option></select></label></div>
        {definition.comparison?.mode === "custom" && <div className="grid gap-3 sm:grid-cols-2"><label className="text-xs font-bold text-slate-700">Comparison start<input type="date" className="filter mt-1 w-full" value={definition.comparison.range?.start || ""} onChange={event => update({ comparison: { mode: "custom", range: { start: event.target.value, end: definition.comparison?.range?.end || "" } } })} /></label><label className="text-xs font-bold text-slate-700">Comparison end<input type="date" className="filter mt-1 w-full" value={definition.comparison.range?.end || ""} onChange={event => update({ comparison: { mode: "custom", range: { start: definition.comparison?.range?.start || "", end: event.target.value } } })} /></label></div>}
        <FilterControls definition={definition} update={update} />
      </div>
      <div className="space-y-4">
        <div className="rounded-lg border border-[#b7d3e8] bg-[#f0f8fd] p-4"><div className="flex items-center gap-2 text-sm font-bold text-[#174b78]"><Bot className="h-4 w-4" />Describe a report</div><p className="mt-1 text-xs text-slate-600">AI creates a proposal only. It cannot query data. You must explicitly apply the proposal before Preview.</p><textarea value={aiText} maxLength={2000} onChange={event => setAiText(event.target.value)} placeholder="Example: Compare billed revenue and average repair order by location." className="mt-3 min-h-20 w-full rounded-md border border-[#b7d3e8] bg-white p-2 text-sm" /><button disabled={busy === "ai" || !aiText.trim()} onClick={() => void compose()} className="action primary mt-2">{busy === "ai" ? "Composing…" : "Create proposal"}</button></div>
        {proposal && <div className="rounded-lg border border-amber-300 bg-amber-50 p-4"><p className="text-xs font-bold uppercase tracking-wide text-amber-900">Unapplied AI proposal</p><p className="mt-1 text-sm text-slate-700">{proposal.summary}</p><p className="mt-2 text-xs text-slate-600"><strong>{proposal.definition.name}</strong> · {proposal.definition.metrics.join(", ")} · grouped by {proposal.definition.dimensions.join(", ")}</p>{proposal.definition.dateRange && <p className="mt-1 text-xs text-slate-600">Dates: {proposal.definition.dateRange.start} – {proposal.definition.dateRange.end}</p>}{proposal.definition.comparison && <p className="mt-1 text-xs text-slate-600">Comparison: {proposal.definition.comparison.mode}</p>}{proposal.definition.filters !== undefined && <p className="mt-1 text-xs text-slate-600">Filters: {proposal.definition.filters.length ? `${proposal.definition.filters.length} selected` : "clear existing filters"}</p>}{proposal.warnings.map(warning => <p key={warning} className="mt-1 text-xs text-amber-800">Warning: {warning}</p>)}<div className="mt-3 flex gap-2"><button onClick={applyProposal} className="action primary"><Check className="h-4 w-4" />Apply proposal</button><button onClick={() => setProposal(null)} className="action secondary">Discard</button></div></div>}
         <button disabled={Boolean(busy) || Boolean(proposal) || !isApplied} onClick={() => void preview()} className="action primary w-full justify-center"><Eye className="h-4 w-4" />{proposal ? "Apply or discard proposal before preview" : !isApplied ? "Apply changes before preview" : busy === "preview" ? "Loading preview…" : "Preview report"}</button>
        {!isApplied && <button disabled={Boolean(busy) || Boolean(proposal)} onClick={applyChanges} className="action secondary w-full justify-center"><Check className="h-4 w-4" />Apply changes</button>}
        {message && <p role="status" className="rounded-md bg-slate-100 px-3 py-2 text-xs text-slate-700">{message}</p>}
        <div className="rounded-lg border border-slate-200 bg-white p-4"><h3 className="text-xs font-bold uppercase tracking-wide text-slate-600">Metric definitions & coverage</h3>{metricDefinitions.map(metric => <div key={metric.key} className="mt-3 border-t border-slate-100 pt-3"><p className="text-sm font-semibold">{metric.label}</p><p className="text-xs leading-5 text-slate-500">{metric.definition} <strong>Coverage:</strong> {metric.availability}</p></div>)}</div>
      </div>
    </div>
     {scheduleOpen && <ScheduleReportDialog email={recipientEmail} setEmail={setRecipientEmail} cadence={cadence} setCadence={setCadence} timezone={timezone} setTimezone={setTimezone} version={selectedVersion} onClose={() => setScheduleOpen(false)} onSave={() => void saveSchedule()} busy={busy === "schedule"} />}
     {result && <ReportPreview result={result} />}
  </section>;
}

function FilterControls({ definition, update }: { definition: ReportDefinitionV1; update: (patch: Partial<ReportDefinitionV1>) => void }) {
  const filter = definition.filters?.[0];
  const selectedDimension = definition.dimensions[0];
  if (selectedDimension === "none" || selectedDimension === "date") {
    return <p className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-500">Filters are available for location, advisor, technician, and recommendation source groupings.</p>;
  }
  const values = Array.isArray(filter?.value) ? filter.value.join(", ") : filter?.value || "";
  const setFilter = (patch: Partial<NonNullable<ReportDefinitionV1["filters"]>[number]>) => {
    const operator = patch.operator || filter?.operator || "eq";
    const raw = patch.value === undefined ? values : patch.value;
    const parsed = (Array.isArray(raw) ? raw : raw.split(",")).map(value => value.trim()).filter(Boolean).slice(0, 100).map(value => value.slice(0, 200));
    update({ filters: parsed.length ? [{ dimension: selectedDimension, operator, value: operator === "eq" || operator === "notEq" ? parsed[0] : parsed }] : undefined });
  };
  return <fieldset className="rounded-lg border border-slate-200 bg-slate-50 p-3"><legend className="px-1 text-xs font-bold text-slate-700">Filter {selectedDimension}</legend><p className="mb-2 text-[11px] text-slate-500">Use exact governed group keys. Values are comma-separated and limited to 100 values (200 characters each).</p><div className="grid gap-2 sm:grid-cols-[1fr_2fr]"><select aria-label="Filter operator" className="filter" value={filter?.operator || "eq"} onChange={event => setFilter({ operator: event.target.value as ReportFilterOperator })}>{(["eq", "notEq", "in", "notIn"] as const).map(item => <option key={item} value={item}>{item}</option>)}</select><input aria-label="Filter values" className="filter" maxLength={20100} value={values} placeholder="Value or comma-separated values" onChange={event => setFilter({ value: event.target.value })} /></div>{filter && <button className="mt-2 text-xs font-bold text-rose-700" onClick={() => update({ filters: undefined })}>Clear filter</button>}</fieldset>;
}

function ReportPreview({ result }: { result: DeclarativeReportResult }) {
  const metrics = result.metadata?.metrics || [];
  const metadata = result.metadata;
  const bounds = metadata?.bounds;
  const quality = metadata?.dataQuality;
  const unavailable = metadata?.coverage
    ? Object.entries(metadata.coverage).filter(([, available]) => !available).map(([key]) => key)
    : [];
  const qualityNotes = [
    ...(quality?.notes || []),
    ...(quality?.unknownAdvisorRepairOrders ? [`${quality.unknownAdvisorRepairOrders} repair orders have unknown advisor attribution.`] : []),
    ...(quality?.unknownTechnicianJobs ? [`${quality.unknownTechnicianJobs} jobs have unknown technician attribution.`] : []),
  ];
  const presentation = metadata?.presentation?.kind || "table";
  return <div className="border-t border-slate-200 p-5"><div className="flex items-center justify-between"><div><h3 className="text-sm font-bold">Preview</h3><p className="text-xs text-slate-500">{result.rows.length} rows · generated {new Date(result.generatedAt).toLocaleString()}</p></div><span className="text-xs text-slate-500">Query cost {bounds?.estimatedQueryCost ?? "Unavailable"}</span></div>
    <div className="mt-3 flex flex-wrap gap-2 text-xs">{bounds && <span className="rounded bg-slate-100 px-2 py-1">Bounds: {bounds.shops} shops · {bounds.days} days · {bounds.periods} period{bounds.periods === 1 ? "" : "s"} · cap {bounds.maxQueryCost.toLocaleString()}</span>}{metadata.truncated && <span className="rounded bg-amber-100 px-2 py-1 text-amber-900">Results truncated by the configured or provider row limit.</span>}{unavailable.length > 0 && <span className="rounded bg-amber-100 px-2 py-1 text-amber-900">Partial coverage: {unavailable.join(", ")}</span>}{qualityNotes.length > 0 && <span className="rounded bg-blue-50 px-2 py-1 text-blue-900">Data quality: {qualityNotes.join(" ")}</span>}{metadata.comparisonError && <span className="rounded bg-amber-100 px-2 py-1 text-amber-900">Comparison unavailable: {metadata.comparisonError.message}</span>}</div>
    {result.rows.length > 0 && presentation === "scorecard" && <ScorecardPreview result={result} />}
    {result.rows.length > 0 && presentation === "timeSeries" && <TimeSeriesPreview result={result} />}
    {result.rows.length > 0 && presentation === "table" && <ResultTable result={result} caption="Report results" />}
    {!result.rows.length && <p className="py-8 text-center text-sm text-slate-500">No rows matched this definition. Review the range and source coverage.</p>}
  </div>;
}

function metricColumns(result: DeclarativeReportResult) {
  return result.metadata.metrics.flatMap(metric => metric.valueKeys.map(key => ({
    id: `${metric.key}-${String(key)}`,
    key: String(key),
    label: `${metric.label}${metric.valueKeys.length > 1 ? ` · ${String(key)}` : ""}`,
  })));
}

function displayValue(value: number | null | undefined) {
  return value == null ? "Unavailable" : value.toLocaleString();
}

function ResultTable({ result, caption }: { result: DeclarativeReportResult; caption: string }) {
  const columns = metricColumns(result);
  return <div className="mt-3 overflow-x-auto"><table className="min-w-full divide-y divide-slate-200 text-left text-xs"><caption className="sr-only">{caption}</caption><thead><tr><th scope="col" className="px-3 py-2">Group</th>{columns.map(column => <th scope="col" key={column.id} className="px-3 py-2">{column.label}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{result.rows.map(row => <tr key={row.key}><th scope="row" className="px-3 py-2 font-medium">{row.label}</th>{columns.map(column => <td key={`${row.key}-${column.id}`} className="px-3 py-2">{displayValue(row.current[column.key])}</td>)}</tr>)}</tbody></table></div>;
}

function ScorecardPreview({ result }: { result: DeclarativeReportResult }) {
  const row = result.rows[0];
  const columns = metricColumns(result);
  return <section className="mt-4" aria-label="Scorecard results"><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{columns.map(column => <article key={column.id} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"><h4 className="text-xs font-bold text-slate-500">{column.label}</h4><p className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">{displayValue(row.current[column.key])}</p>{row.comparison && <p className="mt-2 text-xs text-slate-500">Comparison: {displayValue(row.comparison[column.key])}</p>}</article>)}</div>{result.rows.length > 1 && <p className="mt-2 text-xs text-slate-500">Scorecards summarize the first result group ({row.label}). Choose Table to inspect all {result.rows.length} groups.</p>}</section>;
}

function TimeSeriesPreview({ result }: { result: DeclarativeReportResult }) {
  const columns = metricColumns(result);
  const colors = ["#347bbd", "#d48a13", "#16836b", "#8b5cf6", "#dc4c64", "#64748b"];
  const numeric = result.rows.flatMap(row => columns.map(column => row.current[column.key])).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const min = numeric.length ? Math.min(...numeric) : 0;
  const max = numeric.length ? Math.max(...numeric) : 1;
  const span = max - min || 1;
  const pointsFor = (key: string) => result.rows.map((row, index) => {
    const value = row.current[key];
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    const x = result.rows.length === 1 ? 50 : 4 + (index / (result.rows.length - 1)) * 92;
    const y = 56 - ((value - min) / span) * 52;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).filter((point): point is string => Boolean(point)).join(" ");
  return <section className="mt-4" aria-label="Time series results"><div className="rounded-lg border border-slate-200 bg-white p-3"><div className="mb-2 flex flex-wrap gap-x-4 gap-y-1">{columns.map((column, index) => <span key={column.id} className="inline-flex items-center gap-1.5 text-xs text-slate-600"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: colors[index % colors.length] }} />{column.label}</span>)}</div><svg role="img" aria-labelledby="report-chart-title report-chart-desc" viewBox="0 0 100 60" className="h-auto max-h-72 w-full" preserveAspectRatio="none"><title id="report-chart-title">Report time series chart</title><desc id="report-chart-desc">{result.rows.length} ordered groups showing {columns.map(column => column.label).join(", ")}. Exact values follow in the accessible table.</desc><line x1="4" y1="56" x2="96" y2="56" stroke="#cbd5e1" strokeWidth=".5" vectorEffect="non-scaling-stroke" /><line x1="4" y1="4" x2="4" y2="56" stroke="#cbd5e1" strokeWidth=".5" vectorEffect="non-scaling-stroke" />{columns.map((column, index) => <polyline key={column.id} points={pointsFor(column.key)} fill="none" stroke={colors[index % colors.length]} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />)}</svg><div className="mt-1 flex justify-between text-[10px] text-slate-500"><span>{result.rows[0]?.label}</span><span>{result.rows.at(-1)?.label}</span></div></div><ResultTable result={result} caption="Exact time series values" /></section>;
}

function ScheduleReportDialog({ email, setEmail, cadence, setCadence, timezone, setTimezone, version, onClose, onSave, busy }: { email: string; setEmail: (value: string) => void; cadence: "weekly" | "monthly"; setCadence: (value: "weekly" | "monthly") => void; timezone: string; setTimezone: (value: string) => void; version?: number; onClose: () => void; onSave: () => void; busy: boolean }) {
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4" role="dialog" aria-modal="true" aria-label="Schedule saved report"><div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl"><h3 className="text-base font-bold">Schedule saved report</h3><p className="mt-1 text-xs text-slate-500">Delivery is pinned to saved version {version} and the current authorized scope.</p><div className="mt-4 space-y-3"><label className="block text-xs font-bold">Recipient email<input type="email" className="filter mt-1 w-full" value={email} onChange={event => setEmail(event.target.value)} /></label><label className="block text-xs font-bold">Cadence<select className="filter mt-1 w-full" value={cadence} onChange={event => setCadence(event.target.value as "weekly" | "monthly")}><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></label><label className="block text-xs font-bold">Timezone<input className="filter mt-1 w-full" value={timezone} onChange={event => setTimezone(event.target.value)} /></label></div><div className="mt-5 flex justify-end gap-2"><button className="action secondary" onClick={onClose}>Cancel</button><button className="action primary" disabled={busy} onClick={onSave}>{busy ? "Saving…" : "Schedule"}</button></div></div></div>;
}