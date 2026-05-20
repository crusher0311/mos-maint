"use client";

import { useEffect, useState } from "react";

type Summary = {
  count: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
};

type ProviderRow = {
  provider: string;
  chunks: number;
  okChunks: number;
  errorChunks: number;
  duration: Summary;
  rosPerChunk: Summary;
  mongoWritesPerChunk: Summary;
  pgWritesPerChunk: Summary;
  backoffMs: Summary;
  rateLimiterWaitsMs: Summary;
  rateLimiterTimeoutsTotal: number;
  rateLimiterFallbacksTotal: number;
  retriesTotal: number;
};

type Payload = {
  windowMin: number;
  since: string;
  providers: ProviderRow[];
  concurrency: { sampleSize: number; peakConcurrent: number; avgConcurrent: number };
  hostLoad: {
    samples: number;
    latest: any;
    cpuPercent: Summary;
    eventLoopLagMsP95: Summary;
    rssBytes: Summary;
    pgActive: Summary;
  };
  recentChunks: any[];
  recentHostSamples: any[];
};

function ms(n: number | null) {
  if (n == null) return "—";
  return `${Math.round(n).toLocaleString()} ms`;
}
function num(n: number | null) {
  if (n == null) return "—";
  return Number(n).toLocaleString();
}
function bytes(n: number | null) {
  if (n == null) return "—";
  return `${(n / 1024 / 1024).toFixed(0)} MB`;
}

export default function BackfillLoadPage() {
  const [windowMin, setWindowMin] = useState(120);
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cofiring, setCofiring] = useState(false);
  const [cofireResult, setCofireResult] = useState<any>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/backfill-load?windowMin=${windowMin}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as Payload;
      setData(json);
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [windowMin]);

  async function fireCofire(override: boolean) {
    if (
      !confirm(
        override
          ? "Manually fire Tekmetric + Protractor + Shop-Ware backfill in parallel (override)?"
          : "Fire Tekmetric + Protractor + Shop-Ware backfill in parallel via BACKFILL_COFIRE_STRESS env flag?",
      )
    )
      return;
    setCofiring(true);
    setCofireResult(null);
    try {
      const res = await fetch("/api/admin/backfill-cofire", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(override ? { override: true } : {}),
      });
      const json = await res.json();
      setCofireResult({ status: res.status, body: json });
      load();
    } catch (e: any) {
      setCofireResult({ error: e.message || String(e) });
    } finally {
      setCofiring(false);
    }
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Backfill Load</h1>
          <p className="mt-1 text-sm text-gray-500">
            Chunk wall-clock, write fan-out, host load. Auto-refreshes every 30s.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-600">Window (min):</label>
          <select
            value={windowMin}
            onChange={(e) => setWindowMin(Number(e.target.value))}
            className="border rounded px-2 py-1 text-sm"
          >
            <option value={30}>30</option>
            <option value={60}>60</option>
            <option value={120}>120</option>
            <option value={360}>360</option>
            <option value={1440}>1440 (24h)</option>
            <option value={4320}>4320 (3d)</option>
            <option value={10080}>10080 (7d)</option>
          </select>
          <button
            onClick={load}
            className="px-3 py-1 text-sm bg-gray-100 hover:bg-gray-200 rounded"
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded p-3 text-sm">
          {error}
        </div>
      )}

      <div className="bg-white shadow rounded-lg p-4">
        <h2 className="text-lg font-semibold mb-2">Co-fire Stress Trigger</h2>
        <p className="text-sm text-gray-600 mb-3">
          Fires Tekmetric + Protractor + Shop-Ware cron routes in parallel so
          combined peak load can be measured. Requires{" "}
          <code className="text-xs bg-gray-100 px-1">BACKFILL_COFIRE_STRESS=true</code>{" "}
          or an explicit manual override.
        </p>
        <div className="flex gap-2">
          <button
            disabled={cofiring}
            onClick={() => fireCofire(false)}
            className="px-3 py-2 bg-blue-600 text-white rounded text-sm disabled:opacity-50"
          >
            Fire (env-gated)
          </button>
          <button
            disabled={cofiring}
            onClick={() => fireCofire(true)}
            className="px-3 py-2 bg-amber-600 text-white rounded text-sm disabled:opacity-50"
          >
            Fire (manual override)
          </button>
        </div>
        {cofireResult && (
          <pre className="mt-3 text-xs bg-gray-50 border rounded p-2 overflow-auto max-h-64">
            {JSON.stringify(cofireResult, null, 2)}
          </pre>
        )}
      </div>

      {data && (
        <>
          <div className="bg-white shadow rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b bg-gray-50">
              <h2 className="text-lg font-semibold">Per-Provider Chunk Metrics</h2>
              <p className="text-xs text-gray-500">
                Window: last {data.windowMin}m · since {new Date(data.since).toLocaleString()}
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-gray-600">
                  <tr>
                    <th className="px-3 py-2 text-left">Provider</th>
                    <th className="px-3 py-2 text-right">Chunks (ok/err)</th>
                    <th className="px-3 py-2 text-right">Duration p50 / p95 / p99 / max</th>
                    <th className="px-3 py-2 text-right">ROs p95</th>
                    <th className="px-3 py-2 text-right">Mongo writes p95</th>
                    <th className="px-3 py-2 text-right">PG writes p95</th>
                    <th className="px-3 py-2 text-right">Backoff p95</th>
                    <th className="px-3 py-2 text-right">RL wait p95</th>
                    <th className="px-3 py-2 text-right">RL timeouts / fallbacks / retries</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {data.providers.map((p) => (
                    <tr key={p.provider}>
                      <td className="px-3 py-2 font-mono text-xs">{p.provider}</td>
                      <td className="px-3 py-2 text-right">
                        {p.chunks} ({p.okChunks}/{p.errorChunks})
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs">
                        {ms(p.duration.p50)} / {ms(p.duration.p95)} / {ms(p.duration.p99)} /{" "}
                        {ms(p.duration.max)}
                      </td>
                      <td className="px-3 py-2 text-right">{num(p.rosPerChunk.p95)}</td>
                      <td className="px-3 py-2 text-right">{num(p.mongoWritesPerChunk.p95)}</td>
                      <td className="px-3 py-2 text-right">{num(p.pgWritesPerChunk.p95)}</td>
                      <td className="px-3 py-2 text-right">{ms(p.backoffMs.p95)}</td>
                      <td className="px-3 py-2 text-right">{ms(p.rateLimiterWaitsMs.p95)}</td>
                      <td className="px-3 py-2 text-right text-xs">
                        {p.rateLimiterTimeoutsTotal} / {p.rateLimiterFallbacksTotal} /{" "}
                        {p.retriesTotal}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-white shadow rounded-lg p-4">
              <h2 className="text-lg font-semibold mb-2">Concurrency</h2>
              <dl className="text-sm space-y-1">
                <div className="flex justify-between">
                  <dt className="text-gray-600">Chunks sampled</dt>
                  <dd className="font-mono">{data.concurrency.sampleSize}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-600">Peak concurrent chunks</dt>
                  <dd className="font-mono">{data.concurrency.peakConcurrent}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-600">Avg concurrent (per chunk midpoint)</dt>
                  <dd className="font-mono">{data.concurrency.avgConcurrent}</dd>
                </div>
              </dl>
            </div>
            <div className="bg-white shadow rounded-lg p-4">
              <h2 className="text-lg font-semibold mb-2">Host Load (window)</h2>
              <dl className="text-sm space-y-1">
                <div className="flex justify-between">
                  <dt className="text-gray-600">Samples</dt>
                  <dd className="font-mono">{data.hostLoad.samples}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-600">CPU% p50 / p95 / max</dt>
                  <dd className="font-mono">
                    {data.hostLoad.cpuPercent.p50?.toFixed?.(1) ?? "—"} /{" "}
                    {data.hostLoad.cpuPercent.p95?.toFixed?.(1) ?? "—"} /{" "}
                    {data.hostLoad.cpuPercent.max?.toFixed?.(1) ?? "—"}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-600">Event-loop p95 lag p50 / p95 / max</dt>
                  <dd className="font-mono">
                    {ms(data.hostLoad.eventLoopLagMsP95.p50)} /{" "}
                    {ms(data.hostLoad.eventLoopLagMsP95.p95)} /{" "}
                    {ms(data.hostLoad.eventLoopLagMsP95.max)}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-600">RSS p50 / p95 / max</dt>
                  <dd className="font-mono">
                    {bytes(data.hostLoad.rssBytes.p50)} /{" "}
                    {bytes(data.hostLoad.rssBytes.p95)} /{" "}
                    {bytes(data.hostLoad.rssBytes.max)}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-600">PG active conns p50 / p95 / max</dt>
                  <dd className="font-mono">
                    {num(data.hostLoad.pgActive.p50)} / {num(data.hostLoad.pgActive.p95)} /{" "}
                    {num(data.hostLoad.pgActive.max)}
                  </dd>
                </div>
              </dl>
              {data.hostLoad.latest && (
                <details className="mt-2 text-xs">
                  <summary className="cursor-pointer text-gray-600">
                    Latest sample ({new Date(data.hostLoad.latest.sampledAt).toLocaleString()})
                  </summary>
                  <pre className="mt-2 bg-gray-50 border rounded p-2 overflow-auto max-h-64">
                    {JSON.stringify(data.hostLoad.latest, null, 2)}
                  </pre>
                </details>
              )}
            </div>
          </div>

          <div className="bg-white shadow rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b bg-gray-50">
              <h2 className="text-lg font-semibold">Recent Chunks (last 50)</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead className="bg-gray-50 text-gray-600">
                  <tr>
                    <th className="px-3 py-2 text-left">Ended</th>
                    <th className="px-3 py-2 text-left">Provider</th>
                    <th className="px-3 py-2 text-right">Shop</th>
                    <th className="px-3 py-2 text-right">Duration</th>
                    <th className="px-3 py-2 text-right">ROs</th>
                    <th className="px-3 py-2 text-right">Mongo</th>
                    <th className="px-3 py-2 text-right">PG</th>
                    <th className="px-3 py-2 text-right">Backoff</th>
                    <th className="px-3 py-2 text-left">Outcome</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {data.recentChunks.map((c: any, i: number) => (
                    <tr key={i}>
                      <td className="px-3 py-1 font-mono">
                        {new Date(c.chunkEndedAt).toLocaleTimeString()}
                      </td>
                      <td className="px-3 py-1 font-mono">{c.provider}</td>
                      <td className="px-3 py-1 text-right font-mono">{c.shopId}</td>
                      <td className="px-3 py-1 text-right font-mono">{ms(c.durationMs)}</td>
                      <td className="px-3 py-1 text-right">{num(c.rosProcessed ?? null)}</td>
                      <td className="px-3 py-1 text-right">{num(c.writes?.mongoWrites ?? null)}</td>
                      <td className="px-3 py-1 text-right">{num(c.writes?.pgWrites ?? null)}</td>
                      <td className="px-3 py-1 text-right">{ms(c.backoffMs ?? null)}</td>
                      <td className="px-3 py-1">{c.outcome}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
