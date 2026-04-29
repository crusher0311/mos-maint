"use client";

import { Fragment, useState, useEffect } from "react";
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
  X,
  BookOpen,
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
  // Probe fields written by operational helpers (e.g.
  // scripts/restart-never-started-tekmetric-shops.ts) on dedicated
  // columns so the cron's fair-queue ordering and 6h auto-clear gate
  // are not perturbed. Surfaced so on-call can see whether a probe
  // ran and whether it succeeded without querying Mongo.
  lastProbedAt?: string | null;
  lastProbeOk?: boolean | null;
  lastProbeError?: string | null;
  lastProbeNote?: string | null;
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
  // Live dedup row from `backfill_chunk_speed_alerts` (written by
  // /api/cron/backfill-chunk-speed-health). Present only while the shop is
  // breaching — clears as soon as the cron deletes the dedup row, so this
  // badge mirrors what on-call has actually been paged on.
  alert?: {
    reasons: string[];
    firstAlertedAt: string | null;
    lastAlertedAt: string | null;
  } | null;
}

interface JobsCachePrewarmShop {
  shopId: number;
  // Tekmetric-only — undefined for Shop-Ware. The renderer doesn't
  // surface either ID directly; they're shipped in case the UI ever
  // wants to deep-link.
  tekmetricShopId?: number | null;
  shopwareTenantId?: number | null;
  shopwareShopId?: number | null;
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

// Per-shop Protractor invoice-cache pre-warm status (stamped at
// onboarding by lib/protractor-jobs-prewarm.ts under
// `shops.protractor.invoiceCachePrewarm`). Surfaced read-only — the
// Protractor backfill warms the rest of the cache opportunistically as
// it walks back through history, so there's no manual rewarm action
// surfaced from this view (yet).
interface ProtractorInvoiceCachePrewarmShop {
  shopId: number;
  connectionId: string | null;
  completed: boolean;
  hasPrewarmRecord: boolean;
  completedAt: string | null;
  lookbackDays: number | null;
  invoicesScanned: number | null;
  alreadyCached: number | null;
  invoicesCached: number | null;
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
  // Tekmetric and Shop-Ware both ship `JobsCachePrewarmShop` rows here
  // — Shop-Ware's record is mapped onto the same view-model server-side
  // (see `app/api/admin/sync-health/route.ts`) so the renderer doesn't
  // need to fork.
  jobsCachePrewarm?: JobsCachePrewarmShop[];
  jobsCachePrewarmShopCount?: number;
  jobsCachePrewarmMissingCount?: number;
  jobsCachePrewarmCappedCount?: number;
  jobsCachePrewarmErrorsCount?: number;
  // Protractor-only: per-shop invoice-cache pre-warm overlay.
  invoiceCachePrewarm?: ProtractorInvoiceCachePrewarmShop[];
  invoiceCachePrewarmShopCount?: number;
  invoiceCachePrewarmMissingCount?: number;
  invoiceCachePrewarmCappedCount?: number;
  invoiceCachePrewarmErrorsCount?: number;
  // Tekmetric-only: persisted catch-up run summaries (task #181).
  // Populated only on the tekmetric branch by the API; other providers
  // get `undefined` so the renderer can short-circuit when needed.
  catchupRuns?: CatchupRun[];
  catchupRunCount?: number;
}

interface CatchupRun {
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  dryRun: boolean;
  prodBaseUrl: string | null;
  filters: { onlyShops: number[]; skipShops: number[] };
  totals: {
    processed: number;
    completed: number;
    recovered: number;
    needsFollowup: number;
    dryRun: number;
  };
  completedShopIds: number[];
  recoveredShopIds: number[];
  dryRunShopIds: number[];
  needsFollowup: { shopId: number; reason: string | null }[];
  suggestedRerunCommand: string | null;
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

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m > 0) return `${m}m ${s.toString().padStart(2, "0")}s`;
  return `${s}s`;
}

interface RunNowChunkEvent {
  index: number;
  jobsIndexed: number;
  skipped: number;
  normalizedCount: number;
  complete: boolean;
  message: string;
  chunkDurationMs: number;
  cursor: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  consecutiveChunkErrors: number;
  lastRoSkipCount: number;
  cumulativeJobsIndexed: number | null;
  totals: {
    chunksProcessed: number;
    totalJobsIndexed: number;
    totalSkipped: number;
    totalNormalized: number;
  };
  tekmetricApiCalls: number;
  elapsedMs: number;
}

type RunNowStatus = "running" | "complete" | "aborted" | "error";

interface RunNowState {
  shopId: number;
  shopName: string;
  status: RunNowStatus;
  startedAt: number;
  endedAt: number | null;
  chunks: RunNowChunkEvent[];
  totals: {
    chunksProcessed: number;
    totalJobsIndexed: number;
    totalSkipped: number;
    totalNormalized: number;
  };
  cursor: string | null;
  lastError: string | null;
  errorMessage: string | null;
  tekmetricApiCalls: number;
  elapsedMs: number;
  completedFlag: boolean;
  timedOut: boolean;
  abortController: AbortController | null;
  maxChunks: number | null;
  reachedClientReader: boolean;
}

function makeInitialRunNowState(
  shopId: number,
  shopName: string,
  abortController: AbortController,
): RunNowState {
  return {
    shopId,
    shopName,
    status: "running",
    startedAt: Date.now(),
    endedAt: null,
    chunks: [],
    totals: {
      chunksProcessed: 0,
      totalJobsIndexed: 0,
      totalSkipped: 0,
      totalNormalized: 0,
    },
    cursor: null,
    lastError: null,
    errorMessage: null,
    tekmetricApiCalls: 0,
    elapsedMs: 0,
    completedFlag: false,
    timedOut: false,
    abortController,
    maxChunks: null,
    reachedClientReader: false,
  };
}

export default function SyncHealthPage() {
  const [data, setData] = useState<SyncHealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [triggering, setTriggering] = useState<number | null>(null);
  const [runNowByShop, setRunNowByShop] = useState<
    Record<number, RunNowState>
  >({});
  // `runningNow` tracks the alert-based run-chunk-now flow used by
  // Protractor and Shop-Ware. Tekmetric runs go through `runNowByShop`
  // because they stream chunk-by-chunk progress.
  const [runningNow, setRunningNow] = useState<number | null>(null);
  const [retryingRo, setRetryingRo] = useState<number | null>(null);
  const [retryingAllRo, setRetryingAllRo] = useState(false);
  const [resolvingKey, setResolvingKey] = useState<string | null>(null);
  const [bulkResolvingShopId, setBulkResolvingShopId] = useState<number | null>(
    null,
  );
  const [rewarmingShopId, setRewarmingShopId] = useState<number | null>(null);
  const [rewarmingShopWareShopId, setRewarmingShopWareShopId] = useState<
    number | null
  >(null);
  const [rewarmingProtractorShopId, setRewarmingProtractorShopId] = useState<
    number | null
  >(null);
  const [rewarmingAll, setRewarmingAll] = useState(false);
  const [rewarmingAllShopWare, setRewarmingAllShopWare] = useState(false);
  const [rewarmingAllProtractor, setRewarmingAllProtractor] = useState(false);
  // Re-render tick so the inline run-now panel's elapsed time keeps moving
  // between chunk events (which can be 60s+ apart for slow shops).
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const anyRunning = Object.values(runNowByShop).some(
      (r) => r.status === "running",
    );
    if (!anyRunning) return;
    const id = setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [runNowByShop]);

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

  const resolveAllSkippedRos = async (shopId: number, roIds: number[]) => {
    if (roIds.length === 0) {
      alert("No skipped ROs to resolve for this shop.");
      return;
    }
    if (
      !confirm(
        `Mark ALL ${roIds.length} skipped RO${roIds.length === 1 ? "" : "s"} for shop ${shopId} as resolved?\n\n` +
          `This archives every entry in the recently-skipped list and removes it from the rolling window. ` +
          `Use only after you've confirmed the data is in place (e.g. via a one-off re-fetch script that cleared the whole batch).`,
      )
    ) {
      return;
    }
    setBulkResolvingShopId(shopId);
    try {
      const res = await fetch("/api/admin/sync-health/skipped-ros/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shopId, roIds }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        alert(json.error || "Failed to bulk-resolve skipped ROs");
      } else {
        const lines: string[] = [
          `Shop ${shopId}: archived ${json.archivedCount}/${roIds.length} skipped RO${roIds.length === 1 ? "" : "s"}`,
        ];
        if (json.fullyRecovered) {
          lines.push("Rolling window now empty — shop fully recovered.");
        } else if (typeof json.remaining === "number") {
          lines.push(`${json.remaining} entr${json.remaining === 1 ? "y" : "ies"} still on the list.`);
        }
        if (Array.isArray(json.failures) && json.failures.length > 0) {
          lines.push("");
          lines.push(`${json.failures.length} failed:`);
          for (const f of json.failures.slice(0, 10)) {
            lines.push(`RO ${f.roId} — ${f.error}`);
          }
        }
        alert(lines.join("\n"));
        load();
      }
    } catch (err: any) {
      alert(err.message || "Failed to bulk-resolve skipped ROs");
    } finally {
      setBulkResolvingShopId(null);
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

  // Per-provider mapping for the "Run chunk now" stuck-shop button. Each
  // entry points at the platform-admin endpoint that fronts that provider's
  // backfill cron (Tekmetric/Protractor/Shop-Ware all expose a sync code
  // path we can invoke without waiting for the next scheduled tick).
  // Tekmetric is special-cased: it streams chunk-by-chunk progress through
  // `runTekmetricNow` instead of going through the alert-based `runChunkNow`.
  const RUN_NOW_PROVIDERS: Record<
    string,
    { endpoint: string; queueLabel: string; tooltip: string }
  > = {
    Tekmetric: {
      endpoint: "tekmetric-run-now",
      queueLabel: "Tekmetric backfill queue",
      tooltip:
        "Stream chunk-by-chunk progress while pushing this shop to the front of the Tekmetric backfill queue (does not reset the cursor)",
    },
    Protractor: {
      endpoint: "protractor-run-now",
      queueLabel: "Protractor backfill queue",
      tooltip:
        "Run a single Protractor backfill pass for this shop right now (one batch of chunks, no auto-retry). Re-click to advance further if not yet complete (does not reset the cursor).",
    },
    "Shop-Ware": {
      endpoint: "shopware-run-now",
      queueLabel: "Shop-Ware backfill queue",
      tooltip:
        "Push this shop to the front of the Shop-Ware backfill queue and run chunks now until it completes or the cron times out (does not reset the cursor)",
    },
  };

  // Alert-based run-now flow for Protractor and Shop-Ware. Tekmetric uses
  // `runTekmetricNow` below, which streams progress over SSE.
  const runChunkNow = async (shopId: number, providerLabel: string) => {
    const cfg = RUN_NOW_PROVIDERS[providerLabel];
    if (!cfg) return;
    if (
      !confirm(
        `Push shop ${shopId} to the front of the ${cfg.queueLabel} and run a chunk now?`,
      )
    )
      return;
    setRunningNow(shopId);
    try {
      const res = await fetch(
        `/api/platform-admin/shops/${shopId}/${cfg.endpoint}`,
        { method: "POST" },
      );
      const json = await res.json();
      if (!res.ok || !json.ok) {
        alert(json.error || `Failed to run ${providerLabel} chunk`);
      } else {
        const r = json.result;
        const lines: string[] = [
          json.message || `Shop ${shopId}: chunk run requested`,
        ];
        if (r) {
          // The three providers don't share a chunk-result schema, so we
          // pick the fields that are actually present per provider rather
          // than assuming a uniform shape.
          if (providerLabel === "Tekmetric") {
            lines.push(
              `chunks: ${r.chunksProcessed} · jobs indexed: ${r.totalJobsIndexed} · ` +
                `normalized: ${r.totalNormalized} · skipped: ${r.totalSkipped}`,
            );
            if (r.complete) lines.push("backfill marked complete");
          } else if (providerLabel === "Protractor") {
            lines.push(
              `chunks: ${r.chunksProcessed ?? 0} · jobs indexed: ${r.totalJobsIndexed ?? 0}`,
            );
            if (r.complete) lines.push("backfill marked complete");
            if (r.error) lines.push(`error: ${r.error}`);
          } else if (providerLabel === "Shop-Ware") {
            const status = r.status ? ` (${r.status})` : "";
            lines.push(
              `chunks: ${r.chunksProcessed ?? 0} · ROs: ${r.totalRos ?? 0} · ` +
                `jobs: ${r.totalJobs ?? 0} · vehicles: ${r.totalVehicles ?? 0} · ` +
                `customers: ${r.totalCustomers ?? 0}${status}`,
            );
            if (r.error) lines.push(`error: ${r.error}`);
          }
        }
        if (json.duration) lines.push(`duration: ${json.duration}`);
        if (json.tekmetricApiCalls != null)
          lines.push(`Tekmetric API calls: ${json.tekmetricApiCalls}`);
        alert(lines.join("\n"));
        load();
      }
    } catch (err: any) {
      alert(err.message || `Failed to run ${providerLabel} chunk`);
    } finally {
      setRunningNow(null);
    }
  };

  const updateRunNow = (
    shopId: number,
    updater: (prev: RunNowState) => RunNowState,
  ) => {
    setRunNowByShop((prev) => {
      const cur = prev[shopId];
      if (!cur) return prev;
      return { ...prev, [shopId]: updater(cur) };
    });
  };

  const runTekmetricNow = async (shopId: number, shopName: string) => {
    const existing = runNowByShop[shopId];
    if (existing && existing.status === "running") {
      // Already streaming — surface the live row instead of starting a 2nd
      // request that would just queue behind this one in Tekmetric anyway.
      return;
    }
    if (
      !confirm(
        `Push shop ${shopId} to the front of the Tekmetric backfill queue and stream chunk-by-chunk progress?`,
      )
    )
      return;

    const abortController = new AbortController();
    setRunNowByShop((prev) => ({
      ...prev,
      [shopId]: makeInitialRunNowState(shopId, shopName, abortController),
    }));

    let res: Response;
    try {
      res = await fetch(
        `/api/platform-admin/shops/${shopId}/tekmetric-run-now`,
        { method: "POST", signal: abortController.signal },
      );
    } catch (err: any) {
      const aborted = err?.name === "AbortError";
      updateRunNow(shopId, (prev) => ({
        ...prev,
        status: aborted ? "aborted" : "error",
        endedAt: Date.now(),
        elapsedMs: Date.now() - prev.startedAt,
        errorMessage: aborted ? null : err?.message || String(err),
        abortController: null,
      }));
      return;
    }

    if (!res.ok || !res.body) {
      let message = `HTTP ${res.status}`;
      try {
        const j = await res.json();
        if (j?.error) message = j.error;
      } catch {
        /* not JSON, keep status */
      }
      updateRunNow(shopId, (prev) => ({
        ...prev,
        status: "error",
        endedAt: Date.now(),
        elapsedMs: Date.now() - prev.startedAt,
        errorMessage: message,
        abortController: null,
      }));
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const handleEvent = (event: string, payload: any) => {
      if (event === "start") {
        updateRunNow(shopId, (prev) => ({
          ...prev,
          maxChunks:
            typeof payload?.maxChunks === "number" ? payload.maxChunks : null,
          reachedClientReader: true,
        }));
        return;
      }
      if (event === "chunk") {
        const chunkEvent = payload as RunNowChunkEvent;
        updateRunNow(shopId, (prev) => ({
          ...prev,
          // Keep most recent ~12 chunks so the log doesn't grow unbounded
          // for a 25-chunk run that the engineer leaves on screen. The
          // top-level totals row carries the full picture.
          chunks: [...prev.chunks, chunkEvent].slice(-12),
          totals: chunkEvent.totals,
          cursor: chunkEvent.cursor,
          lastError: chunkEvent.lastError,
          tekmetricApiCalls: chunkEvent.tekmetricApiCalls,
          elapsedMs: chunkEvent.elapsedMs,
        }));
        return;
      }
      if (event === "chunk_error") {
        updateRunNow(shopId, (prev) => ({
          ...prev,
          lastError: payload?.message || "chunk threw",
          tekmetricApiCalls:
            typeof payload?.tekmetricApiCalls === "number"
              ? payload.tekmetricApiCalls
              : prev.tekmetricApiCalls,
          elapsedMs:
            typeof payload?.elapsedMs === "number"
              ? payload.elapsedMs
              : prev.elapsedMs,
        }));
        return;
      }
      if (event === "complete") {
        updateRunNow(shopId, (prev) => ({
          ...prev,
          status: payload?.aborted ? "aborted" : "complete",
          completedFlag: !!payload?.completed,
          timedOut: !!payload?.timedOut,
          endedAt: Date.now(),
          totals: {
            chunksProcessed:
              payload?.chunksProcessed ?? prev.totals.chunksProcessed,
            totalJobsIndexed:
              payload?.totalJobsIndexed ?? prev.totals.totalJobsIndexed,
            totalSkipped: payload?.totalSkipped ?? prev.totals.totalSkipped,
            totalNormalized:
              payload?.totalNormalized ?? prev.totals.totalNormalized,
          },
          tekmetricApiCalls:
            payload?.tekmetricApiCalls ?? prev.tekmetricApiCalls,
          elapsedMs: payload?.durationMs ?? prev.elapsedMs,
          abortController: null,
        }));
        return;
      }
      if (event === "error") {
        updateRunNow(shopId, (prev) => ({
          ...prev,
          status: "error",
          endedAt: Date.now(),
          errorMessage: payload?.message || "stream error",
          elapsedMs:
            typeof payload?.elapsedMs === "number"
              ? payload.elapsedMs
              : Date.now() - prev.startedAt,
          abortController: null,
        }));
        return;
      }
    };

    const flushFrame = (frame: string) => {
      if (!frame.trim() || frame.startsWith(":")) return;
      let event = "message";
      const dataParts: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataParts.push(line.slice(5).trim());
      }
      if (dataParts.length === 0) return;
      try {
        const payload = JSON.parse(dataParts.join("\n"));
        handleEvent(event, payload);
      } catch {
        /* malformed frame; skip */
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          flushFrame(frame);
        }
      }
      // Drain any tail
      if (buffer.trim()) flushFrame(buffer);
    } catch (err: any) {
      const aborted = err?.name === "AbortError";
      updateRunNow(shopId, (prev) => {
        if (prev.status !== "running") return prev;
        return {
          ...prev,
          status: aborted ? "aborted" : "error",
          endedAt: Date.now(),
          elapsedMs: Date.now() - prev.startedAt,
          errorMessage: aborted ? null : err?.message || String(err),
          abortController: null,
        };
      });
    } finally {
      // If the stream ended without an explicit complete frame, mark it done
      // so the UI doesn't sit on a spinner forever.
      updateRunNow(shopId, (prev) => {
        if (prev.status !== "running") return prev;
        return {
          ...prev,
          status: "complete",
          endedAt: Date.now(),
          elapsedMs: Date.now() - prev.startedAt,
          abortController: null,
        };
      });
      // Refresh diagnostics once the run is done so reasons / lastRunAt /
      // totalJobsIndexed reflect what the chunks just wrote.
      load();
    }
  };

  const cancelRunTekmetricNow = (shopId: number) => {
    const cur = runNowByShop[shopId];
    if (!cur || cur.status !== "running" || !cur.abortController) return;
    cur.abortController.abort();
  };

  const dismissRunTekmetricNow = (shopId: number) => {
    setRunNowByShop((prev) => {
      const next = { ...prev };
      delete next[shopId];
      return next;
    });
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

  const rewarmShopWareJobsCache = async (
    shopId: number,
    hasRecord: boolean,
  ) => {
    if (
      !confirm(
        hasRecord
          ? `Re-run Shop-Ware jobs cache pre-warm for shop ${shopId}? This re-fetches the recent ROs window. Safe to run anytime; idempotent (matching contentHash rows are skipped).`
          : `Run Shop-Ware jobs cache pre-warm for shop ${shopId}? This shop has no pre-warm record (likely onboarded before pre-warm shipped). Will fetch up to 1000 recent ROs.`,
      )
    ) {
      return;
    }
    setRewarmingShopWareShopId(shopId);
    try {
      const res = await fetch(
        `/api/platform-admin/shops/${shopId}/shopware-rewarm-jobs-cache`,
        { method: "POST" },
      );
      const json = await res.json();
      if (!res.ok || !json.ok) {
        alert(json.error || "Failed to re-warm Shop-Ware jobs cache");
      } else {
        const r = json.result || {};
        alert(
          `Shop ${shopId} Shop-Ware pre-warm complete\n` +
            `ROs fetched ${r.rosFetched ?? 0} · stored ${r.rosStored ?? 0} · ` +
            `jobs indexed ${r.jobsIndexed ?? 0} · skipped ${r.jobsSkipped ?? 0}\n` +
            `vehicles ${r.vehiclesStored ?? 0} · customers ${r.customersStored ?? 0}` +
            (r.cursorAdvanced ? ` · cursor → ${r.cursorAdvancedTo ?? "(advanced)"}` : "") +
            `\nerrors ${r.errors ?? 0}` +
            (r.capped ? " · CAPPED" : "") +
            ` · ${r.durationMs ?? 0}ms`,
        );
        load();
      }
    } catch (err: any) {
      alert(err.message || "Failed to re-warm Shop-Ware jobs cache");
    } finally {
      setRewarmingShopWareShopId(null);
    }
  };

  const rewarmProtractorInvoiceCache = async (
    shopId: number,
    hasRecord: boolean,
  ) => {
    if (
      !confirm(
        hasRecord
          ? `Re-run Protractor invoice cache pre-warm for shop ${shopId}? This re-fetches recent /Invoice/{id} payloads. Safe to run anytime; idempotent (fresh cache rows are skipped).`
          : `Run Protractor invoice cache pre-warm for shop ${shopId}? This shop has no pre-warm record. Will fetch up to 500 recent invoices.`,
      )
    ) {
      return;
    }
    setRewarmingProtractorShopId(shopId);
    try {
      const res = await fetch(
        `/api/platform-admin/shops/${shopId}/protractor-rewarm-jobs-cache`,
        { method: "POST" },
      );
      const json = await res.json();
      if (!res.ok || !json.ok) {
        alert(json.error || "Failed to re-warm Protractor invoice cache");
      } else {
        const r = json.result || {};
        alert(
          `Shop ${shopId} Protractor pre-warm complete\n` +
            `invoices scanned ${r.invoicesScanned ?? 0} · ` +
            `already cached ${r.alreadyCached ?? 0} · cached ${r.invoicesCached ?? 0}\n` +
            `errors ${r.errors ?? 0}` +
            (r.capped ? " · CAPPED" : "") +
            ` · ${r.durationMs ?? 0}ms`,
        );
        load();
      }
    } catch (err: any) {
      alert(err.message || "Failed to re-warm Protractor invoice cache");
    } finally {
      setRewarmingProtractorShopId(null);
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

  const rewarmAllNeverWarmedShopWare = async (count: number) => {
    if (count <= 0) {
      alert("No never-warmed shops to warm.");
      return;
    }
    if (
      !confirm(
        `Warm jobs cache for all ${count} never-warmed Shop-Ware shop(s)?\n\n` +
          `This iterates each shop serially (per-shop SW worker preserves ` +
          `its own concurrency profile) and may take several minutes. If the ` +
          `time budget is exhausted, remaining shops are deferred — re-click ` +
          `to continue.`,
      )
    ) {
      return;
    }
    setRewarmingAllShopWare(true);
    try {
      const res = await fetch(
        `/api/platform-admin/shopware-rewarm-jobs-cache-all`,
        { method: "POST" },
      );
      const json = await res.json();
      if (!res.ok || !json.ok) {
        alert(json.error || "Failed to bulk-warm Shop-Ware jobs cache");
      } else {
        const lines: string[] = [
          `Bulk Shop-Ware pre-warm complete (${json.candidateShopCount} candidates)`,
          `warmed ${json.warmed} · errored ${json.errored} · ` +
            `skipped ${json.skipped} · deferred ${json.deferred}`,
          `ROs fetched ${json.rosFetchedTotal} · stored ${json.rosStoredTotal} · ` +
            `jobs indexed ${json.jobsIndexedTotal} · skipped ${json.jobsSkippedTotal}`,
          `vehicles ${json.vehiclesStoredTotal} · customers ${json.customersStoredTotal} · ` +
            `cursor advanced on ${json.cursorAdvancedShopCount} shop(s)`,
        ];
        if (json.cappedShopCount > 0) {
          lines.push(`${json.cappedShopCount} shop(s) hit the 1000-RO cap`);
        }
        if (json.perShopErrorsTotal > 0) {
          lines.push(`${json.perShopErrorsTotal} per-shop write error(s) logged`);
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
      alert(err.message || "Failed to bulk-warm Shop-Ware jobs cache");
    } finally {
      setRewarmingAllShopWare(false);
    }
  };

  const rewarmAllNeverWarmedProtractor = async (count: number) => {
    if (count <= 0) {
      alert("No never-warmed shops to warm.");
      return;
    }
    if (
      !confirm(
        `Warm invoice cache for all ${count} never-warmed Protractor shop(s)?\n\n` +
          `This iterates each shop serially (per-shop /Invoice/{id} concurrency ` +
          `cap=3 inside the worker) and may take several minutes. If the time ` +
          `budget is exhausted, remaining shops are deferred — re-click to continue.`,
      )
    ) {
      return;
    }
    setRewarmingAllProtractor(true);
    try {
      const res = await fetch(
        `/api/platform-admin/protractor-rewarm-jobs-cache-all`,
        { method: "POST" },
      );
      const json = await res.json();
      if (!res.ok || !json.ok) {
        alert(json.error || "Failed to bulk-warm Protractor invoice cache");
      } else {
        const lines: string[] = [
          `Bulk Protractor pre-warm complete (${json.candidateShopCount} candidates)`,
          `warmed ${json.warmed} · errored ${json.errored} · ` +
            `skipped ${json.skipped} · deferred ${json.deferred}`,
          `invoices scanned ${json.invoicesScannedTotal} · cached ${json.invoicesCachedTotal} · ` +
            `already cached ${json.alreadyCachedTotal}`,
        ];
        if (json.cappedShopCount > 0) {
          lines.push(`${json.cappedShopCount} shop(s) hit the 500-invoice cap`);
        }
        if (json.perShopErrorsTotal > 0) {
          lines.push(
            `${json.perShopErrorsTotal} per-shop /Invoice fetch error(s) logged`,
          );
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
      alert(err.message || "Failed to bulk-warm Protractor invoice cache");
    } finally {
      setRewarmingAllProtractor(false);
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

  const renderRunNowProgress = (rn: RunNowState) => {
    const statusMeta: Record<
      RunNowStatus,
      { label: string; color: string; icon: JSX.Element }
    > = {
      running: {
        label: "Streaming",
        color: "bg-blue-100 text-blue-800 border-blue-200",
        icon: <Loader2 className="w-3.5 h-3.5 animate-spin" />,
      },
      complete: {
        label: rn.completedFlag
          ? "Backfill complete"
          : rn.timedOut
            ? "Stopped at timeout"
            : "Done",
        color: "bg-green-100 text-green-800 border-green-200",
        icon: <CheckCircle2 className="w-3.5 h-3.5" />,
      },
      aborted: {
        label: "Aborted",
        color: "bg-yellow-100 text-yellow-800 border-yellow-200",
        icon: <X className="w-3.5 h-3.5" />,
      },
      error: {
        label: "Error",
        color: "bg-red-100 text-red-800 border-red-200",
        icon: <AlertTriangle className="w-3.5 h-3.5" />,
      },
    };
    const meta = statusMeta[rn.status];
    const elapsed =
      rn.status === "running"
        ? Date.now() - rn.startedAt
        : rn.elapsedMs || (rn.endedAt ?? Date.now()) - rn.startedAt;
    return (
      <div className="rounded-lg border border-blue-200 bg-white p-3 text-xs space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border ${meta.color}`}
            >
              {meta.icon}
              {meta.label}
            </span>
            <span className="text-gray-600">
              chunk {rn.totals.chunksProcessed}
              {rn.maxChunks ? ` / ${rn.maxChunks}` : ""}
            </span>
            <span className="text-gray-600">·</span>
            <span className="text-gray-600">
              elapsed {formatDuration(elapsed)}
            </span>
            {rn.tekmetricApiCalls > 0 && (
              <>
                <span className="text-gray-600">·</span>
                <span className="text-gray-600">
                  {rn.tekmetricApiCalls} API calls
                </span>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            {rn.status === "running" ? (
              <button
                onClick={() => cancelRunTekmetricNow(rn.shopId)}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-yellow-100 text-yellow-800 hover:bg-yellow-200"
                title="Stop after the current in-flight chunk"
              >
                <X className="w-3 h-3" />
                Abort
              </button>
            ) : (
              <button
                onClick={() => dismissRunTekmetricNow(rn.shopId)}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200"
              >
                <X className="w-3 h-3" />
                Dismiss
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div className="bg-gray-50 rounded px-2 py-1.5">
            <div className="text-gray-500">Jobs indexed</div>
            <div className="font-semibold text-gray-900">
              {rn.totals.totalJobsIndexed.toLocaleString()}
            </div>
          </div>
          <div className="bg-gray-50 rounded px-2 py-1.5">
            <div className="text-gray-500">Normalized</div>
            <div className="font-semibold text-gray-900">
              {rn.totals.totalNormalized.toLocaleString()}
            </div>
          </div>
          <div className="bg-gray-50 rounded px-2 py-1.5">
            <div className="text-gray-500">Unchanged</div>
            <div className="font-semibold text-gray-900">
              {rn.totals.totalSkipped.toLocaleString()}
            </div>
          </div>
          <div className="bg-gray-50 rounded px-2 py-1.5">
            <div className="text-gray-500">Cursor</div>
            <div className="font-mono text-[11px] text-gray-900 truncate">
              {rn.cursor ? rn.cursor.split("T")[0] : "—"}
            </div>
          </div>
        </div>

        {rn.errorMessage && (
          <div className="rounded bg-red-50 border border-red-200 px-2 py-1.5 text-red-700">
            {rn.errorMessage}
          </div>
        )}
        {rn.lastError && rn.status !== "error" && (
          <div className="rounded bg-amber-50 border border-amber-200 px-2 py-1.5 text-amber-800">
            chunk warning: {rn.lastError}
          </div>
        )}

        {rn.chunks.length > 0 && (
          <div className="border border-gray-100 rounded">
            <div className="px-2 py-1 bg-gray-50 text-[11px] uppercase tracking-wide text-gray-500">
              Recent chunks
            </div>
            <ul className="divide-y divide-gray-100 max-h-44 overflow-y-auto">
              {rn.chunks
                .slice()
                .reverse()
                .map((c) => (
                  <li
                    key={c.index}
                    className="px-2 py-1 flex items-center justify-between gap-2"
                  >
                    <span className="text-gray-700 truncate">
                      <span className="font-mono text-gray-500">
                        #{c.index}
                      </span>{" "}
                      {c.message}
                    </span>
                    <span className="flex items-center gap-2 text-gray-500 whitespace-nowrap">
                      <span>{formatDuration(c.chunkDurationMs)}</span>
                      {c.complete && (
                        <span className="text-green-700">complete</span>
                      )}
                    </span>
                  </li>
                ))}
            </ul>
          </div>
        )}
      </div>
    );
  };

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
                  <th
                    className="text-left px-4 py-3 text-sm font-medium text-gray-600"
                    title="Out-of-band probe written by on-call helper scripts (e.g. restart-never-started-tekmetric-shops). Lives on dedicated lastProbedAt/lastProbeOk/lastProbeError/lastProbeNote columns so the cron's queue ordering isn't perturbed."
                  >
                    Last probe
                  </th>
                  <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {stuckShops.map((d) => {
                  const runNow = runNowByShop[d.shopId];
                  const isRunningNow = runNow?.status === "running";
                  return (
                  <Fragment key={d.shopId}>
                  <tr className="hover:bg-gray-50 align-top">
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
                    <td className="px-4 py-3 text-sm text-gray-700 max-w-md">
                      {d.lastProbedAt ? (
                        <div>
                          <div className="flex items-center gap-2">
                            {d.lastProbeOk === false ? (
                              <span
                                className="px-2 py-0.5 text-xs rounded-full bg-red-100 text-red-700 font-medium"
                                title="Out-of-band probe failed — visually distinct from lastError, which only reflects cron-driven chunk attempts."
                              >
                                Probe FAIL
                              </span>
                            ) : d.lastProbeOk === true ? (
                              <span
                                className="px-2 py-0.5 text-xs rounded-full bg-green-100 text-green-700 font-medium"
                                title="Out-of-band probe succeeded (e.g. Tekmetric reachable). Independent of lastError."
                              >
                                Probe OK
                              </span>
                            ) : (
                              <span
                                className="px-2 py-0.5 text-xs rounded-full bg-gray-100 text-gray-700"
                                title="Probe ran but ok/fail status not recorded"
                              >
                                Probed
                              </span>
                            )}
                            <span className="text-xs text-gray-500 whitespace-nowrap">
                              {formatDateTime(d.lastProbedAt)}
                            </span>
                          </div>
                          {d.lastProbeOk === false && d.lastProbeError && (
                            <div
                              className="text-xs text-red-700 mt-1 truncate"
                              title={d.lastProbeError}
                            >
                              {d.lastProbeError}
                            </div>
                          )}
                          {d.lastProbeNote && (
                            <div
                              className="text-xs text-gray-500 mt-0.5 truncate"
                              title={d.lastProbeNote}
                            >
                              {d.lastProbeNote}
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2 flex-wrap">
                        {RUN_NOW_PROVIDERS[providerLabel] && (
                          <button
                            onClick={() => {
                              if (providerLabel === "Tekmetric") {
                                runTekmetricNow(
                                  d.shopId,
                                  `Shop ${d.shopId}`,
                                );
                              } else {
                                runChunkNow(d.shopId, providerLabel);
                              }
                            }}
                            disabled={
                              isRunningNow ||
                              runningNow === d.shopId ||
                              triggering === d.shopId
                            }
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-100 text-blue-700 hover:bg-blue-200 rounded-lg disabled:opacity-50 whitespace-nowrap"
                            title={RUN_NOW_PROVIDERS[providerLabel].tooltip}
                          >
                            {isRunningNow || runningNow === d.shopId ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Play className="w-3.5 h-3.5" />
                            )}
                            {providerLabel === "Tekmetric" && isRunningNow
                              ? "Streaming…"
                              : "Run chunk now"}
                          </button>
                        )}
                        <button
                          onClick={() =>
                            triggerBackfill(d.shopId, providerLabel)
                          }
                          disabled={
                            triggering === d.shopId || isRunningNow
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
                  {runNow && (
                    <tr className="bg-blue-50/40">
                      <td colSpan={7} className="px-4 py-3">
                        {renderRunNowProgress(runNow)}
                      </td>
                    </tr>
                  )}
                  </Fragment>
                  );
                })}
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
                                    disabled={
                                      isResolving ||
                                      bulkResolvingShopId === s.shopId
                                    }
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
                        <div className="flex items-center justify-end gap-2 flex-wrap">
                          {isTekmetric && (
                            <button
                              onClick={() => retryShopRos(s.shopId)}
                              disabled={
                                retryingRo === s.shopId ||
                                retryingAllRo ||
                                bulkResolvingShopId === s.shopId ||
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
                          <button
                            onClick={() =>
                              resolveAllSkippedRos(
                                s.shopId,
                                (s.recentSkippedRos || []).map((r) => r.roId),
                              )
                            }
                            disabled={
                              bulkResolvingShopId === s.shopId ||
                              resolvingKey?.startsWith(`${s.shopId}:`) === true ||
                              (s.recentSkippedRos || []).length === 0
                            }
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs bg-emerald-100 text-emerald-700 hover:bg-emerald-200 rounded-lg disabled:opacity-50 whitespace-nowrap"
                            title="Archive every recently-skipped RO for this shop in one go. Use after a one-off re-fetch script has cleared the whole rolling window."
                          >
                            {bulkResolvingShopId === s.shopId ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <CheckCircle2 className="w-3.5 h-3.5" />
                            )}
                            Mark all resolved
                          </button>
                        </div>
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
    opts?: {
      // Provider-aware bulk warm controls. Defaults to the Tekmetric
      // handler so existing callers keep working unchanged.
      onBulkWarm?: (count: number) => void;
      bulkBusy?: boolean;
      bulkCapLabel?: string; // e.g. "500-RO cap" / "1000-RO cap"
      cacheCollectionLabel?: string; // e.g. "tekmetric_jobs_cache"
      stampFieldLabel?: string; // e.g. "shops.tekmetric.jobsCachePrewarm"
      // Whether per-row Re-warm buttons should be shown.
      perRowRewarm?: boolean;
      // Provider-aware per-row Re-warm callback. Defaults to the
      // Tekmetric handler so existing callers keep working unchanged.
      onRewarmShop?: (shopId: number, hasRecord: boolean) => void;
      // The shopId currently being re-warmed for this provider, used
      // to disable the row's button while the request is in flight.
      // Defaults to the Tekmetric `rewarmingShopId` state.
      rewarmingShopIdForProvider?: number | null;
      // Tooltip + endpoint label shown on the per-row Re-warm button.
      perRowRewarmTitle?: string;
    },
  ) => {
    const list = shops || [];
    const missing = missingCount ?? 0;
    const capped = cappedCount ?? 0;
    const errored = errorsCount ?? 0;
    const onBulkWarm = opts?.onBulkWarm ?? rewarmAllNeverWarmed;
    const bulkBusy = opts?.bulkBusy ?? rewarmingAll;
    const bulkCapLabel = opts?.bulkCapLabel ?? "500-RO cap";
    const cacheCollectionLabel =
      opts?.cacheCollectionLabel ?? "tekmetric_jobs_cache";
    const stampFieldLabel =
      opts?.stampFieldLabel ?? "shops.tekmetric.jobsCachePrewarm";
    const perRowRewarm = opts?.perRowRewarm ?? true;
    const onRewarmShop = opts?.onRewarmShop ?? rewarmJobsCache;
    const rewarmingShopIdForProvider =
      opts?.rewarmingShopIdForProvider ?? rewarmingShopId;
    const perRowRewarmTitle =
      opts?.perRowRewarmTitle ??
      "Re-run prewarmTekmetricJobsCacheForOnboarding for this shop. Idempotent — fresh cache rows are skipped.";
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
                title="Shops with no pre-warm record at all — likely onboarded before the pre-warm rolled out. Use Warm-all to one-shot them."
              >
                {missing} never warmed
              </span>
            )}
            {missing > 0 && (
              <button
                onClick={() => onBulkWarm(missing)}
                disabled={bulkBusy || rewarmingShopId !== null}
                className="inline-flex items-center gap-1.5 px-3 py-1 text-xs bg-orange-600 text-white hover:bg-orange-700 rounded-lg disabled:opacity-50 whitespace-nowrap"
                title={`Iterate every ${providerLabel} shop with no pre-warm record and run the per-shop pre-warm worker for each. Serial across shops; per-shop concurrency profile preserved.`}
              >
                {bulkBusy ? (
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
                title={`Pre-warm hit the ${bulkCapLabel}. The uncached tail will fill in opportunistically as the backfill walks back through history.`}
              >
                {capped} capped
              </span>
            )}
            {errored > 0 && (
              <span
                className="px-2 py-0.5 text-xs bg-rose-100 text-rose-800 rounded-full"
                title="Pre-warm logged at least one fetch/write failure for this shop"
              >
                {errored} with errors
              </span>
            )}
          </div>
          <p className="text-xs text-gray-500 hidden md:block max-w-md text-right">
            One-shot warm of <code className="px-1 bg-gray-100 rounded text-[11px]">{cacheCollectionLabel}</code>
            {" "}at onboarding. Stamped on
            {" "}<code className="px-1 bg-gray-100 rounded text-[11px]">{stampFieldLabel}</code>.
            Idempotent — re-warming is safe anytime.
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
                    title={
                      providerLabel === "Shop-Ware"
                        ? "Recent ROs upserted into shopware_repair_orders during pre-warm"
                        : "Recent terminal repair orders cached during pre-warm"
                    }
                  >
                    ROs cached
                  </th>
                  <th
                    className="text-right px-4 py-3 text-sm font-medium text-gray-600"
                    title={
                      providerLabel === "Shop-Ware"
                        ? "Total job_index rows written from terminal ROs during pre-warm"
                        : "Total /jobs entries written to tekmetric_jobs_cache"
                    }
                  >
                    Jobs cached
                  </th>
                  <th
                    className="text-right px-4 py-3 text-sm font-medium text-gray-600"
                    title={
                      providerLabel === "Shop-Ware"
                        ? "job_index rows whose contentHash matched, so they were skipped (treated as already cached)"
                        : "Terminal ROs already had a fresh cache row at warm time (skipped)"
                    }
                  >
                    Already cached
                  </th>
                  <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">
                    Errors
                  </th>
                  <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">
                    Duration
                  </th>
                  {perRowRewarm && (
                    <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">
                      Actions
                    </th>
                  )}
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
                                title={`Hit the ${bulkCapLabel} — uncached tail still warmed by the indexing path as the backfill progresses`}
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
                      {perRowRewarm && (
                        <td className="px-4 py-3 text-right">
                          <button
                            onClick={() =>
                              onRewarmShop(s.shopId, s.hasPrewarmRecord)
                            }
                            disabled={rewarmingShopIdForProvider === s.shopId}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs bg-orange-100 text-orange-700 hover:bg-orange-200 rounded-lg disabled:opacity-50 whitespace-nowrap"
                            title={perRowRewarmTitle}
                          >
                            {rewarmingShopIdForProvider === s.shopId ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Flame className="w-3.5 h-3.5" />
                            )}
                            {s.hasPrewarmRecord ? "Re-warm" : "Warm now"}
                          </button>
                        </td>
                      )}
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

  // Render of the Protractor invoice-cache pre-warm overlay. Mirrors
  // the Tekmetric/Shop-Ware one above, with column shape matching
  // Protractor's PrewarmProtractorJobsCacheResult: invoicesScanned /
  // alreadyCached / invoicesCached / errors / capped / durationMs. The
  // bulk "Warm all never-warmed" header button calls
  // `/api/platform-admin/protractor-rewarm-jobs-cache-all`; the per-row
  // Re-warm button calls
  // `/api/platform-admin/shops/[shopId]/protractor-rewarm-jobs-cache`
  // (task #110). The Protractor backfill also warms uncached invoices
  // opportunistically as it walks back through history (see
  // `invoicesFromCache` accounting in
  // lib/integrations/protractor-backfill.ts), so a re-warm here is a
  // self-service knob for on-call rather than the only path to a hot
  // cache.
  const renderProtractorInvoiceCachePrewarmSection = (
    shops: ProtractorInvoiceCachePrewarmShop[] | undefined,
    missingCount: number | undefined,
    cappedCount: number | undefined,
    errorsCount: number | undefined,
  ) => {
    const list = shops || [];
    const missing = missingCount ?? 0;
    const capped = cappedCount ?? 0;
    const errored = errorsCount ?? 0;
    const bulkBusy = rewarmingAllProtractor;
    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-100">
        <div className="p-4 border-b border-gray-100 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 flex-wrap">
            <Flame className="w-5 h-5 text-orange-600" />
            <h2 className="font-semibold text-gray-900">
              Invoice cache pre-warm (Protractor)
            </h2>
            <span className="px-2 py-0.5 text-xs bg-orange-100 text-orange-700 rounded-full">
              {list.length} shop{list.length === 1 ? "" : "s"}
            </span>
            {missing > 0 && (
              <span
                className="px-2 py-0.5 text-xs bg-amber-100 text-amber-800 rounded-full"
                title="Shops with no pre-warm record at all — likely onboarded before the Protractor invoice-cache pre-warm rolled out. The backfill will still warm them opportunistically."
              >
                {missing} never warmed
              </span>
            )}
            {missing > 0 && (
              <button
                onClick={() => rewarmAllNeverWarmedProtractor(missing)}
                disabled={bulkBusy || rewarmingProtractorShopId !== null}
                className="inline-flex items-center gap-1.5 px-3 py-1 text-xs bg-orange-600 text-white hover:bg-orange-700 rounded-lg disabled:opacity-50 whitespace-nowrap"
                title="Iterate every Protractor shop with no pre-warm record and run the per-shop pre-warm worker for each. Serial across shops; per-shop /Invoice/{id} concurrency cap=3 inside the worker."
              >
                {bulkBusy ? (
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
                title="Pre-warm hit the per-shop invoice cap. The uncached tail still fills in as the Protractor backfill walks back through history."
              >
                {capped} capped
              </span>
            )}
            {errored > 0 && (
              <span
                className="px-2 py-0.5 text-xs bg-rose-100 text-rose-800 rounded-full"
                title="Pre-warm logged at least one Protractor /invoice fetch failure for this shop"
              >
                {errored} with errors
              </span>
            )}
          </div>
          <p className="text-xs text-gray-500 hidden md:block max-w-md text-right">
            One-shot warm of <code className="px-1 bg-gray-100 rounded text-[11px]">protractor_invoice_cache</code>
            {" "}at onboarding. Stamped on
            {" "}<code className="px-1 bg-gray-100 rounded text-[11px]">shops.protractor.invoiceCachePrewarm</code>.
            Per-chunk hit-rate visible in the chunk-speed table&apos;s &quot;Jobs cache&quot; column.
          </p>
        </div>

        {list.length === 0 ? (
          <div className="p-8 flex items-center justify-center gap-2 text-gray-500">
            <Clock className="w-5 h-5 text-gray-400" />
            No Protractor backfill rows yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1000px]">
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
                    title="Total invoices the pre-warm fetched and inspected within the lookback window"
                  >
                    Invoices scanned
                  </th>
                  <th
                    className="text-right px-4 py-3 text-sm font-medium text-gray-600"
                    title="New invoice payloads written to protractor_invoice_cache"
                  >
                    Invoices cached
                  </th>
                  <th
                    className="text-right px-4 py-3 text-sm font-medium text-gray-600"
                    title="Invoices already had a fresh cache row at warm time (skipped)"
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
                            title="No invoiceCachePrewarm record on this shop. Probably onboarded before the pre-warm rolled out."
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
                                title="Hit the per-shop invoice cap — uncached tail still warmed by the indexing path as the backfill progresses"
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
                                title="Lookback window scanned for invoices"
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
                        {s.invoicesScanned == null
                          ? "—"
                          : s.invoicesScanned.toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-right text-sm text-gray-900">
                        {s.invoicesCached == null
                          ? "—"
                          : s.invoicesCached.toLocaleString()}
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
                            rewarmProtractorInvoiceCache(
                              s.shopId,
                              s.hasPrewarmRecord,
                            )
                          }
                          disabled={rewarmingProtractorShopId === s.shopId}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs bg-orange-100 text-orange-700 hover:bg-orange-200 rounded-lg disabled:opacity-50 whitespace-nowrap"
                          title="Re-run prewarmProtractorJobsCacheForOnboarding for this shop. Idempotent — fresh cache rows are skipped."
                        >
                          {rewarmingProtractorShopId === s.shopId ? (
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
            <table className="w-full min-w-[1380px]">
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
                  <th
                    className="text-left px-4 py-3 text-sm font-medium text-gray-600"
                    title="Whether the chunk-speed health cron has paged on-call about this shop. Present only while a dedup row exists in backfill_chunk_speed_alerts (clears the moment the shop recovers)."
                  >
                    Alerted
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
                      <td className="px-4 py-3 text-sm whitespace-nowrap">
                        {s.alert ? (
                          <span
                            className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-red-100 text-red-700 rounded-full"
                            title={
                              `Reasons: ${s.alert.reasons.join(", ") || "—"}` +
                              `\nFirst alerted: ${formatDateTime(s.alert.firstAlertedAt)}` +
                              `\nLast alerted: ${formatDateTime(s.alert.lastAlertedAt)}`
                            }
                          >
                            <AlertTriangle className="w-3 h-3" />
                            <span>
                              {s.alert.reasons.join(", ") || "alerted"}
                            </span>
                            <span className="text-red-600/70">
                              · since {formatDate(s.alert.firstAlertedAt)}
                            </span>
                          </span>
                        ) : (
                          <span className="text-xs text-gray-400">—</span>
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

  // Last few persisted Tekmetric catch-up runs (task #181). The script
  // `scripts/tekmetric-catchup.mjs` writes its end-of-run SUMMARY block
  // (totals + bucketed shop ids + filters used + suggested re-run
  // command) into `tekmetric_catchup_runs` after each invocation; this
  // section renders the most-recent few so on-call doesn't have to grep
  // a multi-hour log to remember what the last run covered.
  const renderCatchupRunsSection = (runs: CatchupRun[] | undefined) => {
    const list = runs || [];
    const newest = list[0] || null;
    const newestStillNeedsFollowup = newest && newest.totals.needsFollowup > 0;
    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-100">
        <div className="p-4 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock className="w-5 h-5 text-indigo-600" />
            <h2 className="font-semibold text-gray-900">
              Tekmetric catch-up runs
            </h2>
            <a
              href="/platform-admin/runbooks/tekmetric-catchup"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-2 py-0.5 text-xs text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 rounded-full"
              title="Open the paste-ready procedure for firing this catch-up from a prod Render Shell"
            >
              <BookOpen className="w-3 h-3" />
              How to run this
            </a>
            <span className="px-2 py-0.5 text-xs bg-indigo-100 text-indigo-800 rounded-full">
              last {list.length} run{list.length === 1 ? "" : "s"}
            </span>
            {newestStillNeedsFollowup && (
              <span className="px-2 py-0.5 text-xs bg-amber-100 text-amber-800 rounded-full">
                {newest!.totals.needsFollowup} shop{newest!.totals.needsFollowup === 1 ? "" : "s"} need follow-up
              </span>
            )}
          </div>
          <p className="text-xs text-gray-500">
            Persisted SUMMARY blocks from{" "}
            <code className="font-mono">scripts/tekmetric-catchup.mjs</code>.
          </p>
        </div>

        {list.length === 0 ? (
          <div className="p-8 flex flex-col items-center justify-center gap-2 text-gray-500 text-center">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-gray-400" />
              No catch-up runs recorded yet.
            </div>
            <p className="text-xs text-gray-500 max-w-md">
              First time firing a catch-up?{" "}
              <a
                href="/platform-admin/runbooks/tekmetric-catchup"
                target="_blank"
                rel="noopener noreferrer"
                className="text-indigo-600 hover:text-indigo-800 underline"
              >
                Read the runbook
              </a>{" "}
              for the paste-ready procedure to run it from a prod Render Shell.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {list.map((run, idx) => {
              const headerKey = `${run.startedAt || "unknown"}-${idx}`;
              const isLatest = idx === 0;
              return (
                <div key={headerKey} className="p-4 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    {isLatest && (
                      <span className="px-2 py-0.5 text-xs bg-indigo-100 text-indigo-800 rounded-full">
                        Latest
                      </span>
                    )}
                    <span className="text-sm font-medium text-gray-900">
                      {formatDateTime(run.startedAt)}
                    </span>
                    <span className="text-xs text-gray-500">
                      → {formatDateTime(run.finishedAt)}
                    </span>
                    {run.durationMs != null && (
                      <span className="text-xs text-gray-500">
                        ({formatDuration(run.durationMs)})
                      </span>
                    )}
                    {run.dryRun && (
                      <span className="px-2 py-0.5 text-xs bg-gray-100 text-gray-700 rounded-full">
                        DRY_RUN
                      </span>
                    )}
                    {run.prodBaseUrl && (
                      <span className="text-xs text-gray-400 font-mono">
                        {run.prodBaseUrl}
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-2 text-xs">
                    <span className="px-2 py-0.5 bg-gray-100 text-gray-700 rounded-full">
                      processed {run.totals.processed}
                    </span>
                    <span className="px-2 py-0.5 bg-green-100 text-green-700 rounded-full">
                      completed {run.totals.completed}
                    </span>
                    <span className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full">
                      recovered {run.totals.recovered}
                    </span>
                    <span
                      className={
                        "px-2 py-0.5 rounded-full " +
                        (run.totals.needsFollowup > 0
                          ? "bg-amber-100 text-amber-800"
                          : "bg-gray-100 text-gray-500")
                      }
                    >
                      needs follow-up {run.totals.needsFollowup}
                    </span>
                    {run.dryRun && (
                      <span className="px-2 py-0.5 bg-gray-100 text-gray-700 rounded-full">
                        dry-run {run.totals.dryRun}
                      </span>
                    )}
                  </div>

                  {(run.filters.onlyShops.length > 0 ||
                    run.filters.skipShops.length > 0) && (
                    <div className="text-xs text-gray-600 space-x-3">
                      {run.filters.onlyShops.length > 0 && (
                        <span>
                          ONLY_SHOPS:{" "}
                          <code className="font-mono">
                            {run.filters.onlyShops.join(",")}
                          </code>
                        </span>
                      )}
                      {run.filters.skipShops.length > 0 && (
                        <span>
                          SKIP_SHOPS:{" "}
                          <code className="font-mono">
                            {run.filters.skipShops.join(",")}
                          </code>
                        </span>
                      )}
                    </div>
                  )}

                  {run.completedShopIds.length > 0 && (
                    <div className="text-xs text-gray-700">
                      <span className="font-medium">Completed:</span>{" "}
                      <code className="font-mono">
                        {run.completedShopIds.join(", ")}
                      </code>
                    </div>
                  )}
                  {run.recoveredShopIds.length > 0 && (
                    <div className="text-xs text-gray-700">
                      <span className="font-medium">Recovered:</span>{" "}
                      <code className="font-mono">
                        {run.recoveredShopIds.join(", ")}
                      </code>
                    </div>
                  )}

                  {run.needsFollowup.length > 0 && (
                    <div className="text-xs">
                      <div className="font-medium text-amber-800 mb-1">
                        Needs follow-up:
                      </div>
                      <ul className="ml-4 list-disc text-gray-700 space-y-0.5">
                        {run.needsFollowup.map((n) => (
                          <li key={n.shopId}>
                            shop <code className="font-mono">{n.shopId}</code>
                            {n.reason ? <> — {n.reason}</> : null}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {run.suggestedRerunCommand && (
                    <div className="text-xs">
                      <div className="font-medium text-gray-700 mb-1">
                        Suggested re-run:
                      </div>
                      <code className="block font-mono px-2 py-1 bg-gray-50 border border-gray-100 rounded text-gray-800 break-all">
                        {run.suggestedRerunCommand}
                      </code>
                    </div>
                  )}
                </div>
              );
            })}
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

        <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-orange-100 rounded-lg">
              <Flame className="w-5 h-5 text-orange-600" />
            </div>
            <span className="text-sm text-gray-600">Invoice cache pre-warm (Pro)</span>
          </div>
          <div className="text-2xl font-bold text-gray-900">
            {(pro?.invoiceCachePrewarmShopCount ?? 0) -
              (pro?.invoiceCachePrewarmMissingCount ?? 0)}
            {" / "}
            {pro?.invoiceCachePrewarmShopCount ?? 0}
          </div>
          <div className="text-xs text-gray-500 mt-1">
            warmed shops · {pro?.invoiceCachePrewarmMissingCount ?? 0} never warmed
            {(pro?.invoiceCachePrewarmCappedCount ?? 0) > 0 &&
              ` · ${pro?.invoiceCachePrewarmCappedCount} capped`}
          </div>
        </div>

        <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-orange-100 rounded-lg">
              <Flame className="w-5 h-5 text-orange-600" />
            </div>
            <span className="text-sm text-gray-600">Jobs cache pre-warm (SW)</span>
          </div>
          <div className="text-2xl font-bold text-gray-900">
            {(sw?.jobsCachePrewarmShopCount ?? 0) -
              (sw?.jobsCachePrewarmMissingCount ?? 0)}
            {" / "}
            {sw?.jobsCachePrewarmShopCount ?? 0}
          </div>
          <div className="text-xs text-gray-500 mt-1">
            warmed shops · {sw?.jobsCachePrewarmMissingCount ?? 0} never warmed
            {(sw?.jobsCachePrewarmCappedCount ?? 0) > 0 &&
              ` · ${sw?.jobsCachePrewarmCappedCount} capped`}
          </div>
        </div>
      </div>

      {renderCatchupRunsSection(tek?.catchupRuns)}

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

      {renderProtractorInvoiceCachePrewarmSection(
        pro?.invoiceCachePrewarm,
        pro?.invoiceCachePrewarmMissingCount,
        pro?.invoiceCachePrewarmCappedCount,
        pro?.invoiceCachePrewarmErrorsCount,
      )}

      {renderJobsCachePrewarmSection(
        "Shop-Ware",
        sw?.jobsCachePrewarm,
        sw?.jobsCachePrewarmMissingCount,
        sw?.jobsCachePrewarmCappedCount,
        sw?.jobsCachePrewarmErrorsCount,
        {
          onBulkWarm: rewarmAllNeverWarmedShopWare,
          bulkBusy: rewarmingAllShopWare,
          bulkCapLabel: "1000-RO cap",
          cacheCollectionLabel: "shopware_repair_orders + job_index",
          stampFieldLabel: "shops.shopware.jobsCachePrewarm",
          // Per-shop Shop-Ware rewarm endpoint shipped with task #110:
          // POST /api/platform-admin/shops/[shopId]/shopware-rewarm-jobs-cache
          perRowRewarm: true,
          onRewarmShop: rewarmShopWareJobsCache,
          rewarmingShopIdForProvider: rewarmingShopWareShopId,
          perRowRewarmTitle:
            "Re-run prewarmShopWareJobsCacheForOnboarding for this shop. Idempotent — matching contentHash rows are skipped.",
        },
      )}

      {renderStuckSection("Tekmetric", tek?.diagnostics)}
      {renderStuckSection("Protractor", pro?.diagnostics)}
      {renderStuckSection("Shop-Ware", sw?.diagnostics)}
    </div>
  );
}
