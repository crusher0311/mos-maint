"use client";

import { useEffect, useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, Clock, RefreshCw } from "lucide-react";

/**
 * UI consumer for the Tekmetric webhook subscription/latency status route.
 *
 * Renders three blocks the on-call needs at a glance:
 *   1. A counts strip — healthy / stale / silent shops.
 *   2. The new (task #376) latency block: 24h + 7d p50/p95/p99 over
 *      `handlerDurationMs`, with a soft warning state when p95 crosses
 *      the same 3000ms threshold the `tekmetric-webhook-health` cron
 *      alerts on. The route returns null percentiles when no samples
 *      exist yet (older log rows lack the field) — this UI renders "—"
 *      and surfaces the route's `latency.note` so it's clear nothing's
 *      broken, just empty.
 *   3. The polling safety net: lastRunAt / lastSuccessAt /
 *      lastDurationMs for the `tekmetric-incremental-sync` cron, with a
 *      warning state when the last successful run is more than an hour
 *      old (the cron schedule is "every 30 min", so >1h means it's missed at
 *      least one tick).
 *
 * Data source: `GET /api/platform-admin/tekmetric/webhook-subscription-status`.
 * Reuses the auth gate that route already enforces — a non-admin will
 * get a 401 from the fetch and see the error state.
 */

type Percentiles = {
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  count: number;
};

type ShopRow = {
  tekmetricShopId: number;
  mosShopId: any;
  name: string;
  healthStatus: "healthy" | "stale" | "silent";
  subscriptionStatus: "subscribed" | "error" | "missing";
  totalLast24h: number;
  totalLast7d: number;
  totalLast30d: number;
  lastEventAt: string | null;
  eventTypeBreakdown: Array<{
    eventType: string;
    count: number;
    last24h: number;
    last7d: number;
    lastSeen: string;
  }>;
  autoSubscribe: any;
};

type StatusResponse = {
  counts: { healthy: number; stale: number; silent: number; total: number };
  subscriptionCounts?: {
    subscribed: number;
    error: number;
    missing: number;
    total: number;
  };
  autoSubscribeEnabled?: boolean;
  summary: ShopRow[];
  latency: {
    last24h: Percentiles;
    last7d: Percentiles;
    note: string | null;
  };
  incrementalSync: {
    lastRunAt: string | null;
    lastSuccessAt: string | null;
    lastDurationMs: number | null;
    schedule: string;
  };
  note: string;
};

const LATENCY_WARN_MS = 3000;
const SYNC_WARN_AGE_MS = 60 * 60 * 1000;

function fmtMs(value: number | null): string {
  if (value === null || value === undefined) return "—";
  if (value >= 1000) return `${(value / 1000).toFixed(2)}s`;
  return `${value}ms`;
}

function fmtRelative(iso: string | null): { label: string; ageMs: number | null } {
  if (!iso) return { label: "never", ageMs: null };
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return { label: iso, ageMs: null };
  const ageMs = Date.now() - ts;
  if (ageMs < 60_000) return { label: `${Math.floor(ageMs / 1000)}s ago`, ageMs };
  if (ageMs < 60 * 60_000) return { label: `${Math.floor(ageMs / 60_000)}m ago`, ageMs };
  if (ageMs < 24 * 60 * 60_000)
    return { label: `${Math.floor(ageMs / (60 * 60_000))}h ago`, ageMs };
  return { label: `${Math.floor(ageMs / (24 * 60 * 60_000))}d ago`, ageMs };
}

function LatencyCell({
  label,
  pct,
  warn,
}: {
  label: string;
  pct: Percentiles;
  warn: boolean;
}) {
  const baseClass = warn
    ? "border-amber-300 bg-amber-50"
    : "border-gray-200 bg-white";
  return (
    <div className={`rounded-lg border p-4 ${baseClass}`}>
      <div className="text-xs uppercase tracking-wide text-gray-500 mb-2">
        {label}
        {warn ? (
          <span className="ml-2 text-amber-700 font-semibold">
            ⚠ p95 over {LATENCY_WARN_MS}ms
          </span>
        ) : null}
      </div>
      <div className="grid grid-cols-4 gap-3 text-sm">
        <div>
          <div className="text-gray-500">p50</div>
          <div className="font-mono text-base">{fmtMs(pct.p50)}</div>
        </div>
        <div>
          <div className="text-gray-500">p95</div>
          <div className={`font-mono text-base ${warn ? "text-amber-700 font-semibold" : ""}`}>
            {fmtMs(pct.p95)}
          </div>
        </div>
        <div>
          <div className="text-gray-500">p99</div>
          <div className="font-mono text-base">{fmtMs(pct.p99)}</div>
        </div>
        <div>
          <div className="text-gray-500">max</div>
          <div className="font-mono text-base">{fmtMs(pct.max)}</div>
        </div>
      </div>
      <div className="text-xs text-gray-400 mt-2">n = {pct.count.toLocaleString()}</div>
    </div>
  );
}

export default function TekmetricWebhookHealthPage() {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        "/api/platform-admin/tekmetric/webhook-subscription-status",
      );
      if (!res.ok) {
        setError(`Request failed: ${res.status} ${res.statusText}`);
        setData(null);
        return;
      }
      const body = (await res.json()) as StatusResponse;
      setData(body);
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const p95_24h = data?.latency?.last24h?.p95 ?? null;
  const p95_7d = data?.latency?.last7d?.p95 ?? null;
  const latencyWarn24h = p95_24h !== null && p95_24h > LATENCY_WARN_MS;
  const latencyWarn7d = p95_7d !== null && p95_7d > LATENCY_WARN_MS;

  const lastSuccessRel = fmtRelative(data?.incrementalSync?.lastSuccessAt ?? null);
  const lastRunRel = fmtRelative(data?.incrementalSync?.lastRunAt ?? null);
  const syncWarn =
    lastSuccessRel.ageMs !== null && lastSuccessRel.ageMs > SYNC_WARN_AGE_MS;

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            Tekmetric Webhook Health
          </h1>
          <p className="text-gray-600">
            Per-shop event delivery, handler latency, and the polling safety
            net at a glance. Pairs with the daily{" "}
            <code className="font-mono text-xs bg-gray-100 px-1 rounded">
              tekmetric-webhook-health
            </code>{" "}
            cron alerter.
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50 disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-800">
          {error}
        </div>
      ) : null}

      {/* Counts strip */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <div className="text-sm text-gray-500">Total Tekmetric shops</div>
          <div className="text-2xl font-bold mt-1">
            {data?.counts.total ?? "—"}
          </div>
        </div>
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5">
          <div className="text-sm text-emerald-700 flex items-center gap-1">
            <CheckCircle2 className="w-4 h-4" /> Healthy (24h)
          </div>
          <div className="text-2xl font-bold mt-1 text-emerald-700">
            {data?.counts.healthy ?? "—"}
          </div>
        </div>
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-5">
          <div className="text-sm text-amber-700 flex items-center gap-1">
            <AlertTriangle className="w-4 h-4" /> Stale (7d only)
          </div>
          <div className="text-2xl font-bold mt-1 text-amber-700">
            {data?.counts.stale ?? "—"}
          </div>
        </div>
        <div className="rounded-xl border border-red-200 bg-red-50 p-5">
          <div className="text-sm text-red-700 flex items-center gap-1">
            <AlertTriangle className="w-4 h-4" /> Silent (no 7d)
          </div>
          <div className="text-2xl font-bold mt-1 text-red-700">
            {data?.counts.silent ?? "—"}
          </div>
        </div>
      </div>

      {/* Subscription health strip (task #569) */}
      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="flex items-center gap-2 mb-3">
          <CheckCircle2 className="w-4 h-4 text-gray-500" />
          <h2 className="text-lg font-semibold">Webhook subscriptions</h2>
        </div>
        <p className="text-sm text-gray-600 mb-4">
          Whether each shop has a managed Tekmetric webhook subscription on
          record. Onboarding auto-subscribes new shops and the daily{" "}
          <code className="font-mono">webhook-subscription-sweep</code> cron
          repairs existing ones.{" "}
          {data?.autoSubscribeEnabled === false ? (
            <span className="text-amber-700">
              Auto-subscribe is currently <strong>off</strong>{" "}
              (<code className="font-mono">TEKMETRIC_WEBHOOK_AUTO_SUBSCRIBE</code>{" "}
              not set), so <strong>missing</strong> just means
              &ldquo;never wired up&rdquo; — not an alarm.
            </span>
          ) : (
            <span className="text-emerald-700">
              Auto-subscribe is <strong>on</strong>; persistent
              &ldquo;missing&rdquo; rows mean auto-subscribe is failing.
            </span>
          )}
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
            <div className="text-sm text-emerald-700">Subscribed</div>
            <div className="text-2xl font-bold mt-1 text-emerald-700">
              {data?.subscriptionCounts?.subscribed ?? "—"}
            </div>
          </div>
          <div className="rounded-lg border border-red-200 bg-red-50 p-4">
            <div className="text-sm text-red-700">Error</div>
            <div className="text-2xl font-bold mt-1 text-red-700">
              {data?.subscriptionCounts?.error ?? "—"}
            </div>
          </div>
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
            <div className="text-sm text-gray-600">Missing</div>
            <div className="text-2xl font-bold mt-1 text-gray-700">
              {data?.subscriptionCounts?.missing ?? "—"}
            </div>
          </div>
        </div>
      </section>

      {/* Latency block */}
      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="flex items-center gap-2 mb-3">
          <Activity className="w-4 h-4 text-gray-500" />
          <h2 className="text-lg font-semibold">Handler latency</h2>
        </div>
        <p className="text-sm text-gray-600 mb-4">
          Wall-clock the inline webhook handler took before returning 200 OK
          to Tekmetric, persisted as <code className="font-mono">handlerDurationMs</code>
          {" "}on every <code className="font-mono">tekmetric_webhook_logs</code> row.
          The alerter pages when 1h p95 exceeds {LATENCY_WARN_MS}ms.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <LatencyCell
            label="Last 24h"
            pct={data?.latency.last24h ?? { p50: null, p95: null, p99: null, max: null, count: 0 }}
            warn={latencyWarn24h}
          />
          <LatencyCell
            label="Last 7 days"
            pct={data?.latency.last7d ?? { p50: null, p95: null, p99: null, max: null, count: 0 }}
            warn={latencyWarn7d}
          />
        </div>
        {data?.latency.note ? (
          <p className="text-xs text-gray-500 mt-3 italic">{data.latency.note}</p>
        ) : null}
      </section>

      {/* Polling safety net */}
      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="flex items-center gap-2 mb-3">
          <Clock className="w-4 h-4 text-gray-500" />
          <h2 className="text-lg font-semibold">Polling safety net</h2>
        </div>
        <p className="text-sm text-gray-600 mb-4">
          The <code className="font-mono">tekmetric-incremental-sync</code> cron
          runs on{" "}
          <code className="font-mono">{data?.incrementalSync.schedule || "—"}</code>{" "}
          and reconciles anything the webhooks missed. If the last successful
          run is over an hour old, the safety net is also down.
        </p>
        <div className={`grid grid-cols-1 md:grid-cols-3 gap-4 ${syncWarn ? "" : ""}`}>
          <div className={`rounded-lg border p-4 ${syncWarn ? "border-amber-300 bg-amber-50" : "border-gray-200 bg-white"}`}>
            <div className="text-xs uppercase tracking-wide text-gray-500">
              Last successful run
            </div>
            <div className={`text-base font-mono mt-1 ${syncWarn ? "text-amber-700 font-semibold" : ""}`}>
              {lastSuccessRel.label}
            </div>
            {data?.incrementalSync.lastSuccessAt ? (
              <div className="text-xs text-gray-400 mt-1">
                {data.incrementalSync.lastSuccessAt}
              </div>
            ) : null}
          </div>
          <div className="rounded-lg border border-gray-200 bg-white p-4">
            <div className="text-xs uppercase tracking-wide text-gray-500">
              Last run (any status)
            </div>
            <div className="text-base font-mono mt-1">{lastRunRel.label}</div>
            {data?.incrementalSync.lastRunAt ? (
              <div className="text-xs text-gray-400 mt-1">
                {data.incrementalSync.lastRunAt}
              </div>
            ) : null}
          </div>
          <div className="rounded-lg border border-gray-200 bg-white p-4">
            <div className="text-xs uppercase tracking-wide text-gray-500">
              Last duration
            </div>
            <div className="text-base font-mono mt-1">
              {fmtMs(data?.incrementalSync.lastDurationMs ?? null)}
            </div>
          </div>
        </div>
      </section>

      {/* Per-shop breakdown */}
      <section className="rounded-xl border border-gray-200 bg-white">
        <div className="px-5 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold">Per-shop receipt activity</h2>
          <p className="text-sm text-gray-600 mt-1">
            Sorted silent → stale → healthy so problems surface at the top.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2 text-left">Shop</th>
                <th className="px-4 py-2 text-left">Tek ID</th>
                <th className="px-4 py-2 text-left">Status</th>
                <th className="px-4 py-2 text-left">Subscription</th>
                <th className="px-4 py-2 text-right">24h</th>
                <th className="px-4 py-2 text-right">7d</th>
                <th className="px-4 py-2 text-right">30d</th>
                <th className="px-4 py-2 text-left">Last event</th>
              </tr>
            </thead>
            <tbody>
              {(data?.summary || []).map((row) => {
                const badge =
                  row.healthStatus === "silent"
                    ? "bg-red-100 text-red-700"
                    : row.healthStatus === "stale"
                    ? "bg-amber-100 text-amber-700"
                    : "bg-emerald-100 text-emerald-700";
                const subBadge =
                  row.subscriptionStatus === "subscribed"
                    ? "bg-emerald-100 text-emerald-700"
                    : row.subscriptionStatus === "error"
                    ? "bg-red-100 text-red-700"
                    : "bg-gray-100 text-gray-600";
                return (
                  <tr key={row.tekmetricShopId} className="border-t border-gray-100">
                    <td className="px-4 py-2">{row.name}</td>
                    <td className="px-4 py-2 font-mono text-xs text-gray-600">
                      {row.tekmetricShopId}
                    </td>
                    <td className="px-4 py-2">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${badge}`}>
                        {row.healthStatus}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${subBadge}`}>
                        {row.subscriptionStatus}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right font-mono">{row.totalLast24h}</td>
                    <td className="px-4 py-2 text-right font-mono">{row.totalLast7d}</td>
                    <td className="px-4 py-2 text-right font-mono">{row.totalLast30d}</td>
                    <td className="px-4 py-2 text-gray-600">
                      {fmtRelative(row.lastEventAt).label}
                    </td>
                  </tr>
                );
              })}
              {!loading && (data?.summary?.length ?? 0) === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-gray-500">
                    No Tekmetric-connected shops found.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <p className="text-xs text-gray-400">
        See <code className="font-mono">TEKMETRIC_5K_SCALING_PLAN.md</code> step
        3 for the design behind these alerts.
      </p>
    </div>
  );
}
