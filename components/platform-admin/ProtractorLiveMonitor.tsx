"use client";

import { useCallback, useEffect, useState } from "react";
import type { ProtractorLiveMonitor as Monitor } from "@/lib/data/repositories/protractor-live-monitor";

const ENDPOINT = "/api/platform-admin/protractor-live-monitor";
const POLL_MS = 15_000;
const STALE_CLIENT_MS = POLL_MS * 3;

function formatAge(milliseconds: number | null): string {
  if (milliseconds == null) return "—";
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function QueueMetrics({ title, value }: { title: string; value: Monitor["callbacks"]["heldBacklog"] }) {
  return (
    <div className="rounded border border-slate-200 bg-slate-50 p-3">
      <h4 className="font-medium text-slate-900">{title}</h4>
      <dl className="mt-2 grid grid-cols-2 gap-2 text-xs">
        <Metric label="Pending sample" value={String(value.pendingSampled)} />
        <Metric label="Actionable sample" value={String(value.actionableSampled)} />
        <Metric label="Attempts ≥3" value={String(value.attemptsAtLeast3Sampled)} />
        <Metric label="Oldest actionable" value={formatAge(value.oldestActionableAgeMs)} />
      </dl>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-slate-500">{label}</dt><dd className="font-medium text-slate-900">{value}</dd></div>;
}

/**
 * Read-only panel intended for the Protractor timed-live operator page.
 * It deliberately has no mutation controls and pauses polling while hidden.
 */
export default function ProtractorLiveMonitor() {
  const [monitor, setMonitor] = useState<Monitor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [visible, setVisible] = useState(() => typeof document === "undefined" || !document.hidden);

  const refresh = useCallback(async () => {
    if (document.hidden) return;
    try {
      const response = await fetch(ENDPOINT, {
        method: "GET",
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body || typeof body !== "object" || !("generatedAt" in body)) {
        throw new Error((body as { error?: string } | null)?.error || `Monitor request failed (HTTP ${response.status}).`);
      }
      setMonitor(body as Monitor);
      setUpdatedAt(Date.now());
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Monitor request failed.");
    }
  }, []);

  useEffect(() => {
    const onVisibility = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    if (!visible) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh, visible]);

  const clientStale = updatedAt !== null && Date.now() - updatedAt > STALE_CLIENT_MS;
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm" aria-live="polite">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Live relay monitor</h2>
          <p className="mt-1 text-sm text-slate-600">
            Read-only, bounded production samples. This panel never sends provider or state-changing requests.
          </p>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${error || clientStale ? "bg-amber-100 text-amber-800" : "bg-green-100 text-green-800"}`}>
          {!visible ? "Polling paused (tab hidden)" : error ? "Refresh error" : clientStale ? "Client data stale" : "Polling"}
        </span>
      </div>
      {error && <p className="mt-3 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" role="alert">{error}</p>}
      {!monitor ? <p className="mt-4 text-sm text-slate-600">Loading read-only telemetry…</p> : (
        <>
          <p className="mt-3 text-xs text-slate-500">
            Snapshot {formatTime(monitor.generatedAt)} · api_usage: {monitor.scope.apiUsageCanonical} · callbacks: {monitor.scope.callbackCanonical}
          </p>
          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <div className="rounded border border-slate-200 p-3">
              <h3 className="font-medium text-slate-900">Relay outcomes & client duration <span className="text-xs font-normal text-slate-500">({monitor.relay.status})</span></h3>
              <dl className="mt-2 grid grid-cols-2 gap-2 text-xs">
                <Metric label="Responses sampled" value={String(monitor.relay.sampled)} />
                <Metric label="Duration measured" value={String(monitor.relay.latencySampled)} />
                <Metric label="Newest response" value={formatTime(monitor.relay.newestAt)} />
                <Metric label="Average duration" value={monitor.relay.averageLatencyMs == null ? "—" : `${monitor.relay.averageLatencyMs}ms`} />
                <Metric label="P95 duration" value={monitor.relay.p95LatencyMs == null ? "—" : `${monitor.relay.p95LatencyMs}ms`} />
              </dl>
              <p className="mt-2 text-xs text-slate-600">Outcomes: {Object.entries(monitor.relay.outcomes).map(([key, count]) => `${key} ${count}`).join(" · ") || "none"}</p>
              <p className="mt-2 text-xs text-slate-600">{monitor.relay.note}</p>
            </div>
            <div className="space-y-2">
              {monitor.callbacks.liveActivation && <QueueMetrics title="Live activation cohort" value={monitor.callbacks.liveActivation} />}
              <QueueMetrics title="Old held backlog" value={monitor.callbacks.heldBacklog} />
              <p className="text-xs text-slate-600">
                Callback queue: {monitor.callbacks.status} · Activation cohort: {monitor.callbacks.activationCohortStatus} · Retained unsupported Contacts: {monitor.callbacks.retainedContactsSampled} sampled · Last callback progress: {formatTime(monitor.callbacks.lastProgressAt)}
              </p>
              <p className="text-xs text-slate-600">
                Indexed outcomes ({monitor.callbacks.outcomes.status}, {monitor.callbacks.outcomes.sampled} sampled): live {monitor.callbacks.outcomes.liveActivation ? Object.entries(monitor.callbacks.outcomes.liveActivation).map(([key, count]) => `${key} ${count}`).join(" · ") || "none" : "no live cohort"} · held {Object.entries(monitor.callbacks.outcomes.heldBacklog).map(([key, count]) => `${key} ${count}`).join(" · ") || "none"}
              </p>
            </div>
            <div className="rounded border border-slate-200 p-3">
              <h3 className="font-medium text-slate-900">Provider breaker <span className="text-xs font-normal text-slate-500">({monitor.breaker.status})</span></h3>
              <p className="mt-2 text-sm font-semibold text-slate-900">{monitor.breaker.state.toUpperCase()}</p>
              <p className="mt-1 text-xs text-slate-600">Open until: {formatTime(monitor.breaker.openUntil)} · Probe until: {formatTime(monitor.breaker.probeUntil)}</p>
              <p className="mt-3 text-xs text-slate-600">{monitor.breaker.alerting.note}</p>
            </div>
          </div>
          <p className="mt-4 text-xs text-slate-500">
            {monitor.callbacks.note} For fleet-exact or historical investigation, use the{" "}
            <a className="underline" href="/platform-admin/runbooks/triage">existing operations triage runbook</a>{" "}
            and <a className="underline" href="/platform-admin/slow-queries">database monitoring</a>.
          </p>
        </>
      )}
    </section>
  );
}