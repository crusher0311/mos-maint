"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Task #1146 — shop-level Missed Opportunities report.
 *
 * Reviews recently closed ROs and lists due/overdue VHI items that were
 * never quoted on the ticket. Declined items count as quoted; inspection-
 * only items are excluded (shared Task #1145 matcher semantics). Served
 * from a per-shop cache; the Refresh button forces a recompute.
 */

type MissedItem = {
  title: string;
  serviceKey: string | null;
  status: "overdue" | "due_soon";
  dueAtMiles: number | null;
  dueAtDate: string | null;
};

type ReportRow = {
  workOrderId: string;
  workOrderNumber: string;
  closedDate: string | null;
  vin: string | null;
  vehicle: string | null;
  advisorName: string | null;
  missedItems: MissedItem[];
};

type NotEvaluatedRow = {
  workOrderId: string;
  workOrderNumber: string;
  closedDate: string | null;
  vin: string | null;
  vehicle: string | null;
  skipReason: string | null;
};

type Report = {
  windowDays: number;
  generatedAt: string;
  truncated: boolean;
  summary: {
    totalClosedRos: number;
    evaluatedRos: number;
    notEvaluatedRos: number;
    rosWithMissedItems: number;
    missedPct: number;
    totalMissedItems: number;
    topMissedServices: Array<{ title: string; serviceKey: string | null; count: number }>;
  };
  rows: ReportRow[];
  notEvaluated: NotEvaluatedRow[];
};

const WINDOWS = [7, 30, 90] as const;

type SortKey = "closedDate" | "workOrderNumber" | "missedCount" | "advisorName";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
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

  const load = useCallback(async (windowDays: number, refresh: boolean) => {
    refresh ? setRefreshing(true) : setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/reports/missed-opportunities?days=${windowDays}${refresh ? "&refresh=1" : ""}`,
      );
      const data = await res.json();
      if (res.status === 402) {
        setUpgradeRequired(true);
        setReport(null);
        return;
      }
      if (!res.ok || !data.ok) {
        setError(data.error || "Failed to load the report.");
        return;
      }
      setUpgradeRequired(false);
      setStale(!!data.stale);
      setReport(data.report);
      setExpanded(new Set());
    } catch {
      setError("Failed to load the report.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load(days, false);
  }, [days, load]);

  // Per-reason skip counts, derived from the notEvaluated rows so cached
  // reports (computed before this UI existed) still break down correctly.
  const skipCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of report?.notEvaluated || []) {
      const reason = r.skipReason || "Unknown reason";
      counts.set(reason, (counts.get(reason) || 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [report]);

  const sortedRows = useMemo(() => {
    if (!report) return [];
    const rows = [...report.rows];
    const dir = sortDir === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      switch (sortKey) {
        case "workOrderNumber":
          return dir * a.workOrderNumber.localeCompare(b.workOrderNumber, undefined, { numeric: true });
        case "missedCount":
          return dir * (a.missedItems.length - b.missedItems.length);
        case "advisorName":
          return dir * (a.advisorName || "").localeCompare(b.advisorName || "");
        case "closedDate":
        default:
          return dir * ((a.closedDate || "").localeCompare(b.closedDate || ""));
      }
    });
    return rows;
  }, [report, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(key === "closedDate" || key === "missedCount" ? "desc" : "asc");
    }
  };

  const toggleRow = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const sortArrow = (key: SortKey) =>
    sortKey === key ? (sortDir === "asc" ? " ↑" : " ↓") : "";

  if (upgradeRequired) {
    return (
      <div className="p-6 max-w-3xl">
        <h1 className="text-2xl font-semibold mb-2">Missed Opportunities</h1>
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-900">
          This report is part of the Estimate Assist feature set, which isn&apos;t
          included in your current plan. Contact support to upgrade.
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Missed Opportunities</h1>
          <p className="text-sm text-gray-500">
            Closed repair orders where due or overdue VHI items were never quoted.
            Declined items count as presented; inspection-only items are excluded.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-md border border-gray-300 overflow-hidden">
            {WINDOWS.map((w) => (
              <button
                key={w}
                onClick={() => setDays(w)}
                className={`px-3 py-1.5 text-sm ${
                  days === w ? "bg-blue-600 text-white" : "bg-white text-gray-700 hover:bg-gray-50"
                }`}
              >
                {w}d
              </button>
            ))}
          </div>
          <button
            onClick={() => load(days, true)}
            disabled={refreshing || loading}
            className="px-3 py-1.5 text-sm rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">{error}</div>
      )}

      {loading ? (
        <div className="text-gray-500 py-12 text-center">Loading report…</div>
      ) : report ? (
        <>
          <div className="text-xs text-gray-400">
            Last updated {fmtDate(report.generatedAt)}{" "}
            {new Date(report.generatedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
            {stale && " (showing previous results — refresh failed)"}
            {report.truncated && " · window truncated to the newest closed ROs"}
          </div>

          {/* Cold plan-cache explainer — nothing could be evaluated */}
          {report.summary.totalClosedRos > 0 && report.summary.evaluatedRos === 0 && (
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900 space-y-2">
              <div className="font-medium">
                Why is this report empty? None of the {report.summary.totalClosedRos.toLocaleString()} closed
                RO{report.summary.totalClosedRos === 1 ? "" : "s"} in this window could be evaluated.
              </div>
              <ul className="list-disc pl-5 space-y-0.5">
                {skipCounts.map(([reason, count]) => (
                  <li key={reason}>
                    <span className="font-medium">{count.toLocaleString()}</span> — {reason}
                  </li>
                ))}
              </ul>
              <p>
                This report compares closed ROs against each vehicle&apos;s cached Vehicle Health
                Inspection (VHI) plan. To keep it free to run, it only reads plans that already
                exist — it never rebuilds them. A vehicle&apos;s plan is built when someone views
                that vehicle in the MOS extension side panel (and refreshed for about 4 hours after).
              </p>
              <p>
                <span className="font-medium">To populate this report:</span> open repair orders in
                your shop management system with the MOS extension side panel active. Each vehicle
                viewed builds its plan, and its closed ROs will be evaluated on the next refresh.
              </p>
            </div>
          )}

          {/* Summary stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard label="Closed ROs reviewed" value={report.summary.evaluatedRos.toLocaleString()} sub={`${report.summary.notEvaluatedRos} not evaluated`} />
            <StatCard label="ROs with missed items" value={report.summary.rosWithMissedItems.toLocaleString()} sub={`${report.summary.missedPct}% of reviewed`} />
            <StatCard label="Missed items total" value={report.summary.totalMissedItems.toLocaleString()} />
            <div className="rounded-lg border border-gray-200 bg-white p-4">
              <div className="text-xs uppercase tracking-wide text-gray-500 mb-1">Top missed services</div>
              {report.summary.topMissedServices.length === 0 ? (
                <div className="text-sm text-gray-400">None 🎉</div>
              ) : (
                <ul className="text-sm space-y-0.5">
                  {report.summary.topMissedServices.slice(0, 5).map((s) => (
                    <li key={s.serviceKey || s.title} className="flex justify-between gap-2">
                      <span className="truncate">{s.title}</span>
                      <span className="text-gray-500 shrink-0">{s.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* RO table */}
          <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-4 py-2 cursor-pointer select-none" onClick={() => toggleSort("workOrderNumber")}>RO #{sortArrow("workOrderNumber")}</th>
                  <th className="px-4 py-2 cursor-pointer select-none" onClick={() => toggleSort("closedDate")}>Closed{sortArrow("closedDate")}</th>
                  <th className="px-4 py-2">Vehicle</th>
                  <th className="px-4 py-2 cursor-pointer select-none" onClick={() => toggleSort("advisorName")}>Advisor{sortArrow("advisorName")}</th>
                  <th className="px-4 py-2 cursor-pointer select-none text-right" onClick={() => toggleSort("missedCount")}>Missed{sortArrow("missedCount")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {sortedRows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-gray-400">
                      No closed ROs with missed VHI items in this window.
                    </td>
                  </tr>
                )}
                {sortedRows.map((row) => (
                  <RowWithDetail
                    key={row.workOrderId}
                    row={row}
                    open={expanded.has(row.workOrderId)}
                    onToggle={() => toggleRow(row.workOrderId)}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {/* Not evaluated */}
          {report.notEvaluated.length > 0 && (
            <div>
              <button
                onClick={() => setShowSkipped((s) => !s)}
                className="text-sm text-gray-600 hover:text-gray-900"
              >
                {showSkipped ? "▾" : "▸"} {report.notEvaluated.length} closed RO
                {report.notEvaluated.length === 1 ? "" : "s"} not evaluated
                {skipCounts.length > 0 &&
                  ` (${skipCounts
                    .map(([reason, count]) => `${count} ${shortSkipReason(reason)}`)
                    .join(", ")})`}
              </button>
              {showSkipped && (
                <div className="mt-2 rounded-lg border border-gray-200 bg-white overflow-hidden">
                  <table className="w-full text-sm">
                    <tbody className="divide-y divide-gray-100">
                      {report.notEvaluated.map((r) => (
                        <tr key={r.workOrderId} className="text-gray-500">
                          <td className="px-4 py-2">RO {r.workOrderNumber}</td>
                          <td className="px-4 py-2">{fmtDate(r.closedDate)}</td>
                          <td className="px-4 py-2">{r.vehicle || r.vin || "—"}</td>
                          <td className="px-4 py-2">{r.skipReason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

/** Compact label for a skip reason in the collapsed skipped-RO toggle. */
function shortSkipReason(reason: string): string {
  if (reason.startsWith("No VIN")) return "without a VIN";
  if (reason.startsWith("No cached VHI plan")) return "without a cached VHI plan";
  if (reason.startsWith("No service jobs")) return "without service jobs";
  return reason.toLowerCase();
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="text-xs uppercase tracking-wide text-gray-500 mb-1">{label}</div>
      <div className="text-2xl font-semibold">{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
    </div>
  );
}

function RowWithDetail({
  row,
  open,
  onToggle,
}: {
  row: ReportRow;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr onClick={onToggle} className="cursor-pointer hover:bg-gray-50">
        <td className="px-4 py-2 font-medium">{row.workOrderNumber}</td>
        <td className="px-4 py-2">{fmtDate(row.closedDate)}</td>
        <td className="px-4 py-2">{row.vehicle || row.vin || "—"}</td>
        <td className="px-4 py-2">{row.advisorName || "—"}</td>
        <td className="px-4 py-2 text-right">
          <span className="inline-flex items-center rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">
            {row.missedItems.length}
          </span>
        </td>
      </tr>
      {open && (
        <tr className="bg-gray-50/60">
          <td colSpan={5} className="px-6 py-3">
            <ul className="space-y-1">
              {row.missedItems.map((item, i) => (
                <li key={i} className="flex items-center gap-2 text-sm">
                  <span
                    className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                      item.status === "overdue"
                        ? "bg-red-100 text-red-700"
                        : "bg-amber-100 text-amber-800"
                    }`}
                  >
                    {item.status === "overdue" ? "Overdue" : "Due soon"}
                  </span>
                  <span>{item.title}</span>
                  <span className="text-gray-400 text-xs">
                    {item.dueAtMiles != null && item.dueAtMiles > 0
                      ? `due at ${Math.round(item.dueAtMiles).toLocaleString()} mi`
                      : item.dueAtDate
                        ? `by ${fmtDate(item.dueAtDate)}`
                        : ""}
                  </span>
                </li>
              ))}
            </ul>
          </td>
        </tr>
      )}
    </>
  );
}
