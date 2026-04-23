"use client";

import { useState, useEffect } from "react";
import {
  Activity,
  AlertTriangle,
  RefreshCw,
  Loader2,
  Play,
  CheckCircle2,
  Clock,
  Database,
} from "lucide-react";

interface TekmetricDiagnostic {
  shopId: number;
  completed: boolean;
  stuck: boolean;
  reasons: string[];
  lastRunAt: string | null;
  hoursSinceLastRun: number | null;
  currentChunkEnd: string | null;
  previousChunkEnd: string | null;
  lastCursorMoveAt: string | null;
  daysCursorFrozen: number | null;
  lastError: string | null;
  lastErrorAt: string | null;
  autoClearedErrorAt: string | null;
  totalJobsIndexed: number;
  logicVersion: number | null;
}

interface SyncHealthData {
  backfill: {
    tekmetric: {
      complete: number;
      total: number;
      stuck: number;
      diagnostics: TekmetricDiagnostic[];
    };
    protractor: {
      complete: number;
      total: number;
    };
  };
  sync: {
    last24h: {
      total: number;
      successRate: string;
      avgDurationMs: number;
    };
  };
  errors: {
    unresolved: number;
  };
}

const REASON_LABELS: Record<string, { label: string; color: string }> = {
  never_started: { label: "Never started", color: "bg-gray-100 text-gray-700" },
  stale_run: { label: "Stale run (>48h)", color: "bg-yellow-100 text-yellow-800" },
  frozen_cursor: { label: "Frozen cursor (>3d)", color: "bg-orange-100 text-orange-800" },
  last_error: { label: "Last error", color: "bg-red-100 text-red-700" },
};

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

export default function SyncHealthPage() {
  const [data, setData] = useState<SyncHealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [triggering, setTriggering] = useState<number | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/sync-health");
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || "Failed to load sync health");
      }
      setData(json);
    } catch (err: any) {
      setError(err.message || "Failed to load sync health");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const triggerBackfill = async (shopId: number) => {
    if (!confirm(`Re-trigger Tekmetric backfill for shop ${shopId}?`)) return;
    setTriggering(shopId);
    try {
      const res = await fetch(`/api/platform-admin/shops/${shopId}/backfill`, {
        method: "POST",
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        alert(json.error || "Failed to trigger backfill");
      } else {
        alert(json.message || `Backfill triggered for shop ${shopId}`);
        load();
      }
    } catch (err: any) {
      alert(err.message || "Failed to trigger backfill");
    } finally {
      setTriggering(null);
    }
  };

  if (loading) {
    return (
      <div className="p-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-1/4" />
          <div className="h-32 bg-gray-200 rounded-lg" />
          <div className="h-64 bg-gray-200 rounded-lg" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8">
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-4">
          {error}
        </div>
      </div>
    );
  }

  const tek = data?.backfill.tekmetric;
  const stuckShops = (tek?.diagnostics || []).filter((d) => d.stuck);

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Sync Health</h1>
          <p className="text-gray-600">Backfill progress and stuck-shop diagnostics</p>
        </div>
        <button
          onClick={load}
          className="p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg"
          title="Refresh"
        >
          <RefreshCw className="w-5 h-5" />
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-[rgba(60,129,195,0.15)] rounded-lg">
              <Database className="w-5 h-5 text-[#3c81c3]" />
            </div>
            <span className="text-sm text-gray-600">Tekmetric backfill</span>
          </div>
          <div className="text-2xl font-bold text-gray-900">
            {tek?.complete ?? 0} / {tek?.total ?? 0}
          </div>
          <div className="text-xs text-gray-500 mt-1">complete</div>
        </div>

        <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-red-100 rounded-lg">
              <AlertTriangle className="w-5 h-5 text-red-600" />
            </div>
            <span className="text-sm text-gray-600">Stuck Tekmetric shops</span>
          </div>
          <div className="text-2xl font-bold text-gray-900">{tek?.stuck ?? 0}</div>
          <div className="text-xs text-gray-500 mt-1">need attention</div>
        </div>

        <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-green-100 rounded-lg">
              <Activity className="w-5 h-5 text-green-600" />
            </div>
            <span className="text-sm text-gray-600">Sync success (24h)</span>
          </div>
          <div className="text-2xl font-bold text-gray-900">
            {data?.sync.last24h.successRate ?? "N/A"}
          </div>
          <div className="text-xs text-gray-500 mt-1">
            {data?.sync.last24h.total ?? 0} runs
          </div>
        </div>

        <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-orange-100 rounded-lg">
              <Clock className="w-5 h-5 text-orange-600" />
            </div>
            <span className="text-sm text-gray-600">Unresolved errors</span>
          </div>
          <div className="text-2xl font-bold text-gray-900">
            {data?.errors.unresolved ?? 0}
          </div>
          <div className="text-xs text-gray-500 mt-1">across all workers</div>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100">
        <div className="p-4 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-red-600" />
            <h2 className="font-semibold text-gray-900">
              Stuck Tekmetric shops
            </h2>
            <span className="px-2 py-0.5 text-xs bg-red-100 text-red-700 rounded-full">
              {stuckShops.length}
            </span>
          </div>
          <p className="text-xs text-gray-500">
            Stuck = never started, no run in 48h, frozen cursor &gt;3d, or has a
            current error.
          </p>
        </div>

        {stuckShops.length === 0 ? (
          <div className="p-8 flex items-center justify-center gap-2 text-gray-500">
            <CheckCircle2 className="w-5 h-5 text-green-600" />
            No stuck Tekmetric shops. All in-flight backfills look healthy.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1100px]">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">
                    Shop ID
                  </th>
                  <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">
                    Reasons
                  </th>
                  <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">
                    Hours since last run
                  </th>
                  <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">
                    Days cursor frozen
                  </th>
                  <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">
                    Last run
                  </th>
                  <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">
                    Last error
                  </th>
                  <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {stuckShops.map((d) => (
                  <tr key={d.shopId} className="hover:bg-gray-50 align-top">
                    <td className="px-4 py-3 font-mono text-sm text-gray-900">
                      {d.shopId}
                      <div className="text-xs text-gray-500 font-sans mt-0.5">
                        {d.totalJobsIndexed.toLocaleString()} jobs
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {d.reasons.map((r) => {
                          const meta = REASON_LABELS[r] || {
                            label: r,
                            color: "bg-gray-100 text-gray-700",
                          };
                          return (
                            <span
                              key={r}
                              className={`px-2 py-0.5 text-xs rounded-full ${meta.color}`}
                            >
                              {meta.label}
                            </span>
                          );
                        })}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-gray-900">
                      {d.hoursSinceLastRun == null
                        ? "—"
                        : `${d.hoursSinceLastRun}h`}
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-gray-900">
                      {d.daysCursorFrozen == null
                        ? "—"
                        : `${d.daysCursorFrozen}d`}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">
                      {formatDateTime(d.lastRunAt)}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700 max-w-md">
                      {d.lastError ? (
                        <div>
                          <div
                            className="truncate text-red-700"
                            title={d.lastError}
                          >
                            {d.lastError}
                          </div>
                          {d.lastErrorAt && (
                            <div className="text-xs text-gray-500 mt-0.5">
                              {formatDateTime(d.lastErrorAt)}
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => triggerBackfill(d.shopId)}
                        disabled={triggering === d.shopId}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs bg-orange-100 text-orange-700 hover:bg-orange-200 rounded-lg disabled:opacity-50"
                      >
                        {triggering === d.shopId ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Play className="w-3.5 h-3.5" />
                        )}
                          Re-trigger backfill
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
