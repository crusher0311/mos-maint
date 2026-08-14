"use client";

// Platform-admin extension telemetry viewer (Task #1112).
//
// Answers "what happened at shop X yesterday": recent events filterable
// by shop, event type, and time range, plus a per-shop rollup (error
// counts, slow-call counts, p95 duration). Data comes from the 30-day
// TTL `extension_telemetry_events` pipeline via
// /api/platform-admin/extension-telemetry.
import { useCallback, useEffect, useState } from "react";
import { Activity, AlertTriangle, Clock, RefreshCw, Timer } from "lucide-react";

interface EventRow {
  id: string;
  event: string;
  provider: string | null;
  mosShopId: number | null;
  smsShopId: string | null;
  shopName: string | null;
  endpoint: string | null;
  userEmail: string | null;
  extensionVersion: string | null;
  payload: Record<string, unknown>;
  occurredAt: string;
}

interface RollupRow {
  mosShopId: number | null;
  shopName: string | null;
  totalEvents: number;
  errorCount: number;
  slowCallCount: number;
  fetchFailureCount: number;
  p95DurationMs: number | null;
  lastOccurredAt: string | null;
}

interface ApiData {
  events: EventRow[];
  rollup: RollupRow[];
  eventNames: string[];
  generatedAt: string;
}

const EVENT_COLORS: Record<string, string> = {
  "client.error": "bg-red-100 text-red-800",
  "api.slow_call": "bg-amber-100 text-amber-800",
  "api.fetch_failure": "bg-orange-100 text-orange-800",
  "auth.token_invalid_cleared": "bg-red-50 text-red-700",
  "auth.soft_expired": "bg-yellow-50 text-yellow-800",
  "action.dropped": "bg-rose-50 text-rose-800",
  "context.incomplete": "bg-slate-100 text-slate-700",
};

const HOUR_OPTIONS = [
  { label: "6h", value: 6 },
  { label: "24h", value: 24 },
  { label: "3d", value: 72 },
  { label: "7d", value: 168 },
  { label: "30d", value: 720 },
];

function fmtMs(ms: number | null | undefined): string {
  if (ms == null || typeof ms !== "number") return "—";
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

function fmtWhen(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

export default function ExtensionTelemetryPage() {
  const [data, setData] = useState<ApiData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hours, setHours] = useState(24);
  const [event, setEvent] = useState<string>("");
  const [shopId, setShopId] = useState<string>("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ hours: String(hours) });
      if (event) params.set("event", event);
      if (shopId.trim()) params.set("shopId", shopId.trim());
      const res = await fetch(`/api/platform-admin/extension-telemetry?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (e: any) {
      setError(e?.message || "Failed to load telemetry");
    } finally {
      setLoading(false);
    }
  }, [hours, event, shopId]);

  useEffect(() => {
    load();
  }, [load]);

  const totalErrors = data?.rollup.reduce((a, r) => a + r.errorCount, 0) ?? 0;
  const totalSlow = data?.rollup.reduce((a, r) => a + r.slowCallCount, 0) ?? 0;
  const totalEvents = data?.rollup.reduce((a, r) => a + r.totalEvents, 0) ?? 0;

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 flex items-center gap-2">
            <Activity className="w-6 h-6 text-blue-600" />
            Extension Telemetry
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Errors and slow calls reported by the Detect Dog extension, per shop with timestamps.
            Events auto-expire after 30 days.
          </p>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded-md text-gray-700"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <div className="flex gap-1">
          {HOUR_OPTIONS.map((o) => (
            <button
              key={o.value}
              onClick={() => setHours(o.value)}
              className={`px-3 py-1 rounded text-sm ${
                hours === o.value ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
        <select
          value={event}
          onChange={(e) => setEvent(e.target.value)}
          className="border rounded-md px-2 py-1.5 text-sm bg-white"
        >
          <option value="">All events</option>
          {(data?.eventNames || []).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <input
          value={shopId}
          onChange={(e) => setShopId(e.target.value)}
          placeholder="Shop ID"
          className="border rounded-md px-2 py-1.5 text-sm w-28"
          inputMode="numeric"
        />
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-white border rounded-lg p-4">
          <div className="text-xs text-gray-500 uppercase flex items-center gap-1">
            <Activity className="w-3.5 h-3.5" /> Total events
          </div>
          <div className="text-2xl font-semibold mt-1">{totalEvents.toLocaleString()}</div>
        </div>
        <div className="bg-white border rounded-lg p-4">
          <div className="text-xs text-gray-500 uppercase flex items-center gap-1">
            <AlertTriangle className="w-3.5 h-3.5 text-red-500" /> Client errors
          </div>
          <div className="text-2xl font-semibold mt-1">{totalErrors.toLocaleString()}</div>
        </div>
        <div className="bg-white border rounded-lg p-4">
          <div className="text-xs text-gray-500 uppercase flex items-center gap-1">
            <Timer className="w-3.5 h-3.5 text-amber-500" /> Slow calls
          </div>
          <div className="text-2xl font-semibold mt-1">{totalSlow.toLocaleString()}</div>
        </div>
      </div>

      {/* Per-shop rollup */}
      <h2 className="text-lg font-medium text-gray-900 mb-2">Per-shop summary</h2>
      <div className="bg-white border rounded-lg overflow-x-auto mb-8">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-3 py-2 text-left font-medium text-gray-600">Shop</th>
              <th className="px-3 py-2 text-right font-medium text-gray-600">Events</th>
              <th className="px-3 py-2 text-right font-medium text-gray-600">Errors</th>
              <th className="px-3 py-2 text-right font-medium text-gray-600">Slow calls</th>
              <th className="px-3 py-2 text-right font-medium text-gray-600">Fetch failures</th>
              <th className="px-3 py-2 text-right font-medium text-gray-600">p95 duration</th>
              <th className="px-3 py-2 text-left font-medium text-gray-600">Last event</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {(data?.rollup || []).length === 0 && !loading && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-gray-500">
                  No telemetry in this window.
                </td>
              </tr>
            )}
            {(data?.rollup || []).map((r) => (
              <tr
                key={String(r.mosShopId)}
                className="hover:bg-gray-50 cursor-pointer"
                onClick={() => setShopId(r.mosShopId != null ? String(r.mosShopId) : "")}
                title="Click to filter events to this shop"
              >
                <td className="px-3 py-2">
                  {r.mosShopId != null ? (
                    <span>
                      <span className="font-medium">{r.shopName || `Shop ${r.mosShopId}`}</span>
                      <span className="ml-1 text-xs text-gray-400">#{r.mosShopId}</span>
                    </span>
                  ) : (
                    <span className="text-gray-400 italic">unknown shop</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right font-mono">{r.totalEvents.toLocaleString()}</td>
                <td className={`px-3 py-2 text-right font-mono ${r.errorCount > 0 ? "text-red-600 font-semibold" : ""}`}>
                  {r.errorCount.toLocaleString()}
                </td>
                <td className={`px-3 py-2 text-right font-mono ${r.slowCallCount > 0 ? "text-amber-600 font-semibold" : ""}`}>
                  {r.slowCallCount.toLocaleString()}
                </td>
                <td className="px-3 py-2 text-right font-mono">{r.fetchFailureCount.toLocaleString()}</td>
                <td className="px-3 py-2 text-right font-mono">{fmtMs(r.p95DurationMs)}</td>
                <td className="px-3 py-2 text-xs text-gray-500">{fmtWhen(r.lastOccurredAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Recent events */}
      <h2 className="text-lg font-medium text-gray-900 mb-2 flex items-center gap-2">
        <Clock className="w-4 h-4 text-gray-400" /> Recent events
      </h2>
      <div className="bg-white border rounded-lg overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-3 py-2 text-left font-medium text-gray-600">When</th>
              <th className="px-3 py-2 text-left font-medium text-gray-600">Shop</th>
              <th className="px-3 py-2 text-left font-medium text-gray-600">Event</th>
              <th className="px-3 py-2 text-left font-medium text-gray-600">Endpoint / message</th>
              <th className="px-3 py-2 text-right font-medium text-gray-600">Duration</th>
              <th className="px-3 py-2 text-left font-medium text-gray-600">Ext ver</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {(data?.events || []).length === 0 && !loading && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                  No events match these filters.
                </td>
              </tr>
            )}
            {(data?.events || []).map((e) => {
              const p = e.payload as any;
              // Throttled events fold suppressed occurrences into count —
              // surface it on every event type, not just client.error.
              const countSuffix = typeof p?.count === "number" && p.count > 1 ? ` (×${p.count})` : "";
              const detail =
                e.event === "client.error"
                  ? `[${p?.surface || "?"}] ${p?.message || ""}${countSuffix}`
                  : `${e.endpoint || p?.reason || p?.action || "—"}${countSuffix}`;
              return (
                <tr key={e.id} className="hover:bg-gray-50">
                  <td className="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">{fmtWhen(e.occurredAt)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {e.mosShopId != null ? (
                      <span>
                        <span className="font-medium">{e.shopName || `Shop ${e.mosShopId}`}</span>
                        <span className="ml-1 text-xs text-gray-400">#{e.mosShopId}</span>
                      </span>
                    ) : (
                      <span className="text-gray-400 italic">unknown</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs ${EVENT_COLORS[e.event] || "bg-gray-100 text-gray-700"}`}>
                      {e.event}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-gray-700 max-w-md truncate" title={detail}>
                    {detail}
                    {typeof p?.status === "number" && p.status > 0 && (
                      <span className="ml-1 text-gray-400">({p.status})</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{fmtMs(p?.durationMs)}</td>
                  <td className="px-3 py-2 text-xs text-gray-500">{e.extensionVersion || "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {data && (
        <p className="mt-3 text-xs text-gray-400">
          Showing up to {data.events.length} events. Generated {fmtWhen(data.generatedAt)}.
        </p>
      )}
    </div>
  );
}
