"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Clock,
  Database,
  RefreshCw,
  Search,
  Timer,
  TrendingUp,
} from "lucide-react";

interface SlowQueryEntry {
  id: number;
  ts: string;
  db: "mongo" | "pg";
  operation: string;
  target: string | null;
  shape: string;
  shapeHash: string;
  durationMs: number;
  rowsReturned: number | null;
  docsExamined: number | null;
  source: string | null;
  caller: string | null;
}

interface ShapeSummary {
  shapeHash: string;
  db: string;
  target: string | null;
  operation: string;
  shape: string;
  count: number;
  totalMs: number;
  avgMs: number;
  maxMs: number;
  lastSeen: string;
}

interface Config {
  enabled: boolean;
  thresholdMs: number;
}

const TIME_RANGES = [
  { label: "1h", hours: 1 },
  { label: "6h", hours: 6 },
  { label: "24h", hours: 24 },
  { label: "7d", hours: 168 },
  { label: "30d", hours: 720 },
];

const PAGE_SIZE = 50;

function fmtMs(ms: number) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function DbBadge({ db }: { db: string }) {
  return (
    <span
      className={`px-2 py-0.5 rounded text-xs font-medium ${
        db === "mongo"
          ? "bg-green-100 text-green-800"
          : "bg-blue-100 text-blue-800"
      }`}
    >
      {db === "mongo" ? "Mongo" : "Postgres"}
    </span>
  );
}

function DurationBadge({ ms }: { ms: number }) {
  const cls =
    ms >= 10000
      ? "bg-red-100 text-red-800"
      : ms >= 2000
        ? "bg-amber-100 text-amber-800"
        : "bg-gray-100 text-gray-700";
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-semibold tabular-nums ${cls}`}>
      {fmtMs(ms)}
    </span>
  );
}

export default function SlowQueriesPage() {
  const [tab, setTab] = useState<"recent" | "offenders">("recent");
  const [hours, setHours] = useState(24);
  const [dbFilter, setDbFilter] = useState<"" | "mongo" | "pg">("");
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [sort, setSort] = useState<"duration" | "ts">("duration");
  const [page, setPage] = useState(0);
  const [entries, setEntries] = useState<SlowQueryEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [shapes, setShapes] = useState<ShapeSummary[]>([]);
  const [config, setConfig] = useState<Config | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<number | string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ hours: String(hours) });
      if (dbFilter) params.set("db", dbFilter);
      if (tab === "offenders") {
        params.set("view", "summary");
        const res = await fetch(`/api/platform-admin/slow-queries?${params}`);
        const json = await res.json();
        if (!json.error) {
          setShapes(json.shapes || []);
          setConfig(json.config || null);
        }
      } else {
        if (search) params.set("q", search);
        params.set("sort", sort);
        params.set("limit", String(PAGE_SIZE));
        params.set("offset", String(page * PAGE_SIZE));
        const res = await fetch(`/api/platform-admin/slow-queries?${params}`);
        const json = await res.json();
        if (!json.error) {
          setEntries(json.entries || []);
          setTotal(json.total || 0);
          setConfig(json.config || null);
        }
      }
    } catch (err) {
      console.error("Error loading slow queries:", err);
    } finally {
      setLoading(false);
    }
  }, [tab, hours, dbFilter, search, sort, page]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Slow Queries</h1>
          <p className="text-gray-600">
            Database operations slower than{" "}
            {config ? fmtMs(config.thresholdMs) : "…"} across Mongo &amp;
            Postgres
            {config && !config.enabled && (
              <span className="ml-2 px-2 py-0.5 rounded bg-red-100 text-red-800 text-xs font-medium">
                capture disabled (kill switch)
              </span>
            )}
          </p>
        </div>
        <button
          onClick={loadData}
          className="flex items-center gap-2 px-3 py-2 bg-[rgba(60,129,195,0.75)] text-white rounded-lg hover:bg-[#3c81c3] text-sm"
        >
          <RefreshCw className="w-4 h-4" />
          Refresh
        </button>
      </div>

      <div className="flex items-center gap-2 border-b border-gray-200">
        <button
          onClick={() => setTab("recent")}
          className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
            tab === "recent"
              ? "border-blue-600 text-blue-700"
              : "border-transparent text-gray-500 hover:text-gray-800"
          }`}
        >
          <Clock className="w-4 h-4" /> Recent
        </button>
        <button
          onClick={() => setTab("offenders")}
          className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
            tab === "offenders"
              ? "border-blue-600 text-blue-700"
              : "border-transparent text-gray-500 hover:text-gray-800"
          }`}
        >
          <TrendingUp className="w-4 h-4" /> Top Offenders
        </button>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex rounded-lg border border-gray-200 overflow-hidden">
          {TIME_RANGES.map((r) => (
            <button
              key={r.hours}
              onClick={() => {
                setHours(r.hours);
                setPage(0);
              }}
              className={`px-3 py-1.5 text-sm ${
                hours === r.hours
                  ? "bg-blue-600 text-white"
                  : "bg-white text-gray-600 hover:bg-gray-50"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
        <select
          value={dbFilter}
          onChange={(e) => {
            setDbFilter(e.target.value as any);
            setPage(0);
          }}
          className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-white"
        >
          <option value="">All databases</option>
          <option value="mongo">MongoDB</option>
          <option value="pg">Postgres</option>
        </select>
        {tab === "recent" && (
          <>
            <select
              value={sort}
              onChange={(e) => {
                setSort(e.target.value as any);
                setPage(0);
              }}
              className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-white"
            >
              <option value="duration">Slowest first</option>
              <option value="ts">Newest first</option>
            </select>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setSearch(searchInput);
                setPage(0);
              }}
              className="flex items-center gap-2"
            >
              <div className="relative">
                <Search className="w-4 h-4 text-gray-400 absolute left-2.5 top-2" />
                <input
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="Search shape, collection, source, caller…"
                  className="border border-gray-200 rounded-lg pl-8 pr-3 py-1.5 text-sm w-72"
                />
              </div>
              <button
                type="submit"
                className="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200"
              >
                Search
              </button>
            </form>
          </>
        )}
      </div>

      {loading ? (
        <div className="animate-pulse space-y-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-12 bg-gray-100 rounded-lg" />
          ))}
        </div>
      ) : tab === "recent" ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs text-gray-500 uppercase">
              <tr>
                <th className="px-4 py-3">Time</th>
                <th className="px-4 py-3">DB</th>
                <th className="px-4 py-3">Duration</th>
                <th className="px-4 py-3">Collection / Table</th>
                <th className="px-4 py-3">Op</th>
                <th className="px-4 py-3">Rows</th>
                <th className="px-4 py-3">Caller</th>
                <th className="px-4 py-3">Source</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {entries.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-gray-400">
                    <Database className="w-8 h-8 mx-auto mb-2 text-gray-300" />
                    No slow queries captured in this window
                  </td>
                </tr>
              )}
              {entries.map((e) => (
                <>
                  <tr
                    key={e.id}
                    onClick={() => setExpanded(expanded === e.id ? null : e.id)}
                    className="hover:bg-gray-50 cursor-pointer"
                  >
                    <td className="px-4 py-2.5 whitespace-nowrap text-gray-600">
                      {new Date(e.ts).toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5">
                      <DbBadge db={e.db} />
                    </td>
                    <td className="px-4 py-2.5">
                      <DurationBadge ms={e.durationMs} />
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-gray-800">
                      {e.target || "—"}
                    </td>
                    <td className="px-4 py-2.5 text-gray-600">{e.operation}</td>
                    <td className="px-4 py-2.5 text-gray-500 tabular-nums">
                      {e.docsExamined ?? e.rowsReturned ?? "—"}
                    </td>
                    <td className="px-4 py-2.5 text-gray-600 text-xs font-mono max-w-[220px] truncate" title={e.caller || undefined}>
                      {e.caller || "—"}
                    </td>
                    <td className="px-4 py-2.5 text-gray-500 text-xs">
                      {e.source || "—"}
                    </td>
                  </tr>
                  {expanded === e.id && (
                    <tr key={`${e.id}-shape`}>
                      <td colSpan={8} className="px-4 py-3 bg-gray-50">
                        <pre className="text-xs text-gray-700 whitespace-pre-wrap break-all font-mono">
                          {e.shape}
                        </pre>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100 text-sm text-gray-600">
            <span>
              {total.toLocaleString()} slow queries · page {page + 1} of{" "}
              {totalPages}
            </span>
            <div className="flex gap-2">
              <button
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                className="px-3 py-1 rounded border border-gray-200 disabled:opacity-40 hover:bg-gray-50"
              >
                Prev
              </button>
              <button
                disabled={page + 1 >= totalPages}
                onClick={() => setPage((p) => p + 1)}
                className="px-3 py-1 rounded border border-gray-200 disabled:opacity-40 hover:bg-gray-50"
              >
                Next
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs text-gray-500 uppercase">
              <tr>
                <th className="px-4 py-3">DB</th>
                <th className="px-4 py-3">Collection / Table</th>
                <th className="px-4 py-3">Op</th>
                <th className="px-4 py-3">Count</th>
                <th className="px-4 py-3">Total Time</th>
                <th className="px-4 py-3">Avg</th>
                <th className="px-4 py-3">Max</th>
                <th className="px-4 py-3">Last Seen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {shapes.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-gray-400">
                    <Timer className="w-8 h-8 mx-auto mb-2 text-gray-300" />
                    No repeat offenders in this window
                  </td>
                </tr>
              )}
              {shapes.map((s) => (
                <>
                  <tr
                    key={s.shapeHash}
                    onClick={() =>
                      setExpanded(expanded === s.shapeHash ? null : s.shapeHash)
                    }
                    className="hover:bg-gray-50 cursor-pointer"
                  >
                    <td className="px-4 py-2.5">
                      <DbBadge db={s.db} />
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-gray-800">
                      {s.target || "—"}
                    </td>
                    <td className="px-4 py-2.5 text-gray-600">{s.operation}</td>
                    <td className="px-4 py-2.5 tabular-nums font-medium">
                      {s.count.toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5">
                      <DurationBadge ms={s.totalMs} />
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-gray-600">
                      {fmtMs(s.avgMs)}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-gray-600">
                      {fmtMs(s.maxMs)}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-gray-500 text-xs">
                      {new Date(s.lastSeen).toLocaleString()}
                    </td>
                  </tr>
                  {expanded === s.shapeHash && (
                    <tr key={`${s.shapeHash}-shape`}>
                      <td colSpan={8} className="px-4 py-3 bg-gray-50">
                        <pre className="text-xs text-gray-700 whitespace-pre-wrap break-all font-mono">
                          {s.shape}
                        </pre>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
