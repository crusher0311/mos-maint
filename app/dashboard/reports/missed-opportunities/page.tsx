"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  formatTicketJobAmount,
  sumTicketJobAmounts,
  type MissedOpportunityTicketJob,
  type TicketJobDisplayGroup,
} from "@/lib/missed-opportunity-ticket-details";

type MissedItem = {
  title: string;
  serviceKey: string | null;
  status: "overdue" | "due_soon";
  dueAtMiles: number | null;
  dueAtDate: string | null;
};
type RecommendationSource = "vhi" | "dvi" | "both";
type RecommendationOutcome = "invoiced_performed" | "deferred_declined" | "not_quoted";
type Recommendation = MissedItem & {
  source: RecommendationSource;
  dviSeverity: "red" | "yellow" | null;
  dviSource: string | null;
  outcome: RecommendationOutcome;
  recordedPrice: string | null;
};
type Rollup = { count: number; recordedDollarSubtotal: string; unavailableCount: number };
type ReportRow = {
  workOrderId: string; workOrderNumber: string; closedDate: string | null; vin: string | null;
  vehicle: string | null; advisorName: string | null; missedItems: MissedItem[];
  recommendations: Recommendation[]; ticketJobs: MissedOpportunityTicketJob[] | null;
};
type NotEvaluatedRow = {
  workOrderId: string; workOrderNumber: string; closedDate: string | null; vin: string | null;
  vehicle: string | null; skipReason: string | null;
};
type Report = {
  windowDays: number; generatedAt: string; truncated: boolean; rows: ReportRow[]; notEvaluated: NotEvaluatedRow[];
  summary: {
    totalClosedRos: number; evaluatedRos: number; notEvaluatedRos: number; rosWithMissedItems: number;
    missedPct: number; totalMissedItems: number; totalRecommendations: number;
    topMissedServices: Array<{ title: string; serviceKey: string | null; count: number }>;
    recommendationsBySource: Record<RecommendationSource, Rollup>;
    recommendationsByOutcome: Record<RecommendationOutcome, Rollup>;
  };
};

const WINDOWS = [7, 30, 90] as const;
const SOURCES: Array<{ key: RecommendationSource; label: string; tone: string }> = [
  { key: "vhi", label: "VHI", tone: "border-sky-200 bg-sky-50 text-sky-800" },
  { key: "dvi", label: "DVI", tone: "border-amber-200 bg-amber-50 text-amber-900" },
  { key: "both", label: "Both", tone: "border-indigo-200 bg-indigo-50 text-indigo-800" },
];
const OUTCOMES: Array<{ key: RecommendationOutcome; label: string; tone: string }> = [
  { key: "invoiced_performed", label: "Invoiced / performed", tone: "border-emerald-200 bg-emerald-50 text-emerald-800" },
  { key: "deferred_declined", label: "Deferred / declined", tone: "border-amber-200 bg-amber-50 text-amber-900" },
  { key: "not_quoted", label: "Not quoted", tone: "border-rose-200 bg-rose-50 text-rose-800" },
];
type SortKey = "closedDate" | "workOrderNumber" | "missedCount" | "advisorName";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}
function price(value: string | null | undefined) {
  return formatTicketJobAmount(value) ?? "Price unavailable";
}
function shortSkipReason(reason: string): string {
  if (reason.startsWith("No VIN")) return "without a VIN";
  if (reason.startsWith("No cached VHI plan")) return "without a cached VHI plan";
  if (reason.startsWith("No service jobs")) return "without service jobs";
  return reason.toLowerCase();
}

export default function MissedOpportunitiesPage() {
  const [days, setDays] = useState<number>(30);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [upgradeRequired, setUpgradeRequired] = useState(false);
  const [stale, setStale] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>("closedDate");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [showSkipped, setShowSkipped] = useState(false);
  const [outcomeFilter, setOutcomeFilter] = useState<RecommendationOutcome | "all">("all");

  const load = useCallback(async (windowDays: number, refresh: boolean) => {
    refresh ? setRefreshing(true) : setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/reports/missed-opportunities?days=${windowDays}${refresh ? "&refresh=1" : ""}`);
      const data = await response.json();
      if (response.status === 402) { setUpgradeRequired(true); setReport(null); return; }
      if (!response.ok || !data.ok) { setError(data.error || "Failed to load the report."); return; }
      setUpgradeRequired(false); setStale(Boolean(data.stale)); setReport(data.report); setExpanded(new Set());
    } catch { setError("Failed to load the report."); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { load(days, false); }, [days, load]);

  const skipCounts = useMemo(() => {
    const counts = new Map<string, number>();
    report?.notEvaluated.forEach((row) => {
      const reason = row.skipReason || "Unknown reason";
      counts.set(reason, (counts.get(reason) || 0) + 1);
    });
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [report]);
  const sortedRows = useMemo(() => {
    if (!report) return [];
    const dir = sortDir === "asc" ? 1 : -1;
    return [...report.rows].sort((a, b) => {
      if (sortKey === "workOrderNumber") return dir * a.workOrderNumber.localeCompare(b.workOrderNumber, undefined, { numeric: true });
      if (sortKey === "missedCount") return dir * ((a.recommendations?.length || a.missedItems.length) - (b.recommendations?.length || b.missedItems.length));
      if (sortKey === "advisorName") return dir * (a.advisorName || "").localeCompare(b.advisorName || "");
      return dir * (a.closedDate || "").localeCompare(b.closedDate || "");
    });
  }, [report, sortDir, sortKey]);
  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((current) => current === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir(key === "closedDate" || key === "missedCount" ? "desc" : "asc"); }
  };
  const arrow = (key: SortKey) => sortKey === key ? (sortDir === "asc" ? " ↑" : " ↓") : "";
  const toggleRow = (id: string) => setExpanded((previous) => {
    const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next;
  });

  if (upgradeRequired) return (
    <div className="max-w-3xl p-6">
      <h1 className="text-2xl font-semibold tracking-tight text-slate-950">Missed Opportunities</h1>
      <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">This report is part of Estimate Assist and is not included in your current plan. Contact support to upgrade.</div>
    </div>
  );

  return (
    <div className="min-h-[100dvh] space-y-5 bg-slate-50/50 p-4 sm:p-6">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-200 pb-5">
        <div>
          <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-700"><span className="h-2 w-2 rounded-sm bg-amber-500" />Operations intelligence</div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-950">Missed Opportunities</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">Audit every due recommendation on recently closed repair orders, from inspection source through recorded ticket outcome.</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex overflow-hidden rounded-md border border-slate-300 bg-white shadow-sm">
            {WINDOWS.map((window) => <button key={window} onClick={() => setDays(window)} className={`px-3 py-1.5 text-sm font-medium transition-colors ${days === window ? "bg-slate-800 text-white" : "text-slate-600 hover:bg-slate-100"}`}>{window}d</button>)}
          </div>
          <button onClick={() => load(days, true)} disabled={refreshing || loading} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm transition-colors hover:border-slate-400 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50">{refreshing ? "Refreshing…" : "Refresh"}</button>
        </div>
      </header>

      {error && <div className="flex items-center justify-between rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900"><span>{error}</span><button onClick={() => load(days, false)} className="font-semibold underline underline-offset-2">Retry</button></div>}
      {loading ? <ReportSkeleton /> : report ? <ReportBody report={report} stale={stale} skipCounts={skipCounts} outcomeFilter={outcomeFilter} setOutcomeFilter={setOutcomeFilter} rows={sortedRows} expanded={expanded} toggleRow={toggleRow} arrow={arrow} toggleSort={toggleSort} showSkipped={showSkipped} setShowSkipped={setShowSkipped} /> : null}
    </div>
  );
}

function ReportBody({ report, stale, skipCounts, outcomeFilter, setOutcomeFilter, rows, expanded, toggleRow, arrow, toggleSort, showSkipped, setShowSkipped }: {
  report: Report; stale: boolean; skipCounts: Array<[string, number]>; outcomeFilter: RecommendationOutcome | "all"; setOutcomeFilter: (value: RecommendationOutcome | "all") => void;
  rows: ReportRow[]; expanded: Set<string>; toggleRow: (id: string) => void; arrow: (key: SortKey) => string; toggleSort: (key: SortKey) => void; showSkipped: boolean; setShowSkipped: (value: boolean | ((current: boolean) => boolean)) => void;
}) {
  const summary = report.summary;
  const visibleRows = outcomeFilter === "all"
    ? rows
    : rows.filter((row) => row.recommendations.some((item) => item.outcome === outcomeFilter));
  return <div className="space-y-5">
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
      <span>Updated {fmtDate(report.generatedAt)} {new Date(report.generatedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</span>
      {stale && <span className="font-medium text-amber-700">Previous results shown; refresh failed.</span>}
      {report.truncated && <span>Window limited to newest closed ROs.</span>}
    </div>
    {summary.totalClosedRos > 0 && summary.evaluatedRos === 0 && <div className="rounded-lg border border-sky-200 bg-sky-50 p-4 text-sm text-sky-950"><strong>No ROs could be evaluated in this window.</strong><div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">{skipCounts.map(([reason, count]) => <span key={reason}><b>{count.toLocaleString()}</b> {reason}</span>)}</div><p className="mt-2 text-sky-800">This report reads cached vehicle plans only. Coverage fills as plans are warmed in the background; refresh later to check again.</p></div>}
    <section className="grid gap-3 md:grid-cols-4">
      <StatCard label="Closed ROs reviewed" value={summary.evaluatedRos.toLocaleString()} sub={`${summary.notEvaluatedRos.toLocaleString()} not evaluated`} />
      <StatCard label="ROs with opportunities" value={summary.rosWithMissedItems.toLocaleString()} sub={`${summary.missedPct}% of reviewed`} />
      <StatCard label="Recommendations audited" value={(summary.totalRecommendations ?? 0).toLocaleString()} sub={`${summary.totalMissedItems.toLocaleString()} deferred or not quoted`} />
      <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"><div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">Top opportunities</div>{summary.topMissedServices.length ? <ul className="space-y-1 text-sm">{summary.topMissedServices.slice(0, 4).map((service) => <li className="flex justify-between gap-2" key={service.serviceKey || service.title}><span className="truncate text-slate-700">{service.title}</span><b className="tabular-nums text-slate-900">{service.count}</b></li>)}</ul> : <span className="text-sm text-slate-500">No missed services recorded.</span>}</div>
    </section>
    <section className="grid gap-3 xl:grid-cols-2">
      <RollupPanel title="Recommendation source" items={SOURCES} rollups={summary.recommendationsBySource} />
      <RollupPanel title="Ticket outcome" items={OUTCOMES} rollups={summary.recommendationsByOutcome} active={outcomeFilter} onSelect={(key) => setOutcomeFilter(outcomeFilter === key ? "all" : key)} />
    </section>
    <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3"><div><h2 className="text-sm font-semibold text-slate-900">Closed repair orders</h2><p className="text-xs text-slate-500">{outcomeFilter === "all" ? "Expand an RO to inspect recommendations and ticket context." : `Showing ${OUTCOMES.find((item) => item.key === outcomeFilter)?.label.toLowerCase()} recommendations.`}</p></div>{outcomeFilter !== "all" && <button onClick={() => setOutcomeFilter("all")} className="text-xs font-semibold text-slate-700 underline underline-offset-2">Clear outcome filter</button>}</div>
      <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-sm"><thead className="border-b border-slate-200 bg-slate-50 text-left text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-500"><tr><SortHead label={`RO #${arrow("workOrderNumber")}`} onClick={() => toggleSort("workOrderNumber")} /><SortHead label={`Closed${arrow("closedDate")}`} onClick={() => toggleSort("closedDate")} /><th className="px-4 py-2.5">Vehicle</th><SortHead label={`Advisor${arrow("advisorName")}`} onClick={() => toggleSort("advisorName")} /><SortHead label={`Recommendations${arrow("missedCount")}`} align="right" onClick={() => toggleSort("missedCount")} /></tr></thead>
      <tbody className="divide-y divide-slate-100">{visibleRows.length === 0 ? <tr><td colSpan={5} className="px-4 py-12 text-center text-slate-500">No closed repair orders with recommendations in this window.</td></tr> : visibleRows.map((row) => <RowWithDetail key={row.workOrderId} row={row} open={expanded.has(row.workOrderId)} onToggle={() => toggleRow(row.workOrderId)} outcomeFilter={outcomeFilter} />)}</tbody></table></div>
    </section>
    {report.notEvaluated.length > 0 && <section><button onClick={() => setShowSkipped((open) => !open)} className="text-sm font-medium text-slate-600 transition-colors hover:text-slate-950">{showSkipped ? "Hide" : "Show"} {report.notEvaluated.length} closed RO{report.notEvaluated.length === 1 ? "" : "s"} not evaluated {skipCounts.length > 0 && <span className="font-normal text-slate-400">({skipCounts.map(([reason, count]) => `${count} ${shortSkipReason(reason)}`).join(", ")})</span>}</button>{showSkipped && <div className="mt-2 overflow-x-auto rounded-lg border border-slate-200 bg-white"><table className="w-full min-w-[650px] text-sm"><tbody className="divide-y divide-slate-100">{report.notEvaluated.map((row) => <tr key={row.workOrderId} className="text-slate-600"><td className="px-4 py-2.5 font-medium text-slate-800">RO {row.workOrderNumber}</td><td className="px-4 py-2.5">{fmtDate(row.closedDate)}</td><td className="px-4 py-2.5">{row.vehicle || row.vin || "—"}</td><td className="px-4 py-2.5 text-slate-500">{row.skipReason || "Unknown reason"}</td></tr>)}</tbody></table></div>}</section>}
  </div>;
}

function SortHead({ label, onClick, align }: { label: string; onClick: () => void; align?: "right" }) { return <th className={`cursor-pointer select-none px-4 py-2.5 transition-colors hover:text-slate-950 ${align === "right" ? "text-right" : ""}`} onClick={onClick}>{label}</th>; }
function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) { return <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"><div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">{label}</div><div className="mt-1 text-2xl font-semibold tracking-tight tabular-nums text-slate-950">{value}</div>{sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}</div>; }
function RollupPanel({ title, items, rollups, active, onSelect }: { title: string; items: Array<{ key: string; label: string; tone: string }>; rollups: Record<string, Rollup>; active?: string; onSelect?: (key: any) => void }) { return <div className="rounded-lg border border-slate-200 bg-white shadow-sm"><div className="border-b border-slate-100 px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">{title}</div><div className="grid divide-x divide-slate-100 sm:grid-cols-3">{items.map((item) => { const rollup = rollups?.[item.key] || { count: 0, recordedDollarSubtotal: "0.00", unavailableCount: 0 }; return <button key={item.key} onClick={() => onSelect?.(item.key)} disabled={!onSelect} className={`p-3 text-left transition-colors ${onSelect ? "hover:bg-slate-50" : ""} ${active === item.key ? "bg-slate-50 ring-1 ring-inset ring-slate-400" : ""}`}><span className={`inline-flex rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${item.tone}`}>{item.label}</span><div className="mt-2 flex items-baseline justify-between gap-2"><b className="text-lg tabular-nums text-slate-950">{rollup.count}</b><span className="text-xs font-semibold tabular-nums text-slate-800">{price(rollup.recordedDollarSubtotal)}</span></div><div className="mt-1 text-[11px] text-slate-500">{rollup.unavailableCount > 0 ? `${rollup.unavailableCount} price${rollup.unavailableCount === 1 ? "" : "s"} unavailable` : "All prices recorded"}</div></button>; })}</div></div>; }

function RowWithDetail({ row, open, onToggle, outcomeFilter }: { row: ReportRow; open: boolean; onToggle: () => void; outcomeFilter: RecommendationOutcome | "all" }) {
  const recommendations = (row.recommendations || []).filter((item) => outcomeFilter === "all" || item.outcome === outcomeFilter);
  const count = row.recommendations?.length || row.missedItems.length;
  return <><tr onClick={onToggle} className={`cursor-pointer transition-colors hover:bg-amber-50/40 ${open ? "bg-slate-50" : ""}`}><td className="px-4 py-3 font-semibold text-slate-900">{row.workOrderNumber}</td><td className="px-4 py-3 text-slate-700">{fmtDate(row.closedDate)}</td><td className="max-w-[280px] truncate px-4 py-3 text-slate-700">{row.vehicle || row.vin || "—"}</td><td className="px-4 py-3 text-slate-700">{row.advisorName || "—"}</td><td className="px-4 py-3 text-right"><span className="inline-flex min-w-7 justify-center rounded-full bg-slate-800 px-2 py-0.5 text-xs font-bold tabular-nums text-white">{count}</span></td></tr>{open && <tr className="bg-slate-50/70"><td colSpan={5} className="p-4 sm:p-5"><div className="grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(260px,.55fr)]"><RecommendationDetail recommendations={recommendations} hasCurrentShape={row.recommendations?.length > 0} legacyItems={row.missedItems} /><TicketContext jobs={row.ticketJobs} /></div></td></tr>}</>;
}
function RecommendationDetail({ recommendations, hasCurrentShape, legacyItems }: { recommendations: Recommendation[]; hasCurrentShape: boolean; legacyItems: MissedItem[] }) {
  if (!hasCurrentShape) return <section className="rounded-lg border border-amber-200 bg-amber-50/60 p-4"><h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-amber-900">Recommendation detail</h3><p className="mt-2 text-sm text-amber-900">Source, outcome, and recorded price are unavailable for this saved report. Refresh to load the current audit detail.</p><ul className="mt-3 space-y-1 text-sm text-slate-700">{legacyItems.map((item, index) => <li key={`${item.title}-${index}`}>{item.title}</li>)}</ul></section>;
  return <section className="overflow-hidden rounded-lg border border-slate-200 bg-white"><div className="flex items-center justify-between border-b border-slate-100 px-4 py-3"><h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-600">Recommendations on this RO</h3><span className="text-xs tabular-nums text-slate-500">{recommendations.length} shown</span></div>{recommendations.length === 0 ? <div className="p-5 text-sm text-slate-500">No recommendations match the selected outcome.</div> : <ul className="divide-y divide-slate-100">{recommendations.map((item, index) => <li key={`${item.serviceKey || item.title}-${index}`} className="grid gap-3 p-3 sm:grid-cols-[minmax(0,1fr)_auto]"><div className="min-w-0"><div className="flex flex-wrap items-center gap-1.5"><span className="font-medium text-slate-900">{item.title}</span><Badge label={item.source === "both" ? "Both" : item.source.toUpperCase()} tone={SOURCES.find((source) => source.key === item.source)?.tone || ""} /><Badge label={OUTCOMES.find((outcome) => outcome.key === item.outcome)?.label || item.outcome} tone={OUTCOMES.find((outcome) => outcome.key === item.outcome)?.tone || ""} />{item.dviSeverity && <Badge label={`DVI ${item.dviSeverity}`} tone={item.dviSeverity === "red" ? "border-rose-200 bg-rose-50 text-rose-800" : "border-amber-200 bg-amber-50 text-amber-900"} />}</div><div className="mt-1 text-xs text-slate-500">{item.dviSource && <span>{item.dviSource} · </span>}{item.dueAtMiles && item.dueAtMiles > 0 ? `Due at ${Math.round(item.dueAtMiles).toLocaleString()} mi` : item.dueAtDate ? `Due by ${fmtDate(item.dueAtDate)}` : item.status === "overdue" ? "Overdue" : "Due soon"}</div></div><div className={`text-right text-sm font-semibold tabular-nums ${item.recordedPrice == null ? "font-normal text-slate-400" : "text-slate-900"}`}>{price(item.recordedPrice)}</div></li>)}</ul>}</section>;
}
function Badge({ label, tone }: { label: string; tone: string }) { return <span className={`inline-flex rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${tone}`}>{label}</span>; }
function TicketContext({ jobs }: { jobs: MissedOpportunityTicketJob[] | null }) { if (jobs === null) return <section className="rounded-lg border border-slate-200 bg-white p-4"><h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-600">Ticket context</h3><p className="mt-2 text-sm text-slate-500">Ticket details are unavailable for this saved report. Refresh to load them.</p></section>; if (!jobs.length) return <section className="rounded-lg border border-slate-200 bg-white p-4"><h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-600">Ticket context</h3><p className="mt-2 text-sm text-slate-500">No ticket jobs recorded.</p></section>; return <section className="rounded-lg border border-slate-200 bg-white p-4"><h3 className="mb-3 text-xs font-semibold uppercase tracking-[0.12em] text-slate-600">Other ticket work</h3><div className="space-y-3">{TICKET_GROUPS.map((group) => { const groupJobs = jobs.filter((job) => job.displayGroup === group.key); return groupJobs.length ? <TicketJobGroup key={group.key} label={group.label} jobs={groupJobs} /> : null; })}</div></section>; }
const TICKET_GROUPS: Array<{ key: TicketJobDisplayGroup; label: string }> = [{ key: "approved_performed", label: "Approved / performed" }, { key: "deferred_declined", label: "Deferred / declined" }, { key: "other", label: "Other ticket work" }];
function TicketJobGroup({ label, jobs }: { label: string; jobs: MissedOpportunityTicketJob[] }) { const subtotal = sumTicketJobAmounts(jobs); const available = jobs.some((job) => formatTicketJobAmount(job.totalPrice) !== null); return <div><div className="mb-1 flex items-center justify-between gap-2"><h4 className="text-xs font-semibold text-slate-700">{label}</h4><span className="text-xs font-semibold tabular-nums text-slate-900">{available ? price(subtotal.total) : "Price unavailable"}</span></div><ul className="space-y-1">{jobs.map((job, index) => <li key={`${job.title}-${index}`} className="flex justify-between gap-3 text-xs"><span className="min-w-0 truncate text-slate-600">{job.title}</span><span className="shrink-0 tabular-nums text-slate-500">{price(job.totalPrice)}</span></li>)}</ul>{subtotal.hasUnavailable && available && <p className="mt-1 text-[11px] text-slate-400">Subtotal excludes unavailable prices.</p>}</div>; }
function ReportSkeleton() { return <div className="space-y-5 animate-pulse"><div className="h-4 w-56 rounded bg-slate-200" /><div className="grid gap-3 md:grid-cols-4">{[1, 2, 3, 4].map((item) => <div key={item} className="h-28 rounded-lg border border-slate-200 bg-slate-100" />)}</div><div className="h-80 rounded-lg border border-slate-200 bg-slate-100" /></div>; }