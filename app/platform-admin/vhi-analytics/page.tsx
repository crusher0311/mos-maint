"use client";

import { useState, useEffect, useMemo, Fragment } from "react";
import {
  Wrench,
  TrendingUp,
  AlertTriangle,
  CheckCircle2,
  Search,
  Loader2,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

type Stats = {
  totalAttempts: number;
  totalAdded: number;
  totalSkipped: number;
  totalFailed: number;
  attemptsWithFailure: number;
  attemptsAllSkipped: number;
  attemptsFullySuccessful: number;
  errorRate: number;
  successRate: number;
  byDay: Array<{ date: string; attempts: number; added: number; failed: number }>;
};

type TopShop = { shopId?: number | string; shopName?: string; count: number; failed: number };
type TopAdvisor = { email: string; count: number; failed: number };

type ItemRow = {
  serviceKey?: string | null;
  title?: string | null;
  status?: string | null;
  outcome?: string | null;
  concernCreated?: boolean;
  jobCreated?: boolean;
  jobId?: string | null;
  error?: string | null;
};

type RecentEvent = {
  id: string | null;
  createdAt: string;
  adminEmail: string;
  shopId?: number | string;
  shopName?: string;
  provider?: string;
  roId?: string | null;
  roNumber?: string | null;
  vin?: string | null;
  summary: { added?: number; skipped?: number; failed?: number };
  items: ItemRow[];
};

export default function VhiAnalyticsPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [topShops, setTopShops] = useState<TopShop[]>([]);
  const [topAdvisors, setTopAdvisors] = useState<TopAdvisor[]>([]);
  const [recentEvents, setRecentEvents] = useState<RecentEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [timeFilter, setTimeFilter] = useState("30");
  const [shopIdFilter, setShopIdFilter] = useState("");
  const [shopIdInput, setShopIdInput] = useState("");
  const [tableFilter, setTableFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "success" | "failure" | "skipped">("all");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    fetchData();
  }, [timeFilter, statusFilter, shopIdFilter]);

  async function fetchData() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (timeFilter === "today" || timeFilter === "yesterday") {
        params.set("dateFilter", timeFilter);
      } else {
        params.set("days", timeFilter);
      }
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (shopIdFilter.trim()) params.set("shopId", shopIdFilter.trim());
      const res = await fetch(`/api/platform-admin/vhi-analytics?${params}`);
      const data = await res.json();
      setStats(data.stats);
      setTopShops(data.topShops || []);
      setTopAdvisors(data.topAdvisors || []);
      setRecentEvents(data.recentEvents || []);
    } catch (error) {
      console.error("Failed to fetch VHI analytics:", error);
    } finally {
      setLoading(false);
    }
  }

  const filteredEvents = useMemo(() => {
    if (!tableFilter) return recentEvents;
    const q = tableFilter.toLowerCase();
    return recentEvents.filter((e) => {
      return (
        (e.shopName || "").toLowerCase().includes(q) ||
        String(e.shopId || "").includes(tableFilter) ||
        (e.adminEmail || "").toLowerCase().includes(q) ||
        (e.roNumber || "").toLowerCase().includes(q) ||
        (e.vin || "").toLowerCase().includes(q)
      );
    });
  }, [recentEvents, tableFilter]);

  const maxDayCount = Math.max(1, ...(stats?.byDay?.map((d) => d.attempts) || [1]));

  const toggleRow = (id: string | null, idx: number) => {
    const key = id || `idx-${idx}`;
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const errorPct = stats ? Math.round((stats.errorRate || 0) * 1000) / 10 : 0;

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Build from VHI Analytics</h1>
          <p className="text-gray-500 mt-1">
            Track adoption and reliability of the Build-from-VHI flow across all shops.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setShopIdFilter(shopIdInput);
            }}
            className="flex items-center gap-1"
          >
            <input
              type="text"
              inputMode="numeric"
              value={shopIdInput}
              onChange={(e) => setShopIdInput(e.target.value)}
              placeholder="Shop ID"
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 w-28"
            />
            <button
              type="submit"
              className="px-3 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700"
            >
              Apply
            </button>
            {shopIdFilter && (
              <button
                type="button"
                onClick={() => {
                  setShopIdInput("");
                  setShopIdFilter("");
                }}
                className="px-2 py-2 text-sm text-gray-600 hover:text-gray-900"
              >
                Clear
              </button>
            )}
          </form>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as any)}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
          >
            <option value="all">All attempts</option>
            <option value="success">Success only (items added, no failures)</option>
            <option value="failure">Failures only</option>
            <option value="skipped">All skipped (no-op)</option>
          </select>
          <select
            value={timeFilter}
            onChange={(e) => setTimeFilter(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
          >
            <option value="today">Today</option>
            <option value="yesterday">Yesterday</option>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
          </select>
        </div>
      </div>
      {shopIdFilter && (
        <div className="mb-4 text-xs text-gray-600 bg-blue-50 border border-blue-200 rounded px-3 py-2 inline-block">
          Filtering all metrics by Shop ID: <span className="font-mono font-semibold">{shopIdFilter}</span>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-blue-100 rounded-lg">
                  <TrendingUp className="w-5 h-5 text-blue-600" />
                </div>
                <div>
                  <p className="text-sm text-gray-500">Total Attempts</p>
                  <p className="text-2xl font-bold text-gray-900">
                    {stats?.totalAttempts?.toLocaleString() || 0}
                  </p>
                </div>
              </div>
            </div>
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-green-100 rounded-lg">
                  <Wrench className="w-5 h-5 text-green-600" />
                </div>
                <div>
                  <p className="text-sm text-gray-500">Items Added</p>
                  <p className="text-2xl font-bold text-gray-900">
                    {stats?.totalAdded?.toLocaleString() || 0}
                  </p>
                </div>
              </div>
            </div>
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-purple-100 rounded-lg">
                  <CheckCircle2 className="w-5 h-5 text-purple-600" />
                </div>
                <div>
                  <p className="text-sm text-gray-500">Success Rate</p>
                  <p className="text-2xl font-bold text-gray-900">
                    {stats?.totalAttempts ? `${Math.round((stats.successRate || 0) * 1000) / 10}%` : "—"}
                  </p>
                </div>
              </div>
            </div>
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <div className="flex items-center gap-3">
                <div className={`p-2 rounded-lg ${errorPct > 10 ? "bg-red-100" : "bg-orange-100"}`}>
                  <AlertTriangle className={`w-5 h-5 ${errorPct > 10 ? "text-red-600" : "text-orange-600"}`} />
                </div>
                <div>
                  <p className="text-sm text-gray-500">Error Rate</p>
                  <p className="text-2xl font-bold text-gray-900">
                    {stats?.totalAttempts ? `${errorPct}%` : "—"}
                  </p>
                  <p className="text-[11px] text-gray-400">
                    {stats?.attemptsWithFailure || 0} attempts with failures
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">Outcome Breakdown</h2>
              <div className="space-y-3">
                {[
                  { label: "Fully successful", value: stats?.attemptsFullySuccessful || 0, color: "bg-green-500" },
                  { label: "Attempts with failures", value: stats?.attemptsWithFailure || 0, color: "bg-red-500" },
                  { label: "All items skipped (no-op)", value: stats?.attemptsAllSkipped || 0, color: "bg-gray-400" },
                ].map((row) => {
                  const total = stats?.totalAttempts || 1;
                  const pct = Math.round((row.value / total) * 100);
                  return (
                    <div key={row.label}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm text-gray-700">{row.label}</span>
                        <span className="text-sm font-medium text-gray-900">
                          {row.value.toLocaleString()} ({pct}%)
                        </span>
                      </div>
                      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                        <div className={`h-full ${row.color} rounded-full`} style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
                <div className="pt-3 mt-3 border-t border-gray-100 grid grid-cols-3 gap-2 text-center">
                  <div>
                    <div className="text-xs text-gray-500">Items added</div>
                    <div className="text-lg font-semibold text-green-600">{stats?.totalAdded || 0}</div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500">Items skipped</div>
                    <div className="text-lg font-semibold text-gray-600">{stats?.totalSkipped || 0}</div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500">Items failed</div>
                    <div className="text-lg font-semibold text-red-600">{stats?.totalFailed || 0}</div>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">Daily Attempts</h2>
              {(stats?.byDay?.length || 0) === 0 ? (
                <div className="h-40 flex items-center justify-center">
                  <p className="text-sm text-gray-400">No daily data yet</p>
                </div>
              ) : (
                <div className="flex items-end gap-1 h-40">
                  {(stats?.byDay || [])
                    .slice(0, 14)
                    .reverse()
                    .map((day) => {
                      const barHeight =
                        maxDayCount > 0
                          ? Math.max((day.attempts / maxDayCount) * 100, day.attempts > 0 ? 5 : 0)
                          : 0;
                      const failHeight =
                        maxDayCount > 0 && day.failed > 0
                          ? Math.max((day.failed / maxDayCount) * 100, 5)
                          : 0;
                      return (
                        <div key={day.date} className="flex-1 flex flex-col items-center justify-end h-full relative">
                          <div
                            className="w-full bg-blue-500 rounded-t transition-all"
                            style={{ height: `${barHeight}%` }}
                            title={`${day.date}: ${day.attempts} attempts, ${day.added} added, ${day.failed} failed`}
                          />
                          {failHeight > 0 && (
                            <div
                              className="w-full bg-red-500 absolute bottom-6"
                              style={{ height: `${failHeight}%` }}
                              title={`${day.failed} failed items`}
                            />
                          )}
                          <span className="text-[9px] text-gray-400 mt-2 whitespace-nowrap">
                            {day.date.slice(5)}
                          </span>
                        </div>
                      );
                    })}
                </div>
              )}
              <div className="flex items-center gap-4 mt-3 text-xs text-gray-500">
                <div className="flex items-center gap-1">
                  <span className="w-3 h-3 bg-blue-500 rounded-sm" /> Attempts
                </div>
                <div className="flex items-center gap-1">
                  <span className="w-3 h-3 bg-red-500 rounded-sm" /> Failed items
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">Top Shops</h2>
              <div className="space-y-2 max-h-72 overflow-y-auto">
                {topShops.map((s, idx) => {
                  const errPct = s.count > 0 ? Math.round((s.failed / s.count) * 100) : 0;
                  return (
                    <div
                      key={`${s.shopId}-${idx}`}
                      className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="w-6 h-6 rounded-full bg-gray-100 text-gray-600 text-xs font-medium flex items-center justify-center flex-shrink-0">
                          {idx + 1}
                        </span>
                        <div className="min-w-0">
                          <div className="text-sm text-gray-800 truncate" title={s.shopName || ""}>
                            {s.shopName || `Shop ${s.shopId}`}
                          </div>
                          <div className="text-[11px] text-gray-400">#{String(s.shopId ?? "—")}</div>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-medium text-gray-700">{s.count} attempts</div>
                        {s.failed > 0 && (
                          <div className="text-[11px] text-red-600">
                            {s.failed} with failures ({errPct}%)
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
                {topShops.length === 0 && (
                  <p className="text-sm text-gray-400 text-center py-4">No data yet</p>
                )}
              </div>
            </div>

            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">Top Advisors</h2>
              <div className="space-y-2 max-h-72 overflow-y-auto">
                {topAdvisors.map((u, idx) => {
                  const errPct = u.count > 0 ? Math.round((u.failed / u.count) * 100) : 0;
                  return (
                    <div
                      key={u.email}
                      className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="w-6 h-6 rounded-full bg-purple-100 text-purple-600 text-xs font-medium flex items-center justify-center flex-shrink-0">
                          {idx + 1}
                        </span>
                        <span
                          className="text-sm text-gray-800 truncate max-w-[280px]"
                          title={u.email}
                        >
                          {u.email}
                        </span>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-medium text-gray-700">{u.count}</div>
                        {u.failed > 0 && (
                          <div className="text-[11px] text-red-600">
                            {u.failed} failed ({errPct}%)
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
                {topAdvisors.length === 0 && (
                  <p className="text-sm text-gray-400 text-center py-4">No data yet</p>
                )}
              </div>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 p-5 mb-6">
            <div className="flex items-center justify-between mb-4 gap-3">
              <h2 className="text-lg font-semibold text-gray-900">Recent Attempts</h2>
              <div className="relative">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  type="text"
                  placeholder="Filter by shop, advisor, RO, or VIN..."
                  value={tableFilter}
                  onChange={(e) => setTableFilter(e.target.value)}
                  className="pl-9 pr-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 w-72"
                />
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200">
                    <th className="w-6 py-2 px-2"></th>
                    <th className="text-left py-2 px-3 font-medium text-gray-600">When</th>
                    <th className="text-left py-2 px-3 font-medium text-gray-600">Shop</th>
                    <th className="text-left py-2 px-3 font-medium text-gray-600">Advisor</th>
                    <th className="text-left py-2 px-3 font-medium text-gray-600">RO</th>
                    <th className="text-left py-2 px-3 font-medium text-gray-600">VIN</th>
                    <th className="text-right py-2 px-3 font-medium text-gray-600">Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEvents.slice(0, 100).map((event, idx) => {
                    const key = event.id || `idx-${idx}`;
                    const isOpen = !!expanded[key];
                    const failed = Number(event.summary?.failed || 0);
                    const added = Number(event.summary?.added || 0);
                    const skipped = Number(event.summary?.skipped || 0);
                    const badgeClass =
                      failed > 0
                        ? "bg-red-100 text-red-700"
                        : added > 0
                          ? "bg-green-100 text-green-700"
                          : "bg-gray-100 text-gray-700";
                    const badgeLabel =
                      failed > 0
                        ? `${added} added · ${failed} failed`
                        : added > 0
                          ? `${added} added${skipped > 0 ? ` · ${skipped} skipped` : ""}`
                          : `${skipped} skipped`;
                    return (
                      <Fragment key={key}>
                        <tr
                          className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer"
                          onClick={() => toggleRow(event.id, idx)}
                        >
                          <td className="py-2 px-2 text-gray-400">
                            {isOpen ? (
                              <ChevronDown className="w-4 h-4" />
                            ) : (
                              <ChevronRight className="w-4 h-4" />
                            )}
                          </td>
                          <td className="py-2 px-3 text-gray-700 whitespace-nowrap">
                            {new Date(event.createdAt).toLocaleDateString()}{" "}
                            {new Date(event.createdAt).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </td>
                          <td className="py-2 px-3">
                            <div className="text-gray-800">
                              {event.shopName || `Shop ${event.shopId ?? "?"}`}
                            </div>
                            <div className="text-gray-400 text-xs">#{String(event.shopId ?? "—")}</div>
                          </td>
                          <td className="py-2 px-3 max-w-[200px]">
                            <span className="text-blue-600 truncate block" title={event.adminEmail}>
                              {event.adminEmail}
                            </span>
                          </td>
                          <td className="py-2 px-3 text-gray-700 whitespace-nowrap">
                            {event.roNumber || event.roId || "—"}
                          </td>
                          <td className="py-2 px-3 text-gray-500 font-mono text-xs">
                            {event.vin || "—"}
                          </td>
                          <td className="py-2 px-3 text-right">
                            <span className={`px-2 py-0.5 text-xs font-medium rounded ${badgeClass}`}>
                              {badgeLabel}
                            </span>
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="bg-gray-50">
                            <td></td>
                            <td colSpan={6} className="py-3 px-3">
                              {event.items.length === 0 ? (
                                <p className="text-xs text-gray-500">
                                  No per-item details recorded for this attempt.
                                </p>
                              ) : (
                                <div className="overflow-x-auto">
                                  <table className="w-full text-xs">
                                    <thead>
                                      <tr className="text-gray-500">
                                        <th className="text-left py-1 pr-3">Title</th>
                                        <th className="text-left py-1 pr-3">Service Key</th>
                                        <th className="text-left py-1 pr-3">Outcome</th>
                                        <th className="text-left py-1 pr-3">Status</th>
                                        <th className="text-left py-1 pr-3">Job</th>
                                        <th className="text-left py-1">Error</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {event.items.map((it, i) => (
                                        <tr key={i} className="border-t border-gray-200">
                                          <td className="py-1 pr-3 text-gray-800">
                                            {it.title || "—"}
                                          </td>
                                          <td className="py-1 pr-3 text-gray-600 font-mono">
                                            {it.serviceKey || "—"}
                                          </td>
                                          <td className="py-1 pr-3">
                                            <span
                                              className={`px-1.5 py-0.5 rounded ${
                                                it.outcome === "added" || it.jobCreated
                                                  ? "bg-green-100 text-green-700"
                                                  : it.outcome === "failed" || it.error
                                                    ? "bg-red-100 text-red-700"
                                                    : "bg-gray-100 text-gray-600"
                                              }`}
                                            >
                                              {it.outcome || (it.jobCreated ? "added" : it.error ? "failed" : "skipped")}
                                            </span>
                                          </td>
                                          <td className="py-1 pr-3 text-gray-600">{it.status || "—"}</td>
                                          <td className="py-1 pr-3 text-gray-600">
                                            {it.jobId || (it.jobCreated ? "✓" : "—")}
                                          </td>
                                          <td className="py-1 text-red-600">{it.error || "—"}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
              {filteredEvents.length === 0 && (
                <p className="text-sm text-gray-400 text-center py-8">No attempts found</p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
