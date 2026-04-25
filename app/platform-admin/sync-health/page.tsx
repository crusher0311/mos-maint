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
  ShieldCheck,
  Gauge,
  Flame,
} from "lucide-react";
import { MAX_RETRY_ATTEMPTS } from "@/lib/integrations/tekmetric/ro-retry-constants";

interface SkippedRoSample {
  roId: number;
  error: string | null;
  at: string | null;
  retryAttempts?: number;
  lastRetryAt?: string | null;
  lastRetryError?: string | null;
  permanentlyFailed?: boolean;
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
  stillFailingRoCount?: number;
  permanentlyFailedRoCount?: number;
  recoveredRoCount?: number;
  lastRoRetryAt?: string | null;
  lastRoRetryRecovered?: number;
  lastRoRetryStillFailing?: number;
  lastRoRetryPermanentlyFailed?: number;
}

interface ForceSkippedWindow {
  shopId: number;
  start: string;
  end: string;
  at: string | null;
  spanDays: number | null;
  completed: boolean;
}

interface RecoveredRoSkipShop {
  shopId: number;
  completed: boolean;
  roSkipsFullyRecoveredAt: string | null;
  lastSkippedRosResolvedAt: string | null;
  resolvedSkippedRosTotal: number;
}

interface StaleArchivedRoSkipShop {
  shopId: number;
  entriesArchived: number;
  lastArchivedAt: string | null;
  oldestSkippedAt: string | null;
  permanentlyFailedCount: number;
}

interface ChunkSpeedShop {
  shopId: number;
  completed: boolean;
  chunkSampleCount?: number;
  medianDurationMs?: number | null;
  p95DurationMs?: number | null;
  maxDurationMs?: number | null;
  avgRosPerChunk?: number;
  avgBackoff429Ms?: number | null;
  totalBackoff429Ms?: number;
  jobsCacheHitRate?: number | null;
  jobsCacheTotal?: number;
  vehiclesCacheHitRate?: number | null;
  vehiclesCacheTotal?: number;
  customersCacheHitRate?: number | null;
  customersCacheTotal?: number;
  lastChunkAt?: string | null;
  lastChunkMetrics?: {
    at: string | null;
    durationMs: number | null;
    roCount: number;
    jobsCacheHitRate: number | null;
    vehiclesCacheHitRate: number | null;
    customersCacheHitRate: number | null;
    backoff429Ms: number;
    advanceMode: string | null;
  } | null;
}

interface JobsCachePrewarmShop {
  shopId: number;
  tekmetricShopId: number | null;
  completed: boolean;
  hasPrewarmRecord: boolean;
  completedAt: string | null;
  lookbackDays: number | null;
  rosScanned: number | null;
  terminalRosFound: number | null;
  alreadyCached: number | null;
  rosCached: number | null;
  jobsCached: number | null;
  errors: number | null;
  capped: boolean;
  durationMs: number | null;
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
  roRecoveredTotal?: number;
  roPermanentlyFailedTotal?: number;
  roStillFailingTotal?: number;
  recoveredRoSkipShops?: RecoveredRoSkipShop[];
  recoveredRoSkipShopCount?: number;
  staleArchivedSkippedRoShops?: StaleArchivedRoSkipShop[];
  staleArchivedSkippedRoShopCount?: number;
  staleArchivedSkippedRoTotal?: number;
  chunkSpeed?: ChunkSpeedShop[];
  chunkSpeedShopCount?: number;
  slowChunkShopCount?: number;
  slowChunkP95ThresholdMs?: number;
  jobsCachePrewarm?: JobsCachePrewarmShop[];
  jobsCachePrewarmShopCount?: number;
  jobsCachePrewarmMissingCount?: number;
  jobsCachePrewarmCappedCount?: number;
  jobsCachePrewarmErrorsCount?: number;
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
  const [runningNow, setRunningNow] = useState<number | null>(null);
  const [retryingRo, setRetryingRo] = useState<number | null>(null);
  const [retryingAllRo, setRetryingAllRo] = useState(false);
  const [resolvingKey, setResolvingKey] = useState<string | null>(null);
  const [rewarmingShopId, setRewarmingShopId] = useState<number | null>(null);
  const [rewarmingAll, setRewarmingAll] = useState(false);

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

  const resolveSkippedRo = async (shopId: number, roId: number) => {
    if (
      !confirm(
        `Mark skipped RO ${roId} (shop ${shopId}) as resolved? This archives it and removes it from the recently-skipped list. Use only after you've confirmed the data is in place (e.g. via a one-off re-fetch).`,
      )
    ) {
      return;
    }
    const key = `${shopId}:${roId}`;
    setResolvingKey(key);
    try {
      const res = await fetch("/api/admin/sync-health/skipped-ros/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shopId, roId }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        alert(json.error || "Failed to resolve RO");
      } else {
        load();
      }
    } catch (err: any) {
      alert(err.message || "Failed to resolve RO");
    } finally {
      setResolvingKey(null);
    }
  };

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

  const runTekmetricNow = async (shopId: number) => {
    if (
      !confirm(
        `Push shop ${shopId} to the front of the Tekmetric backfill queue and run a chunk now?`,
      )
    )
      return;
    setRunningNow(shopId);
    try {
      const res = await fetch(
        `/api/platform-admin/shops/${shopId}/tekmetric-run-now`,
        { method: "POST" },
      );
      const json = await res.json();
      if (!res.ok || !json.ok) {
        alert(json.error || "Failed to run Tekmetric chunk");
      } else {
        const r = json.result;
        const lines: string[] = [
          json.message || `Shop ${shopId}: chunk run requested`,
        ];
        if (r) {
          lines.push(
            `chunks: ${r.chunksProcessed} · jobs indexed: ${r.totalJobsIndexed} · ` +
              `normalized: ${r.totalNormalized} · skipped: ${r.totalSkipped}`,
          );
          if (r.complete) lines.push("backfill marked complete");
        }
        if (json.duration) lines.push(`duration: ${json.duration}`);
        if (json.tekmetricApiCalls != null)
          lines.push(`Tekmetric API calls: ${json.tekmetricApiCalls}`);
        alert(lines.join("\n"));
        load();
      }
    } catch (err: any) {
      alert(err.message || "Failed to run Tekmetric chunk");
    } finally {
      setRunningNow(null);
    }
  };

  const retryShopRos = async (shopId: number) => {
    if (!confirm(`Retry skipped repair orders for shop ${shopId} now?`)) return;
    setRetryingRo(shopId);
    try {
      const res = await fetch(
        `/api/platform-admin/shops/${shopId}/ro-retry`,
        { method: "POST" },
      );
      const json = await res.json();
      if (!res.ok || !json.ok) {
        alert(json.error || "Failed to retry skipped ROs");
      } else {
        const lines: string[] = [
          `Shop ${shopId}: attempted ${json.attempted}`,
          `recovered ${json.recovered} · still failing ${json.stillFailing} · gave up ${json.permanentlyFailed}`,
        ];
        if (json.reason) lines.push(`(${json.reason})`);
        if (Array.isArray(json.perRo) && json.perRo.length > 0) {
          lines.push("");
          for (const r of json.perRo.slice(0, 20)) {
            const tag =
              r.status === "recovered"
                ? "OK"
                : r.status === "permanently_failed"
                  ? "GAVE UP"
                  : "FAIL";
            const detail = r.error
              ? ` — ${r.error.slice(0, 80)}`
              : r.jobsIndexed != null
                ? ` (${r.jobsIndexed} jobs)`
                : "";
            lines.push(`RO ${r.roId} [${tag}, ${r.attempts} att]${detail}`);
          }
        }
        alert(lines.join("\n"));
        load();
      }
    } catch (err: any) {
      alert(err.message || "Failed to retry skipped ROs");
    } finally {
      setRetryingRo(null);
    }
  };

  const rewarmJobsCache = async (shopId: number, hasRecord: boolean) => {
    if (
      !confirm(
        hasRecord
          ? `Re-run jobs cache pre-warm for shop ${shopId}? This re-fetches recent terminal RO /jobs payloads. Safe to run anytime; idempotent.`
          : `Run jobs cache pre-warm for shop ${shopId}? This shop has no pre-warm record (likely onboarded before pre-warm shipped). Will fetch up to 500 recent terminal ROs.`,
      )
    ) {
      return;
    }
    setRewarmingShopId(shopId);
    try {
      const res = await fetch(
        `/api/platform-admin/shops/${shopId}/tekmetric-rewarm-jobs-cache`,
        { method: "POST" },
      );
      const json = await res.json();
      if (!res.ok || !json.ok) {
        alert(json.error || "Failed to re-warm jobs cache");
      } else {
        const r = json.result || {};
        alert(
          `Shop ${shopId} pre-warm complete\n` +
            `scanned ${r.rosScanned ?? 0} · terminal ${r.terminalRosFound ?? 0} · ` +
            `already cached ${r.alreadyCached ?? 0} · cached ${r.rosCached ?? 0}\n` +
            `jobs cached ${r.jobsCached ?? 0} · errors ${r.errors ?? 0}` +
            (r.capped ? " · CAPPED" : "") +
            ` · ${r.durationMs ?? 0}ms`,
        );
        load();
      }
    } catch (err: any) {
      alert(err.message || "Failed to re-warm jobs cache");
    } finally {
      setRewarmingShopId(null);
    }
  };

  const rewarmAllNeverWarmed = async (count: number) => {
    if (count <= 0) {
      alert("No never-warmed shops to warm.");
      return;
    }
    if (
      !confirm(
        `Warm jobs cache for all ${count} never-warmed Tekmetric shop(s)?\n\n` +
          `This iterates each shop serially (per-shop /jobs concurrency cap=3 ` +
          `inside the worker) and may take several minutes. If the time budget ` +
          `is exhausted, remaining shops are deferred — re-click to continue.`,
      )
    ) {
      return;
    }
    setRewarmingAll(true);
    try {
      const res = await fetch(
        `/api/platform-admin/tekmetric-rewarm-jobs-cache-all`,
        { method: "POST" },
      );
      const json = await res.json();
      if (!res.ok || !json.ok) {
        alert(json.error || "Failed to bulk-warm jobs cache");
      } else {
        const lines: string[] = [
          `Bulk pre-warm complete (${json.candidateShopCount} candidates)`,
          `warmed ${json.warmed} · errored ${json.errored} · ` +
            `skipped ${json.skipped} · deferred ${json.deferred}`,
          `ROs cached ${json.rosCachedTotal} · jobs cached ${json.jobsCachedTotal} · ` +
            `already cached ${json.alreadyCachedTotal}`,
        ];
        if (json.cappedShopCount > 0) {
          lines.push(`${json.cappedShopCount} shop(s) hit the 500-RO cap`);
        }
        if (json.perShopErrorsTotal > 0) {
          lines.push(`${json.perShopErrorsTotal} per-shop /jobs error(s) logged`);
        }
        if (json.duration) lines.push(`duration: ${json.duration}`);
        if (json.deferred > 0) {
          lines.push("");
          lines.push("Re-click to continue with deferred shops.");
        }
        alert(lines.join("\n"));
        load();
      }
    } catch (err: any) {
      alert(err.message || "Failed to bulk-warm jobs cache");
    } finally {
      setRewarmingAll(false);
    }
  };

  const retryAllRos = async () => {
    if (!confirm("Retry skipped repair orders across all eligible shops now?"))
      return;
    setRetryingAllRo(true);
    try {
      const res = await fetch(`/api/platform-admin/tekmetric-ro-retry`, {
        method: "POST",
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        alert(json.error || "Failed to retry skipped ROs");
      } else {
        alert(
          `Processed ${json.shopsProcessed}/${json.shopsConsidered} shops\n` +
            `attempted ${json.totalAttempted} · recovered ${json.totalRecovered} · ` +
            `still failing ${json.totalStillFailing} · gave up ${json.totalPermanentlyFailed}`,
        );
        load();
      }
    } catch (err: any) {
      alert(err.message || "Failed to retry skipped ROs");
    } finally {
      setRetryingAllRo(false);
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
                      <div className="flex items-center justify-end gap-2 flex-wrap">
                        {providerLabel === "Tekmetric" && (
                          <button
                            onClick={() => runTekmetricNow(d.shopId)}
                            disabled={
                              runningNow === d.shopId ||
                              triggering === d.shopId
                            }
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-100 text-blue-700 hover:bg-blue-200 rounded-lg disabled:opacity-50 whitespace-nowrap"
                            title="Push this shop to the front of the Tekmetric backfill queue and run chunks now until it completes or the cron times out (does not reset the cursor)"
                          >
                            {runningNow === d.shopId ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Play className="w-3.5 h-3.5" />
                            )}
                            Run chunk now
                          </button>
                        )}
                        <button
                          onClick={() =>
                            triggerBackfill(d.shopId, providerLabel)
                          }
                          disabled={
                            triggering === d.shopId ||
                            runningNow === d.shopId
                          }
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs bg-orange-100 text-orange-700 hover:bg-orange-200 rounded-lg disabled:opacity-50 whitespace-nowrap"
                        >
                          {triggering === d.shopId ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Play className="w-3.5 h-3.5" />
                          )}
                          Re-trigger backfill
                        </button>
                      </div>
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
    const isTekmetric = providerLabel === "Tekmetric";
    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-100">
        <div className="p-4 border-b border-gray-100 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-rose-600" />
            <h2 className="font-semibold text-gray-900">
              Skipped repair orders ({providerLabel})
            </h2>
            <span className="px-2 py-0.5 text-xs bg-rose-100 text-rose-700 rounded-full">
              {list.length} shop{list.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <p className="text-xs text-gray-500 hidden md:block">
              Individual ROs that threw inside an otherwise-processed chunk and
              were silently dropped. Recurring = skipped 2+ runs in a row.
            </p>
            {isTekmetric && list.length > 0 && (
              <button
                onClick={retryAllRos}
                disabled={retryingAllRo || retryingRo !== null}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs bg-rose-100 text-rose-700 hover:bg-rose-200 rounded-lg disabled:opacity-50 whitespace-nowrap"
                title="Run the skipped-RO retry job now across eligible shops"
              >
                {retryingAllRo ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5" />
                )}
                Retry all now
              </button>
            )}
          </div>
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
                    Recovered
                  </th>
                  <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">
                    Still failing
                  </th>
                  <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">
                    Permanently failed
                  </th>
                  <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">
                    Consecutive runs
                  </th>
                  <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">
                    Last retry
                  </th>
                  <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">
                    Recently skipped RO ids (attempts · error)
                  </th>
                  <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">
                    Actions
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
                        <span className="px-2 py-0.5 rounded-full text-xs bg-green-100 text-green-700">
                          {s.recoveredRoCount ?? 0}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-sm">
                        <span className="px-2 py-0.5 rounded-full text-xs bg-yellow-100 text-yellow-800">
                          {s.stillFailingRoCount ?? 0}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-sm">
                        <span className="px-2 py-0.5 rounded-full text-xs bg-rose-100 text-rose-800">
                          {s.permanentlyFailedRoCount ?? 0}
                        </span>
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
                      <td className="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">
                        {s.lastRoRetryAt ? (
                          <div>
                            <div>{formatDateTime(s.lastRoRetryAt)}</div>
                            <div className="text-xs text-gray-500 mt-0.5">
                              recovered {s.lastRoRetryRecovered ?? 0} ·
                              still failing {s.lastRoRetryStillFailing ?? 0} ·
                              gave up {s.lastRoRetryPermanentlyFailed ?? 0}
                            </div>
                          </div>
                        ) : (
                          <span className="text-gray-400">never</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-700 max-w-xl">
                        {(s.recentSkippedRos || []).length === 0 ? (
                          <span className="text-gray-400">—</span>
                        ) : (
                          <ul className="space-y-1">
                            {s.recentSkippedRos.map((r) => {
                              const attempts = r.retryAttempts ?? 0;
                              const errMsg = r.lastRetryError || r.error;
                              const key = `${s.shopId}:${r.roId}`;
                              const isResolving = resolvingKey === key;
                              return (
                                <li
                                  key={r.roId}
                                  className="font-mono text-xs text-gray-700 flex items-start gap-2"
                                >
                                  <div className="flex-1 min-w-0">
                                    <span
                                      className={
                                        r.permanentlyFailed
                                          ? "text-rose-800 font-semibold"
                                          : "text-rose-700"
                                      }
                                    >
                                      {r.roId}
                                    </span>
                                    <span className="text-gray-400 ml-2">
                                      {attempts > 0
                                        ? `[${attempts} retr${attempts === 1 ? "y" : "ies"}${
                                            r.permanentlyFailed ? " · gave up" : ""
                                          }]`
                                        : "[not retried yet]"}
                                    </span>
                                    {errMsg && (
                                      <span
                                        className="text-gray-500 ml-2"
                                        title={errMsg}
                                      >
                                        {errMsg.length > 80
                                          ? errMsg.slice(0, 80) + "…"
                                          : errMsg}
                                      </span>
                                    )}
                                  </div>
                                  <button
                                    onClick={() =>
                                      resolveSkippedRo(s.shopId, r.roId)
                                    }
                                    disabled={isResolving}
                                    title="Archive this RO and remove it from the recently-skipped list. Use after a manual re-fetch confirms the data is in place."
                                    className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-sans bg-emerald-50 text-emerald-700 hover:bg-emerald-100 rounded disabled:opacity-50"
                                  >
                                    {isResolving ? (
                                      <Loader2 className="w-3 h-3 animate-spin" />
                                    ) : (
                                      <CheckCircle2 className="w-3 h-3" />
                                    )}
                                    Mark resolved
                                  </button>
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {isTekmetric && (
                          <button
                            onClick={() => retryShopRos(s.shopId)}
                            disabled={
                              retryingRo === s.shopId ||
                              retryingAllRo ||
                              !(s.recentSkippedRos || []).some(
                                (r) =>
                                  !r.permanentlyFailed &&
                                  (r.retryAttempts ?? 0) < MAX_RETRY_ATTEMPTS,
                              )
                            }
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs bg-rose-100 text-rose-700 hover:bg-rose-200 rounded-lg disabled:opacity-50 whitespace-nowrap"
                            title="Retry this shop's skipped repair orders now"
                          >
                            {retryingRo === s.shopId ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <RefreshCw className="w-3.5 h-3.5" />
                            )}
                            Retry now
                          </button>
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

  const renderRecoveredRoSkipSection = (
    providerLabel: string,
    shops: RecoveredRoSkipShop[] | undefined,
  ) => {
    const list = shops || [];
    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-100">
        <div className="p-4 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-emerald-600" />
            <h2 className="font-semibold text-gray-900">
              Recently recovered RO skips ({providerLabel})
            </h2>
            <span className="px-2 py-0.5 text-xs bg-emerald-100 text-emerald-800 rounded-full">
              {list.length} shop{list.length === 1 ? "" : "s"}
            </span>
          </div>
          <p className="text-xs text-gray-500">
            Shops that previously dropped ROs but have since re-fetched them
            successfully. Shown for 14 days. Inspect the
            <code className="mx-1 px-1 bg-gray-100 rounded text-[11px]">tekmetric_skipped_ro_archive</code>
            collection for postmortems.
          </p>
        </div>

        {list.length === 0 ? (
          <div className="p-8 flex items-center justify-center gap-2 text-gray-500">
            <CheckCircle2 className="w-5 h-5 text-green-600" />
            No recently-recovered shops.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[800px]">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">
                    Shop ID
                  </th>
                  <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">
                    Recovered at
                  </th>
                  <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">
                    Last resolution
                  </th>
                  <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">
                    Total resolved
                  </th>
                  <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">
                    Backfill state
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {list.map((s) => (
                  <tr key={s.shopId} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-mono text-sm text-gray-900">
                      {s.shopId}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700 whitespace-nowrap">
                      {formatDateTime(s.roSkipsFullyRecoveredAt)}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">
                      {formatDateTime(s.lastSkippedRosResolvedAt)}
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-gray-900">
                      {s.resolvedSkippedRosTotal.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {s.completed ? (
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

  const formatDurationMs = (ms: number | null | undefined) => {
    if (ms == null || !Number.isFinite(ms)) return "—";
    if (ms < 1000) return `${ms}ms`;
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const minutes = Math.floor(seconds / 60);
    const remSec = Math.round(seconds - minutes * 60);
    return `${minutes}m${remSec.toString().padStart(2, "0")}s`;
  };

  const formatHitRate = (rate: number | null | undefined, total: number | undefined) => {
    if (rate == null || total === 0) return "—";
    return `${Math.round(rate * 100)}% (${(total ?? 0).toLocaleString()})`;
  };

  const renderJobsCachePrewarmSection = (
    providerLabel: string,
    shops: JobsCachePrewarmShop[] | undefined,
    missingCount: number | undefined,
    cappedCount: number | undefined,
    errorsCount: number | undefined,
  ) => {
    const list = shops || [];
    const missing = missingCount ?? 0;
    const capped = cappedCount ?? 0;
    const errored = errorsCount ?? 0;
    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-100">
        <div className="p-4 border-b border-gray-100 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 flex-wrap">
            <Flame className="w-5 h-5 text-orange-600" />
            <h2 className="font-semibold text-gray-900">
              Jobs cache pre-warm ({providerLabel})
            </h2>
            <span className="px-2 py-0.5 text-xs bg-orange-100 text-orange-700 rounded-full">
              {list.length} shop{list.length === 1 ? "" : "s"}
            </span>
            {missing > 0 && (
              <span
                className="px-2 py-0.5 text-xs bg-amber-100 text-amber-800 rounded-full"
                title="Shops with no pre-warm record at all — likely onboarded before the pre-warm rolled out. Use Re-warm to one-shot them."
              >
                {missing} never warmed
              </span>
            )}
            {missing > 0 && (
              <button
                onClick={() => rewarmAllNeverWarmed(missing)}
                disabled={rewarmingAll || rewarmingShopId !== null}
                className="inline-flex items-center gap-1.5 px-3 py-1 text-xs bg-orange-600 text-white hover:bg-orange-700 rounded-lg disabled:opacity-50 whitespace-nowrap"
                title="Iterate every shop with no pre-warm record and run prewarmTekmetricJobsCacheForOnboarding for each. Serial across shops; per-shop /jobs concurrency cap (3) preserved."
              >
                {rewarmingAll ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Flame className="w-3.5 h-3.5" />
                )}
                Warm all never-warmed
              </button>
            )}
            {capped > 0 && (
              <span
                className="px-2 py-0.5 text-xs bg-yellow-100 text-yellow-800 rounded-full"
                title="Pre-warm hit the 500-RO cap. The uncached tail will fill in opportunistically as the backfill walks back through history."
              >
                {capped} capped
              </span>
            )}
            {errored > 0 && (
              <span
                className="px-2 py-0.5 text-xs bg-rose-100 text-rose-800 rounded-full"
                title="Pre-warm logged at least one /jobs fetch failure for this shop"
              >
                {errored} with errors
              </span>
            )}
          </div>
          <p className="text-xs text-gray-500 hidden md:block max-w-md text-right">
            One-shot warm of <code className="px-1 bg-gray-100 rounded text-[11px]">tekmetric_jobs_cache</code>
            {" "}at onboarding. Stamped on
            {" "}<code className="px-1 bg-gray-100 rounded text-[11px]">shops.tekmetric.jobsCachePrewarm</code>.
            Idempotent — Re-warm is safe anytime.
          </p>
        </div>

        {list.length === 0 ? (
          <div className="p-8 flex items-center justify-center gap-2 text-gray-500">
            <Clock className="w-5 h-5 text-gray-400" />
            No {providerLabel} backfill rows yet.
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
                    Pre-warm status
                  </th>
                  <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">
                    Completed at
                  </th>
                  <th
                    className="text-right px-4 py-3 text-sm font-medium text-gray-600"
                    title="Recent terminal repair orders cached during pre-warm"
                  >
                    ROs cached
                  </th>
                  <th
                    className="text-right px-4 py-3 text-sm font-medium text-gray-600"
                    title="Total /jobs entries written to tekmetric_jobs_cache"
                  >
                    Jobs cached
                  </th>
                  <th
                    className="text-right px-4 py-3 text-sm font-medium text-gray-600"
                    title="Terminal ROs already had a fresh cache row at warm time (skipped)"
                  >
                    Already cached
                  </th>
                  <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">
                    Errors
                  </th>
                  <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">
                    Duration
                  </th>
                  <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {list.map((s) => {
                  const hasErrors = (s.errors ?? 0) > 0;
                  return (
                    <tr
                      key={s.shopId}
                      className={`align-top ${
                        s.hasPrewarmRecord
                          ? "hover:bg-gray-50"
                          : "bg-amber-50/40 hover:bg-amber-50"
                      }`}
                    >
                      <td className="px-4 py-3 font-mono text-sm text-gray-900">
                        {s.shopId}
                        {s.completed && (
                          <div className="text-xs text-gray-400 font-sans mt-0.5">
                            backfill complete
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {!s.hasPrewarmRecord ? (
                          <span
                            className="px-2 py-0.5 text-xs bg-amber-100 text-amber-800 rounded-full"
                            title="No jobsCachePrewarm record on this shop. Probably onboarded before the pre-warm rolled out."
                          >
                            Never warmed
                          </span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            <span className="px-2 py-0.5 text-xs bg-green-100 text-green-700 rounded-full">
                              Warmed
                            </span>
                            {s.capped && (
                              <span
                                className="px-2 py-0.5 text-xs bg-yellow-100 text-yellow-800 rounded-full"
                                title="Hit the 500-RO cap — uncached tail still warmed by the indexing path as the backfill progresses"
                              >
                                Capped
                              </span>
                            )}
                            {hasErrors && (
                              <span className="px-2 py-0.5 text-xs bg-rose-100 text-rose-800 rounded-full">
                                Errors
                              </span>
                            )}
                            {s.lookbackDays != null && (
                              <span
                                className="px-2 py-0.5 text-xs bg-gray-100 text-gray-700 rounded-full"
                                title="Lookback window scanned for terminal ROs"
                              >
                                {s.lookbackDays}d window
                              </span>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-700 whitespace-nowrap">
                        {formatDateTime(s.completedAt)}
                      </td>
                      <td className="px-4 py-3 text-right text-sm text-gray-900">
                        {s.rosCached == null
                          ? "—"
                          : s.rosCached.toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-right text-sm text-gray-900">
                        {s.jobsCached == null
                          ? "—"
                          : s.jobsCached.toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-right text-sm text-gray-700">
                        {s.alreadyCached == null
                          ? "—"
                          : s.alreadyCached.toLocaleString()}
                      </td>
                      <td
                        className={`px-4 py-3 text-right text-sm ${
                          hasErrors ? "text-rose-700 font-medium" : "text-gray-700"
                        }`}
                      >
                        {s.errors == null ? "—" : s.errors}
                      </td>
                      <td className="px-4 py-3 text-right text-sm text-gray-700 whitespace-nowrap">
                        {formatDurationMs(s.durationMs)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() =>
                            rewarmJobsCache(s.shopId, s.hasPrewarmRecord)
                          }
                          disabled={rewarmingShopId === s.shopId}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs bg-orange-100 text-orange-700 hover:bg-orange-200 rounded-lg disabled:opacity-50 whitespace-nowrap"
                          title="Re-run prewarmTekmetricJobsCacheForOnboarding for this shop. Idempotent — fresh cache rows are skipped."
                        >
                          {rewarmingShopId === s.shopId ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Flame className="w-3.5 h-3.5" />
                          )}
                          {s.hasPrewarmRecord ? "Re-warm" : "Warm now"}
                        </button>
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

  const renderChunkSpeedSection = (
    providerLabel: string,
    shops: ChunkSpeedShop[] | undefined,
    slowCount: number | undefined,
    slowThresholdMs: number | undefined,
  ) => {
    const list = shops || [];
    const slow = slowCount ?? 0;
    const thresholdLabel = formatDurationMs(slowThresholdMs ?? null);
    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-100">
        <div className="p-4 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Gauge className="w-5 h-5 text-indigo-600" />
            <h2 className="font-semibold text-gray-900">
              Chunk speed ({providerLabel})
            </h2>
            <span className="px-2 py-0.5 text-xs bg-indigo-100 text-indigo-700 rounded-full">
              {list.length} shop{list.length === 1 ? "" : "s"}
            </span>
            {slow > 0 && (
              <span
                className="px-2 py-0.5 text-xs bg-red-100 text-red-700 rounded-full"
                title={`p95 chunk duration over ${thresholdLabel}`}
              >
                {slow} slow
              </span>
            )}
          </div>
          <p className="text-xs text-gray-500">
            Median &amp; p95 chunk duration plus cache hit rates from the most
            recent chunks per shop. Slow = p95 over {thresholdLabel}.
            <span className="block mt-0.5 text-gray-400">
              *429 backoff is approximate — concurrent shops can leak backoff
              into each other&apos;s chunk totals.
            </span>
          </p>
        </div>

        {list.length === 0 ? (
          <div className="p-8 flex items-center justify-center gap-2 text-gray-500">
            <Clock className="w-5 h-5 text-gray-400" />
            No recent chunk metrics yet. Wait for the next backfill cron run.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1200px]">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">
                    Shop ID
                  </th>
                  <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">
                    Chunks
                  </th>
                  <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">
                    Median
                  </th>
                  <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">
                    p95
                  </th>
                  <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">
                    Max
                  </th>
                  <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">
                    ROs / chunk
                  </th>
                  <th
                    className="text-right px-4 py-3 text-sm font-medium text-gray-600"
                    title="Median jobs cache hit rate (in-mem cache + Mongo jobs cache + work-orders projection)"
                  >
                    Jobs cache
                  </th>
                  <th
                    className="text-right px-4 py-3 text-sm font-medium text-gray-600"
                    title="Vehicles cache hit rate"
                  >
                    Veh cache
                  </th>
                  <th
                    className="text-right px-4 py-3 text-sm font-medium text-gray-600"
                    title="Customers cache hit rate"
                  >
                    Cust cache
                  </th>
                  <th
                    className="text-right px-4 py-3 text-sm font-medium text-gray-600"
                    title="Total milliseconds spent waiting on Tekmetric 429 retries across recent chunks. Approximate when multiple shops run in parallel — a concurrent shop's backoff can leak into another shop's chunk."
                  >
                    429 backoff*
                  </th>
                  <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">
                    Last chunk
                  </th>
                  <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {list.map((s) => {
                  const isSlow =
                    slowThresholdMs != null &&
                    (s.p95DurationMs ?? 0) > slowThresholdMs;
                  return (
                    <tr key={s.shopId} className="hover:bg-gray-50 align-top">
                      <td className="px-4 py-3 font-mono text-sm text-gray-900">
                        {s.shopId}
                      </td>
                      <td className="px-4 py-3 text-right text-sm text-gray-900">
                        {s.chunkSampleCount ?? 0}
                      </td>
                      <td className="px-4 py-3 text-right text-sm text-gray-900">
                        {formatDurationMs(s.medianDurationMs)}
                      </td>
                      <td
                        className={`px-4 py-3 text-right text-sm font-medium ${
                          isSlow ? "text-red-700" : "text-gray-900"
                        }`}
                      >
                        {formatDurationMs(s.p95DurationMs)}
                      </td>
                      <td className="px-4 py-3 text-right text-sm text-gray-700">
                        {formatDurationMs(s.maxDurationMs)}
                      </td>
                      <td className="px-4 py-3 text-right text-sm text-gray-700">
                        {(s.avgRosPerChunk ?? 0).toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-right text-sm text-gray-700 whitespace-nowrap">
                        {formatHitRate(s.jobsCacheHitRate, s.jobsCacheTotal)}
                      </td>
                      <td className="px-4 py-3 text-right text-sm text-gray-700 whitespace-nowrap">
                        {formatHitRate(s.vehiclesCacheHitRate, s.vehiclesCacheTotal)}
                      </td>
                      <td className="px-4 py-3 text-right text-sm text-gray-700 whitespace-nowrap">
                        {formatHitRate(s.customersCacheHitRate, s.customersCacheTotal)}
                      </td>
                      <td className="px-4 py-3 text-right text-sm text-gray-700 whitespace-nowrap">
                        {formatDurationMs(s.totalBackoff429Ms)}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">
                        {formatDateTime(s.lastChunkAt ?? null)}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {s.completed ? (
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
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  };

  const renderStaleArchivedSection = (
    providerLabel: string,
    shops: StaleArchivedRoSkipShop[] | undefined,
    totalEntries: number | undefined,
  ) => {
    const list = shops || [];
    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-100">
        <div className="p-4 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock className="w-5 h-5 text-slate-500" />
            <h2 className="font-semibold text-gray-900">
              Stale, never re-fetched RO skips ({providerLabel})
            </h2>
            <span className="px-2 py-0.5 text-xs bg-slate-100 text-slate-700 rounded-full">
              {list.length} shop{list.length === 1 ? "" : "s"}
            </span>
            {totalEntries != null && totalEntries > 0 && (
              <span className="px-2 py-0.5 text-xs bg-slate-50 text-slate-600 rounded-full">
                {totalEntries} entries archived
              </span>
            )}
          </div>
          <p className="text-xs text-gray-500">
            Auto-archived after 30 days without a re-fetch. Cursor advanced
            past their window. Inspect the
            <code className="mx-1 px-1 bg-gray-100 rounded text-[11px]">tekmetric_skipped_ro_archive</code>
            collection (filter
            <code className="mx-1 px-1 bg-gray-100 rounded text-[11px]">stale: true</code>)
            for full records.
          </p>
        </div>

        {list.length === 0 ? (
          <div className="p-8 flex items-center justify-center gap-2 text-gray-500">
            <CheckCircle2 className="w-5 h-5 text-green-600" />
            No stale RO skips archived in the last 14 days.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[800px]">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">
                    Shop ID
                  </th>
                  <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">
                    Entries archived
                  </th>
                  <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">
                    Permanently failed
                  </th>
                  <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">
                    Oldest skip
                  </th>
                  <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">
                    Last archived
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {list.map((s) => (
                  <tr key={s.shopId} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-mono text-sm text-gray-900">
                      {s.shopId}
                    </td>
                    <td className="px-4 py-3 text-right text-sm">
                      <span className="px-2 py-0.5 rounded-full text-xs bg-slate-100 text-slate-700">
                        {s.entriesArchived}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-sm">
                      <span className="px-2 py-0.5 rounded-full text-xs bg-rose-100 text-rose-800">
                        {s.permanentlyFailedCount}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700 whitespace-nowrap">
                      {formatDateTime(s.oldestSkippedAt)}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">
                      {formatDateTime(s.lastArchivedAt)}
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

        <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-green-100 rounded-lg">
              <CheckCircle2 className="w-5 h-5 text-green-600" />
            </div>
            <span className="text-sm text-gray-600">Recovered ROs (Tek)</span>
          </div>
          <div className="text-2xl font-bold text-gray-900">
            {tek?.roRecoveredTotal ?? 0}
          </div>
          <div className="text-xs text-gray-500 mt-1">
            {tek?.roStillFailingTotal ?? 0} still failing ·
            {" "}
            {tek?.roPermanentlyFailedTotal ?? 0} permanently failed
          </div>
        </div>

        <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-emerald-100 rounded-lg">
              <ShieldCheck className="w-5 h-5 text-emerald-600" />
            </div>
            <span className="text-sm text-gray-600">Recovered RO skips (Tek)</span>
          </div>
          <div className="text-2xl font-bold text-gray-900">
            {tek?.recoveredRoSkipShopCount ?? 0}
          </div>
          <div className="text-xs text-gray-500 mt-1">
            shops cleared in last 14 days
          </div>
        </div>

        <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-orange-100 rounded-lg">
              <Flame className="w-5 h-5 text-orange-600" />
            </div>
            <span className="text-sm text-gray-600">Jobs cache pre-warm (Tek)</span>
          </div>
          <div className="text-2xl font-bold text-gray-900">
            {(tek?.jobsCachePrewarmShopCount ?? 0) -
              (tek?.jobsCachePrewarmMissingCount ?? 0)}
            {" / "}
            {tek?.jobsCachePrewarmShopCount ?? 0}
          </div>
          <div className="text-xs text-gray-500 mt-1">
            warmed shops · {tek?.jobsCachePrewarmMissingCount ?? 0} never warmed
            {(tek?.jobsCachePrewarmCappedCount ?? 0) > 0 &&
              ` · ${tek?.jobsCachePrewarmCappedCount} capped`}
          </div>
        </div>
      </div>

      {renderRoSkipSection("Tekmetric", tek?.roSkipShops)}

      {renderRecoveredRoSkipSection("Tekmetric", tek?.recoveredRoSkipShops)}

      {renderStaleArchivedSection(
        "Tekmetric",
        tek?.staleArchivedSkippedRoShops,
        tek?.staleArchivedSkippedRoTotal,
      )}

      {renderForceSkippedSection("Tekmetric", tek?.forceSkippedWindows, tek?.forceSkippedTotalSpanDays)}

      {renderChunkSpeedSection(
        "Tekmetric",
        tek?.chunkSpeed,
        tek?.slowChunkShopCount,
        tek?.slowChunkP95ThresholdMs,
      )}

      {renderChunkSpeedSection(
        "Protractor",
        pro?.chunkSpeed,
        pro?.slowChunkShopCount,
        pro?.slowChunkP95ThresholdMs,
      )}

      {renderChunkSpeedSection(
        "Shop-Ware",
        sw?.chunkSpeed,
        sw?.slowChunkShopCount,
        sw?.slowChunkP95ThresholdMs,
      )}

      {renderJobsCachePrewarmSection(
        "Tekmetric",
        tek?.jobsCachePrewarm,
        tek?.jobsCachePrewarmMissingCount,
        tek?.jobsCachePrewarmCappedCount,
        tek?.jobsCachePrewarmErrorsCount,
      )}

      {renderStuckSection("Tekmetric", tek?.diagnostics)}
      {renderStuckSection("Protractor", pro?.diagnostics)}
      {renderStuckSection("Shop-Ware", sw?.diagnostics)}
    </div>
  );
}
