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
  SkipForward,
} from "lucide-react";

interface SkippedRoSample {
  roId: number;
  error: string | null;
  at: string | null;
}

interface StuckDiagnostic {
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
  lastRoSkipCount?: number;
  lastRoSkipAt?: string | null;
  consecutiveRoSkipRuns?: number;
  recentSkippedRos?: SkippedRoSample[];
}

interface RoSkipShop {
  shopId: number;
  consecutiveRoSkipRuns: number;
  lastRoSkipCount: number;
  lastRoSkipAt: string | null;
  recentSkippedRos: SkippedRoSample[];
}

interface ForceSkippedWindow {
  shopId: number;
  start: string;
  end: string;
  at: string | null;
  spanDays: number | null;
  completed: boolean;
}

interface ProviderBackfill {
  complete: number;
  total: number;
  stuck: number;
  diagnostics: StuckDiagnostic[];
  forceSkippedWindows?: ForceSkippedWindow[];
  forceSkippedShopCount?: number;
  forceSkippedTotalSpanDays?: number;
  roSkipShopCount?: number;
  recurringRoSkipShopCount?: number;
  roSkipShops?: RoSkipShop[];
}

interface SyncHealthData {
  backfill: {
    tekmetric: ProviderBackfill;
    protractor: ProviderBackfill;
    shopware: ProviderBackfill;
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
  recurring_ro_skips: { label: "Recurring RO skips", color: "bg-rose-100 text-rose-800" },
};

function formatDate(value: string | null): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleDateString();
  } catch {
    return value;
  }
}

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

  const triggerBackfill = async (shopId: number, providerLabel: string) => {
    if (!confirm(`Re-trigger ${providerLabel} backfill for shop ${shopId}?`)) return;
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
  const pro = data?.backfill.protractor;
  const sw = data?.backfill.shopware;
  const totalStuck =
    (tek?.stuck ?? 0) + (pro?.stuck ?? 0) + (sw?.stuck ?? 0);

  const renderStuckSection = (
    providerLabel: string,
    diagnostics: StuckDiagnostic[] | undefined
  ) => {
    const stuckShops = (diagnostics || []).filter((d) => d.stuck);
    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-100">
        <div className="p-4 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-red-600" />
            <h2 className="font-semibold text-gray-900">
              Stuck {providerLabel} shops
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
            No stuck {providerLabel} shops. All in-flight backfills look healthy.
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
                        onClick={() => triggerBackfill(d.shopId, providerLabel)}
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
    );
  };

  const renderRoSkipSection = (
    providerLabel: string,
    shops: RoSkipShop[] | undefined,
  ) => {
    const list = shops || [];
    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-100">
        <div className="p-4 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-rose-600" />
            <h2 className="font-semibold text-gray-900">
              Skipped repair orders ({providerLabel})
            </h2>
            <span className="px-2 py-0.5 text-xs bg-rose-100 text-rose-700 rounded-full">
              {list.length} shop{list.length === 1 ? "" : "s"}
            </span>
          </div>
          <p className="text-xs text-gray-500">
            Individual ROs that threw inside an otherwise-processed chunk and
            were silently dropped. Recurring = skipped 2+ runs in a row.
          </p>
        </div>

        {list.length === 0 ? (
          <div className="p-8 flex items-center justify-center gap-2 text-gray-500">
            <CheckCircle2 className="w-5 h-5 text-green-600" />
            No shops dropping repair orders. No silent data loss.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1000px]">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">
                    Shop ID
                  </th>
                  <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">
                    Consecutive runs
                  </th>
                  <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">
                    Last run skips
                  </th>
                  <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">
                    Last skip at
                  </th>
                  <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">
                    Recently skipped RO ids (with error)
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {list.map((s) => {
                  const recurring = (s.consecutiveRoSkipRuns || 0) >= 2;
                  return (
                    <tr key={s.shopId} className="hover:bg-gray-50 align-top">
                      <td className="px-4 py-3 font-mono text-sm text-gray-900">
                        {s.shopId}
                      </td>
                      <td className="px-4 py-3 text-right text-sm">
                        <span
                          className={`px-2 py-0.5 rounded-full text-xs ${
                            recurring
                              ? "bg-rose-100 text-rose-800"
                              : "bg-yellow-100 text-yellow-800"
                          }`}
                        >
                          {s.consecutiveRoSkipRuns}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-sm text-gray-900">
                        {s.lastRoSkipCount}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">
                        {formatDateTime(s.lastRoSkipAt)}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-700 max-w-xl">
                        {s.recentSkippedRos.length === 0 ? (
                          <span className="text-gray-400">—</span>
                        ) : (
                          <ul className="space-y-1">
                            {s.recentSkippedRos.map((r) => (
                              <li
                                key={r.roId}
                                className="font-mono text-xs text-gray-700"
                              >
                                <span className="text-rose-700">{r.roId}</span>
                                {r.error && (
                                  <span
                                    className="text-gray-500 ml-2"
                                    title={r.error}
                                  >
                                    {r.error.length > 80
                                      ? r.error.slice(0, 80) + "…"
                                      : r.error}
                                  </span>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  };

  const renderForceSkippedSection = (
    providerLabel: string,
    windows: ForceSkippedWindow[] | undefined,
    totalSpanDays: number | undefined
  ) => {
    const list = windows || [];
    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-100">
        <div className="p-4 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <SkipForward className="w-5 h-5 text-amber-600" />
            <h2 className="font-semibold text-gray-900">
              Force-skipped {providerLabel} windows
            </h2>
            <span className="px-2 py-0.5 text-xs bg-amber-100 text-amber-800 rounded-full">
              {list.length} shop{list.length === 1 ? "" : "s"}
            </span>
            {list.length > 0 && (
              <span className="px-2 py-0.5 text-xs bg-amber-50 text-amber-700 rounded-full">
                {totalSpanDays ?? 0}d total span
              </span>
            )}
          </div>
          <p className="text-xs text-gray-500">
            Cron force-advanced past a chunk after 3 consecutive failures. The
            data in these windows was never re-fetched.
          </p>
        </div>

        {list.length === 0 ? (
          <div className="p-8 flex items-center justify-center gap-2 text-gray-500">
            <CheckCircle2 className="w-5 h-5 text-green-600" />
            No force-skipped {providerLabel} windows. No unrecovered gaps.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px]">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">
                    Shop ID
                  </th>
                  <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">
                    Window start
                  </th>
                  <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">
                    Window end
                  </th>
                  <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">
                    Span (days)
                  </th>
                  <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">
                    Skipped at
                  </th>
                  <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">
                    Backfill state
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {list.map((w) => (
                  <tr key={`${w.shopId}-${w.start}`} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-mono text-sm text-gray-900">
                      {w.shopId}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700 whitespace-nowrap">
                      {formatDate(w.start)}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700 whitespace-nowrap">
                      {formatDate(w.end)}
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-gray-900">
                      {w.spanDays == null ? "—" : `${w.spanDays}d`}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">
                      {formatDateTime(w.at)}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {w.completed ? (
                        <span className="px-2 py-0.5 text-xs bg-green-100 text-green-700 rounded-full">
                          Complete
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 text-xs bg-blue-100 text-blue-700 rounded-full">
                          In progress
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  };

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

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
            <div className="p-2 bg-[rgba(60,129,195,0.15)] rounded-lg">
              <Database className="w-5 h-5 text-[#3c81c3]" />
            </div>
            <span className="text-sm text-gray-600">Protractor backfill</span>
          </div>
          <div className="text-2xl font-bold text-gray-900">
            {pro?.complete ?? 0} / {pro?.total ?? 0}
          </div>
          <div className="text-xs text-gray-500 mt-1">complete</div>
        </div>

        <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-[rgba(60,129,195,0.15)] rounded-lg">
              <Database className="w-5 h-5 text-[#3c81c3]" />
            </div>
            <span className="text-sm text-gray-600">Shop-Ware backfill</span>
          </div>
          <div className="text-2xl font-bold text-gray-900">
            {sw?.complete ?? 0} / {sw?.total ?? 0}
          </div>
          <div className="text-xs text-gray-500 mt-1">complete</div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-red-100 rounded-lg">
              <AlertTriangle className="w-5 h-5 text-red-600" />
            </div>
            <span className="text-sm text-gray-600">Stuck shops (all)</span>
          </div>
          <div className="text-2xl font-bold text-gray-900">{totalStuck}</div>
          <div className="text-xs text-gray-500 mt-1">
            Tek {tek?.stuck ?? 0} · Pro {pro?.stuck ?? 0} · SW {sw?.stuck ?? 0}
          </div>
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

        <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-amber-100 rounded-lg">
              <SkipForward className="w-5 h-5 text-amber-600" />
            </div>
            <span className="text-sm text-gray-600">Force-skipped windows (Tek)</span>
          </div>
          <div className="text-2xl font-bold text-gray-900">
            {tek?.forceSkippedShopCount ?? 0}
          </div>
          <div className="text-xs text-gray-500 mt-1">
            {tek?.forceSkippedTotalSpanDays ?? 0}d total unrecovered
          </div>
        </div>

        <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-rose-100 rounded-lg">
              <AlertTriangle className="w-5 h-5 text-rose-600" />
            </div>
            <span className="text-sm text-gray-600">Skipped ROs (Tek)</span>
          </div>
          <div className="text-2xl font-bold text-gray-900">
            {tek?.roSkipShopCount ?? 0}
          </div>
          <div className="text-xs text-gray-500 mt-1">
            {tek?.recurringRoSkipShopCount ?? 0} recurring (2+ runs)
          </div>
        </div>
      </div>

      {renderRoSkipSection("Tekmetric", tek?.roSkipShops)}

      {renderForceSkippedSection("Tekmetric", tek?.forceSkippedWindows, tek?.forceSkippedTotalSpanDays)}

      {renderStuckSection("Tekmetric", tek?.diagnostics)}
      {renderStuckSection("Protractor", pro?.diagnostics)}
      {renderStuckSection("Shop-Ware", sw?.diagnostics)}
    </div>
  );
}
