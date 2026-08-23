"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Printer,
  RefreshCw,
  Loader2,
  Wifi,
  WifiOff,
  RotateCcw,
  Trash2,
  Save,
  CheckCircle2,
  Clock,
  AlertTriangle,
  Send,
} from "lucide-react";

interface AgentRow {
  printerId: string;
  lastPollAt: string;
  agentVersion: string | null;
  online: boolean;
}

interface PrinterConfig {
  shopId: number;
  printerId: string | null;
  address: string;
  port: number;
  defaultCut: 0 | 1;
  defaultSpeed: 0 | 1;
  defaultWidth: number;
}

interface JobRow {
  id: string;
  status: "pending" | "in-flight" | "done" | "failed";
  kind: string | null;
  printerId: string | null;
  attempts: number;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
  updatedAt: string | null;
  meta: Record<string, unknown> | null;
}

interface ShopRow {
  shopId: number;
  shopName: string | null;
  configs: PrinterConfig[];
  agents: AgentRow[];
  counts: { pending: number; inFlight: number; done: number; failed: number; total: number };
  recentJobs: JobRow[];
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function fmtAgo(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const STATUS_BADGE: Record<JobRow["status"], string> = {
  pending: "bg-amber-100 text-amber-700",
  "in-flight": "bg-blue-100 text-blue-700",
  done: "bg-emerald-100 text-emerald-700",
  failed: "bg-red-100 text-red-700",
};

function ConfigEditor({ shop, onSaved }: { shop: ShopRow; onSaved: () => void }) {
  const existing = shop.configs[0];
  const inferredPrinterId =
    existing?.printerId ??
    shop.agents.find((agent) => agent.printerId !== "default")?.printerId ??
    "";
  const [address, setAddress] = useState(existing?.address ?? "");
  const [printerId, setPrinterId] = useState(inferredPrinterId);
  const [port, setPort] = useState<number>(existing?.port ?? 9100);
  const [cut, setCut] = useState<0 | 1>(existing?.defaultCut ?? 1);
  const [speed, setSpeed] = useState<0 | 1>(existing?.defaultSpeed ?? 0);
  const [width, setWidth] = useState<number>(existing?.defaultWidth ?? 640);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");

  const save = async () => {
    setSaving(true);
    setErr("");
    setSaved(false);
    try {
      const res = await fetch("/api/platform-admin/zink-print/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shopId: shop.shopId,
          address,
          port,
          cut,
          speed,
          width,
          printerId: printerId.trim() || null,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `Save failed (${res.status})`);
      }
      setSaved(true);
      onSaved();
    } catch (e: any) {
      setErr(e.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
      <div className="text-xs font-semibold uppercase text-gray-500 mb-3">
        Printer Config
      </div>
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <div className="col-span-2">
          <label className="block text-xs text-gray-600 mb-1">Address / Host</label>
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="e.g. 192.168.1.50"
            className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-600 mb-1">Printer ID</label>
          <input
            value={printerId}
            onChange={(e) => setPrinterId(e.target.value)}
            placeholder="front-counter"
            className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-600 mb-1">Port</label>
          <input
            type="number"
            value={port}
            onChange={(e) => setPort(Number(e.target.value) || 9100)}
            className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-600 mb-1">Width (px)</label>
          <input
            type="number"
            value={width}
            onChange={(e) => setWidth(Number(e.target.value) || 640)}
            className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-600 mb-1">Cut</label>
          <select
            value={cut}
            onChange={(e) => setCut(Number(e.target.value) as 0 | 1)}
            className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm bg-white"
          >
            <option value={1}>Full cut (1)</option>
            <option value={0}>Half cut (0)</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-600 mb-1">Speed</label>
          <select
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value) as 0 | 1)}
            className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm bg-white"
          >
            <option value={0}>Vivid · 317 lpi (0)</option>
            <option value={1}>Normal · 264 lpi (1)</option>
          </select>
        </div>
        <div className="flex items-end">
          <button
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            Save
          </button>
        </div>
      </div>
      {err && <p className="text-xs text-red-600 mt-2">{err}</p>}
      {saved && !err && <p className="text-xs text-emerald-600 mt-2">Saved.</p>}
    </div>
  );
}

function ShopCard({ shop, onChanged }: { shop: ShopRow; onChanged: () => void }) {
  const [busyJob, setBusyJob] = useState<string | null>(null);
  const [testJobId, setTestJobId] = useState<string | null>(null);
  const [testError, setTestError] = useState("");
  const [sendingTest, setSendingTest] = useState(false);
  const anyOnline = shop.agents.some((a) => a.online);
  const testJob = testJobId
    ? shop.recentJobs.find((job) => job.id === testJobId)
    : null;

  const sendPilotTest = async () => {
    setSendingTest(true);
    setTestError("");
    try {
      const config = shop.configs[0];
      const res = await fetch("/api/platform-admin/zink-print/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shopId: shop.shopId,
          printerId: config?.printerId ?? null,
          cut: config?.defaultCut ?? 1,
          speed: config?.defaultSpeed ?? 0,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `Test enqueue failed (${res.status})`);
      }
      setTestJobId(data.jobId);
      onChanged();
    } catch (e: any) {
      setTestError(e.message || "Failed to queue pilot test");
    } finally {
      setSendingTest(false);
    }
  };

  const jobAction = async (job: JobRow, action: "requeue" | "clear") => {
    if (action === "clear" && !confirm("Permanently remove this job from the queue?")) {
      return;
    }
    setBusyJob(job.id + action);
    try {
      const res = await fetch(`/api/platform-admin/zink-print/jobs/${job.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, shopId: shop.shopId }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `Action failed (${res.status})`);
      }
      onChanged();
    } catch (e: any) {
      alert(e.message || "Action failed");
    } finally {
      setBusyJob(null);
    }
  };

  return (
    <div className="border border-gray-200 rounded-xl bg-white overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-b border-gray-200">
        <div>
          <div className="font-semibold text-gray-900">
            {shop.shopName || `Shop ${shop.shopId}`}
            <span className="text-gray-400 font-normal text-sm ml-2">#{shop.shopId}</span>
          </div>
          <div className="flex items-center gap-2 mt-1 text-xs">
            {anyOnline ? (
              <span className="inline-flex items-center gap-1 text-emerald-600">
                <Wifi className="w-3.5 h-3.5" /> Agent online
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-gray-400">
                <WifiOff className="w-3.5 h-3.5" /> Agent offline
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className="inline-flex items-center gap-1 text-amber-600">
            <Clock className="w-3.5 h-3.5" /> {shop.counts.pending} pending
          </span>
          <span className="inline-flex items-center gap-1 text-blue-600">
            <Send className="w-3.5 h-3.5" /> {shop.counts.inFlight} in-flight
          </span>
          <span className="inline-flex items-center gap-1 text-emerald-600">
            <CheckCircle2 className="w-3.5 h-3.5" /> {shop.counts.done} done
          </span>
          <span className="inline-flex items-center gap-1 text-red-600">
            <AlertTriangle className="w-3.5 h-3.5" /> {shop.counts.failed} failed
          </span>
        </div>
      </div>

      <div className="p-4 space-y-4">
        {/* Agents */}
        {shop.agents.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {shop.agents.map((a) => (
              <div
                key={a.printerId}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs border ${
                  a.online
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                    : "border-gray-200 bg-gray-50 text-gray-500"
                }`}
                title={`Last poll: ${fmtDate(a.lastPollAt)}`}
              >
                {a.online ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
                <span className="font-medium">{a.printerId}</span>
                <span className="opacity-70">· {fmtAgo(a.lastPollAt)}</span>
                {a.agentVersion && <span className="opacity-50">v{a.agentVersion}</span>}
              </div>
            ))}
          </div>
        )}

        <ConfigEditor shop={shop} onSaved={onChanged} />

        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 p-3">
          <button
            onClick={sendPilotTest}
            disabled={sendingTest || !shop.configs[0]?.address}
            className="inline-flex items-center gap-1.5 rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            title="Queue the fixed MOS pilot test pattern through the cloud agent"
          >
            {sendingTest ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            Send pilot test
          </button>
          <div className="text-xs text-blue-900">
            {!shop.configs[0]?.address
              ? "Save a printer address first."
              : testError
                ? <span className="text-red-700">{testError}</span>
                : testJob
                  ? (
                    <span>
                      Test <span className="font-mono">{testJob.id.slice(-8)}</span>:{" "}
                      <strong>{testJob.status}</strong>
                      {testJob.error ? ` — ${testJob.error}` : ""}
                    </span>
                  )
                  : testJobId
                    ? "Test queued; waiting for the next status refresh…"
                    : "Queues a known image and traces it below without opening the printer LAN."}
          </div>
        </div>

        {/* Recent jobs */}
        <div>
          <div className="text-xs font-semibold uppercase text-gray-500 mb-2">
            Recent Jobs
          </div>
          {shop.recentJobs.length === 0 ? (
            <div className="text-sm text-gray-400 italic">No jobs yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs uppercase text-gray-400">
                  <tr>
                    <th className="text-left py-1.5 pr-3">Status</th>
                    <th className="text-left py-1.5 pr-3">Kind</th>
                    <th className="text-left py-1.5 pr-3">Printer</th>
                    <th className="text-left py-1.5 pr-3">Created</th>
                    <th className="text-right py-1.5 pr-3">Tries</th>
                    <th className="text-left py-1.5 pr-3">Error</th>
                    <th className="text-right py-1.5">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {shop.recentJobs.map((j) => (
                    <tr key={j.id} className="border-t border-gray-100 align-top">
                      <td className="py-1.5 pr-3">
                        <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${STATUS_BADGE[j.status]}`}>
                          {j.status}
                        </span>
                      </td>
                      <td className="py-1.5 pr-3 text-gray-600">{j.kind || "—"}</td>
                      <td className="py-1.5 pr-3 text-gray-600">{j.printerId || "any"}</td>
                      <td className="py-1.5 pr-3 text-gray-500 text-xs whitespace-nowrap">{fmtDate(j.createdAt)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{j.attempts}</td>
                      <td className="py-1.5 pr-3 text-red-600 text-xs max-w-[180px] truncate" title={j.error || ""}>
                        {j.error || "—"}
                      </td>
                      <td className="py-1.5 text-right whitespace-nowrap">
                        {(j.status === "failed" || j.status === "in-flight") && (
                          <button
                            onClick={() => jobAction(j, "requeue")}
                            disabled={busyJob === j.id + "requeue"}
                            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-50 mr-1"
                            title="Re-queue this job"
                          >
                            {busyJob === j.id + "requeue" ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <RotateCcw className="w-3 h-3" />
                            )}
                            Re-queue
                          </button>
                        )}
                        <button
                          onClick={() => jobAction(j, "clear")}
                          disabled={busyJob === j.id + "clear"}
                          className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-50"
                          title="Remove this job"
                        >
                          {busyJob === j.id + "clear" ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <Trash2 className="w-3 h-3" />
                          )}
                          Clear
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
    </div>
  );
}

export default function ZinkPrintAdminPage() {
  const [shops, setShops] = useState<ShopRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError("");
      const res = await fetch("/api/platform-admin/zink-print");
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `Failed (${res.status})`);
      }
      const j = await res.json();
      setShops(j.shops || []);
    } catch (e: any) {
      setError(e.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(load, 5000);
    return () => window.clearInterval(timer);
  }, [load]);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Printer className="w-6 h-6 text-blue-600" />
            ZINK Print — Fleet Status
          </h1>
          <p className="text-sm text-gray-600 mt-1">
            Per-shop print-agent status, printer config, and recent job history.
            Re-queue failed or stuck jobs, or clear them from the queue.
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-2 px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          Refresh
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded">
          {error}
        </div>
      )}

      {loading && shops.length === 0 ? (
        <div className="flex items-center gap-2 text-gray-500 text-sm py-12 justify-center">
          <Loader2 className="w-5 h-5 animate-spin" /> Loading…
        </div>
      ) : shops.length === 0 ? (
        <div className="text-center text-gray-500 py-16">
          <Printer className="w-10 h-10 mx-auto text-gray-300 mb-3" />
          <p className="text-sm">No shops have any ZINK print activity yet.</p>
          <p className="text-xs text-gray-400 mt-1">
            A shop appears here once it configures a printer, its agent polls,
            or a print job is queued.
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {shops.map((shop) => (
            <ShopCard key={shop.shopId} shop={shop} onChanged={load} />
          ))}
        </div>
      )}
    </div>
  );
}
