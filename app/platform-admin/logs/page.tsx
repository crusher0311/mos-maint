"use client";

import { useState, useEffect, useCallback, useRef } from "react";

interface LogEntry {
  dt: string;
  level: string;
  message: any;
  appname: string;
  host: string;
  raw: string;
}

const LEVEL_COLORS: Record<string, string> = {
  error: "bg-red-50 text-red-800 border-red-200",
  err: "bg-red-50 text-red-800 border-red-200",
  warn: "bg-yellow-50 text-yellow-800 border-yellow-200",
  warning: "bg-yellow-50 text-yellow-800 border-yellow-200",
  info: "bg-white text-gray-700 border-gray-100",
  debug: "bg-gray-50 text-gray-500 border-gray-100",
  unknown: "bg-white text-gray-600 border-gray-100",
};

const LEVEL_BADGES: Record<string, string> = {
  error: "bg-red-600 text-white",
  err: "bg-red-600 text-white",
  warn: "bg-yellow-500 text-white",
  warning: "bg-yellow-500 text-white",
  info: "bg-blue-500 text-white",
  debug: "bg-gray-400 text-white",
  unknown: "bg-gray-400 text-white",
};

function formatTimestamp(dt: string): string {
  try {
    const d = new Date(dt.replace(" ", "T") + (dt.includes("Z") || dt.includes("+") ? "" : "Z"));
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return dt;
  }
}

function formatMessage(msg: any): string {
  if (typeof msg === "string") return msg;
  if (typeof msg === "object" && msg !== null) {
    if (msg.text) return msg.text;
    if (msg.path) {
      const parts = [];
      if (msg.method) parts.push(msg.method);
      parts.push(msg.path);
      if (msg.statusCode) parts.push(`\u2192 ${msg.statusCode}`);
      if (msg.responseTimeMS) parts.push(`(${msg.responseTimeMS}ms)`);
      return parts.join(" ");
    }
    return JSON.stringify(msg);
  }
  return String(msg);
}

export default function LogsPage() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [level, setLevel] = useState("");
  const [minutes, setMinutes] = useState(60);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const [error, setError] = useState("");
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (level) params.set("level", level);
      params.set("minutes", String(minutes));
      params.set("limit", "300");

      const res = await fetch(`/api/logs/betterstack?${params}`);
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to fetch logs");
        return;
      }

      setLogs(data.logs || []);
      setTotal(data.total || 0);
    } catch (err: any) {
      setError(err.message || "Connection error");
    } finally {
      setLoading(false);
    }
  }, [search, level, minutes]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  useEffect(() => {
    if (autoRefresh) {
      timerRef.current = setInterval(fetchLogs, 10000);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [autoRefresh, fetchLogs]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setSearch(searchInput);
  };

  const levelCounts = logs.reduce((acc, log) => {
    const l = log.level?.toLowerCase() || "unknown";
    acc[l] = (acc[l] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-gray-900">Production Logs</h1>
          <span className="text-xs text-gray-500 bg-gray-100 px-2 py-1 rounded">30 day retention</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-500">
            {total.toLocaleString()} entries
          </span>
          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
              autoRefresh
                ? "bg-emerald-600 text-white"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            <div className={`w-1.5 h-1.5 rounded-full ${autoRefresh ? "bg-white animate-pulse" : "bg-gray-400"}`} />
            {autoRefresh ? "Live" : "Paused"}
          </button>
          <button
            onClick={fetchLogs}
            disabled={loading}
            className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded text-xs font-medium transition-colors disabled:opacity-50"
          >
            {loading ? "Loading..." : "Refresh"}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <form onSubmit={handleSearch} className="flex-1 min-w-[300px]">
          <div className="relative">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search logs... (press Enter)"
              className="w-full pl-10 pr-4 py-2 bg-white border border-gray-200 rounded-lg text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
        </form>

        <select
          value={level}
          onChange={(e) => setLevel(e.target.value)}
          className="px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">All levels</option>
          <option value="error,err">Error</option>
          <option value="warn,warning">Warning</option>
          <option value="info">Info</option>
          <option value="debug">Debug</option>
        </select>

        <select
          value={minutes}
          onChange={(e) => setMinutes(parseInt(e.target.value))}
          className="px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value={15}>Last 15 min</option>
          <option value={60}>Last 1 hour</option>
          <option value={360}>Last 6 hours</option>
          <option value={1440}>Last 24 hours</option>
          <option value={4320}>Last 3 days</option>
          <option value={10080}>Last 7 days</option>
          <option value={20160}>Last 14 days</option>
          <option value={43200}>Last 30 days</option>
        </select>
      </div>

      {Object.keys(levelCounts).length > 0 && (
        <div className="flex gap-2 mb-4">
          {Object.entries(levelCounts)
            .sort(([a], [b]) => {
              const order: Record<string, number> = { error: 0, err: 0, warn: 1, warning: 1, info: 2, debug: 3 };
              return (order[a] ?? 4) - (order[b] ?? 4);
            })
            .map(([lvl, count]) => (
              <button
                key={lvl}
                onClick={() => setLevel(level === lvl ? "" : lvl)}
                className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                  level === lvl ? "ring-2 ring-blue-500" : ""
                } ${LEVEL_BADGES[lvl] || LEVEL_BADGES.unknown}`}
              >
                {lvl}: {count}
              </button>
            ))}
        </div>
      )}

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      <div className="border border-gray-200 rounded-lg overflow-hidden bg-white">
        <div className="max-h-[calc(100vh-300px)] overflow-y-auto">
          {logs.length === 0 && !loading && (
            <div className="p-12 text-center text-gray-400">
              No logs found for the selected filters.
            </div>
          )}

          {logs.map((log, i) => {
            const lvl = log.level?.toLowerCase() || "unknown";
            const msg = formatMessage(log.message);
            const isExpanded = expandedRow === i;
            const isHttpRequest = typeof log.message === "object" && log.message?.path;

            return (
              <div key={i}>
                <div
                  onClick={() => setExpandedRow(isExpanded ? null : i)}
                  className={`flex items-start gap-3 px-4 py-2 border-b cursor-pointer hover:bg-gray-50 transition-colors ${
                    LEVEL_COLORS[lvl] || LEVEL_COLORS.unknown
                  }`}
                >
                  <span className="text-xs text-gray-400 font-mono whitespace-nowrap pt-0.5 min-w-[130px]">
                    {formatTimestamp(log.dt)}
                  </span>
                  <span
                    className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded min-w-[45px] text-center ${
                      LEVEL_BADGES[lvl] || LEVEL_BADGES.unknown
                    }`}
                  >
                    {lvl === "warning" ? "warn" : lvl}
                  </span>
                  {log.appname && (
                    <span className="text-[10px] text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded whitespace-nowrap">
                      {log.appname}
                    </span>
                  )}
                  <span className="text-sm font-mono flex-1 truncate">
                    {isHttpRequest ? (
                      <span>
                        <span className={`font-semibold ${
                          log.message.statusCode >= 400 ? "text-red-600" :
                          log.message.statusCode >= 300 ? "text-yellow-600" : "text-emerald-600"
                        }`}>
                          {log.message.method}
                        </span>
                        {" "}{log.message.path}
                        {" "}
                        <span className={
                          log.message.statusCode >= 400 ? "text-red-500" :
                          log.message.statusCode >= 300 ? "text-yellow-500" : "text-gray-400"
                        }>
                          {log.message.statusCode}
                        </span>
                        {log.message.responseTimeMS && (
                          <span className="text-gray-400 ml-1">
                            {log.message.responseTimeMS}ms
                          </span>
                        )}
                      </span>
                    ) : (
                      msg
                    )}
                  </span>
                  <svg
                    className={`w-4 h-4 text-gray-400 transition-transform flex-shrink-0 mt-0.5 ${isExpanded ? "rotate-180" : ""}`}
                    fill="none" stroke="currentColor" viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
                {isExpanded && (
                  <div className="bg-gray-900 border-b border-gray-200 p-4">
                    <pre className="text-xs text-gray-300 font-mono whitespace-pre-wrap break-all max-h-[400px] overflow-y-auto">
                      {(() => {
                        try {
                          const parsed = typeof log.raw === "string" ? JSON.parse(log.raw) : log.raw;
                          return JSON.stringify(parsed, null, 2);
                        } catch {
                          return log.raw;
                        }
                      })()}
                    </pre>
                  </div>
                )}
              </div>
            );
          })}

          {loading && (
            <div className="p-8 text-center">
              <div className="inline-block w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
