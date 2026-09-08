"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { approvedHost } from "@/lib/appfueled-url-contract";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Clipboard,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  RotateCw,
  ShieldCheck,
  X,
} from "lucide-react";

type Connection = {
  id: string;
  connectionId: string;
  mosShopId: number;
  incomingShopId: number;
  shopIdNamespace: "mos" | "provider";
  namespaceConfirmation: string;
  allowedHosts: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastSuccessAt?: string | null;
  lastReceiptId?: string | null;
};

type Receipt = {
  id: string;
  receivedAt: string;
  connectionId: string;
  mosShopId: string;
  vin?: string | null;
  payload: unknown;
  reason?: string | null;
  outcome: "accepted" | "rejected";
  durationMs?: number | null;
  correlationId?: string | null;
};

type VehicleUrl = {
  connectionId: string;
  mosShopId: string;
  vin: string;
  vehicleUrl: string;
  receivedAt: string;
  receiptId: string;
};

type FeedResponse = {
  connections: Connection[];
  receipts: Receipt[];
  hasMore: boolean;
  page: number;
  vehicleUrls: VehicleUrl[];
  baseUrl: string;
};

const inputClass =
  "mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none transition focus:border-[#3c81c3] focus:ring-2 focus:ring-[#3c81c3]/20";

function dateText(value?: string | null) {
  if (!value) return "No accepted delivery recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function hostIsApproved(host: string) {
  try {
    approvedHost(host);
    return true;
  } catch {
    return false;
  }
}

export default function AppFueledUrlEventsPage() {
  const [data, setData] = useState<FeedResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ shopId: "", connectionId: "", vin: "", from: "", to: "", outcome: "" });
  const [appliedFilters, setAppliedFilters] = useState(filters);
  const [showSetup, setShowSetup] = useState(false);
  const [expandedReceipt, setExpandedReceipt] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ url: string; connectionId: string } | null>(null);
  const [revealedCredential, setRevealedCredential] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [action, setAction] = useState<{ connection: Connection; kind: "disable" | "rotate" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState<{
    connectionId: string;
    mosShopId: string;
    incomingShopId: string;
    shopIdNamespace: "" | "mos" | "provider";
    namespaceConfirmation: string;
    allowedHosts: string;
    hostConfirmed: boolean;
    confirmedBaseUrl: string;
  }>({
    connectionId: "", mosShopId: "", incomingShopId: "", shopIdNamespace: "",
    namespaceConfirmation: "", allowedHosts: "", hostConfirmed: false, confirmedBaseUrl: "",
  });

  const load = useCallback(async (targetPage = 1, currentFilters = appliedFilters) => {
    setLoading(true);
    setError(null);
    setForbidden(false);
    try {
      const params = new URLSearchParams({ page: String(targetPage) });
      Object.entries(currentFilters).forEach(([key, value]) => {
        if (!value) return;
        if (key === "from") params.set(key, new Date(`${value}T00:00:00`).toISOString());
        else if (key === "to") params.set(key, new Date(`${value}T23:59:59.999`).toISOString());
        else params.set(key, value);
      });
      const response = await fetch(`/api/platform-admin/appfueled-url-events?${params.toString()}`, { credentials: "include" });
      if (response.status === 401 || response.status === 403) {
        setForbidden(true);
        setData(null);
        return;
      }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
      setData(body);
      setPage(body.page ?? targetPage);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load AppFueled URL events.");
    } finally {
      setLoading(false);
    }
  }, [appliedFilters]);

  useEffect(() => { load(1, appliedFilters); }, [appliedFilters, load]);

  const knownMosShopIds = useMemo(
    () => [...new Set((data?.connections ?? []).map((connection) => String(connection.mosShopId)))],
    [data?.connections],
  );

  const applyFilters = (event: React.FormEvent) => {
    event.preventDefault();
    setPage(1);
    setAppliedFilters(filters);
  };

  const copySecret = async () => {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch { setError("Clipboard access was unavailable. Select and copy the URL manually."); }
  };

  const submitSetup = async (event: React.FormEvent) => {
    event.preventDefault();
    const hosts = setup.allowedHosts.split(/\r?\n|,/).map((value) => value.trim()).filter(Boolean);
    const note = setup.namespaceConfirmation.trim();
    if (!setup.shopIdNamespace || !/^[1-9]\d*$/.test(setup.incomingShopId) || !/^[1-9]\d*$/.test(setup.mosShopId) ||
      note.length < 10 || !setup.hostConfirmed || setup.confirmedBaseUrl !== baseUrl || hosts.length === 0 || hosts.some((host) => !hostIsApproved(host))) {
      setError("Complete every setup confirmation. Allowed hosts must be exact approved DNS hostnames.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/platform-admin/appfueled-url-events", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...setup, mosShopId: Number(setup.mosShopId), incomingShopId: Number(setup.incomingShopId), allowedHosts: hosts, shopIdNamespace: setup.shopIdNamespace }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Setup request failed.");
      setShowSetup(false);
      setSecret({ url: body.webhookUrl, connectionId: body.connection?.connectionId ?? setup.connectionId });
      setSetup({ connectionId: "", mosShopId: "", incomingShopId: "", shopIdNamespace: "", namespaceConfirmation: "", allowedHosts: "", hostConfirmed: false, confirmedBaseUrl: "" });
      load(1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create connection."); }
    finally { setBusy(false); }
  };

  const confirmAction = async () => {
    if (!action || !data?.baseUrl) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/platform-admin/appfueled-url-events", {
        method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: action.connection.id, action: action.kind, confirmedBaseUrl: data.baseUrl }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Could not ${action.kind} connection.`);
      if (body.webhookUrl) setSecret({ url: body.webhookUrl, connectionId: body.connection?.connectionId ?? action.connection.connectionId });
      setAction(null);
      load(page);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Credential action failed."); }
    finally { setBusy(false); }
  };

  const baseUrl = data?.baseUrl ?? "";
  return (
    <div className="mx-auto max-w-7xl p-6 md:p-8">
      <div className="mb-6 flex flex-col justify-between gap-4 border-b border-gray-200 pb-6 md:flex-row md:items-end">
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-amber-700">
            <AlertTriangle className="h-4 w-4" /> Unverified deployment / setup
          </div>
          <h1 className="text-2xl font-bold text-gray-900">AppFueled URL feeds</h1>
          <p className="mt-1 max-w-3xl text-sm text-gray-600">Credentialed intake controls and receipt evidence for trusted platform operators. This is not a customer-facing vehicle report.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => load(page)} disabled={loading} className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />Refresh</button>
          <button onClick={() => setShowSetup(true)} disabled={loading || forbidden || !baseUrl} className="inline-flex items-center gap-2 rounded-lg bg-[#3c81c3] px-4 py-2 text-sm font-semibold text-white hover:bg-[#306fae] disabled:cursor-not-allowed disabled:opacity-50"><Plus className="h-4 w-4" />Configure feed</button>
        </div>
      </div>

      <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <strong>Operator note:</strong> receipt history is limited to 30 days. Source ordering is unknown; a received URL is a candidate only and does not change QR behavior.
      </div>
      {error && <div className="mb-5 flex items-start justify-between gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800"><span>{error}</span><button onClick={() => setError(null)} aria-label="Dismiss error"><X className="h-4 w-4" /></button></div>}
      {forbidden && <div className="rounded-xl border border-red-200 bg-red-50 p-8 text-center"><ShieldCheck className="mx-auto mb-3 h-8 w-8 text-red-600" /><h2 className="font-semibold text-red-900">Platform operator access required</h2><p className="mt-1 text-sm text-red-700">The feed configuration endpoint rejected this session. Use an authorized platform-admin session.</p></div>}
      {revealedCredential && !secret && <div className="mb-5 flex items-center gap-2 rounded-lg border border-gray-300 bg-gray-50 px-4 py-3 text-sm text-gray-700"><KeyRound className="h-4 w-4 text-gray-500" /> Credential for <code>{revealedCredential}</code> was revealed once and is now masked. Rotate it if secure delivery cannot be confirmed.</div>}

      {!forbidden && <>
        <form onSubmit={applyFilters} className="mb-6 grid grid-cols-1 gap-3 rounded-xl border border-gray-200 bg-gray-50 p-4 md:grid-cols-6">
          {(["shopId", "vin"] as const).map((field) => <label key={field} className="text-xs font-medium text-gray-600">{field === "shopId" ? "MOS shop ID" : "VIN"}<input value={filters[field]} onChange={(event) => setFilters({ ...filters, [field]: event.target.value })} className={inputClass} /></label>)}
          <label className="text-xs font-medium text-gray-600">Connection<select value={filters.connectionId} onChange={(event) => setFilters({ ...filters, connectionId: event.target.value })} className={inputClass}><option value="">All connections</option>{data?.connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.connectionId}</option>)}</select></label>
          <label className="text-xs font-medium text-gray-600">From<input type="date" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} className={inputClass} /></label>
          <label className="text-xs font-medium text-gray-600">To<input type="date" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} className={inputClass} /></label>
          <div className="flex items-end gap-2"><label className="flex-1 text-xs font-medium text-gray-600">Outcome<select value={filters.outcome} onChange={(event) => setFilters({ ...filters, outcome: event.target.value })} className={inputClass}><option value="">Any</option><option value="accepted">Accepted</option><option value="rejected">Rejected</option></select></label><button className="rounded-lg bg-gray-800 px-3 py-2 text-sm font-medium text-white">Search</button></div>
        </form>

        <section className="mb-6 overflow-hidden rounded-xl border border-gray-200 bg-white">
          <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4"><div><h2 className="font-semibold text-gray-900">Feed associations</h2><p className="mt-0.5 text-xs text-gray-500">Association provenance: explicit namespace confirmation and host allowlist captured at setup.</p></div><span className="text-sm text-gray-500">{data?.connections.length ?? 0} connections</span></div>
          {loading ? <div className="space-y-3 p-5">{[1,2,3].map((value) => <div key={value} className="h-14 animate-pulse rounded bg-gray-100" />)}</div> :
            data?.connections.length === 0 ? <div className="p-10 text-center text-sm text-gray-500">No AppFueled URL feeds match this view. Configure a feed only after verifying the shop association.</div> :
            <div className="overflow-x-auto"><table className="w-full min-w-[920px] text-sm"><thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500"><tr><th className="px-4 py-3">Connection / status</th><th className="px-4 py-3">Association</th><th className="px-4 py-3">Exact allowed hosts</th><th className="px-4 py-3">Last success</th><th className="px-4 py-3 text-right">Credential</th></tr></thead><tbody>{data?.connections.map((connection) => <tr key={connection.id} className="border-t border-gray-100 align-top"><td className="px-4 py-4"><code className="text-xs text-gray-700">{connection.connectionId}</code><div className={`mt-2 inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${connection.enabled ? "bg-emerald-100 text-emerald-800" : "bg-gray-200 text-gray-700"}`}>{connection.enabled ? "Enabled" : "Disabled"}</div></td><td className="px-4 py-4 text-xs text-gray-600"><div>MOS: <code>{connection.mosShopId}</code></div><div>Incoming: <code>{connection.incomingShopId}</code> ({connection.shopIdNamespace})</div><p className="mt-1 max-w-xs italic text-gray-400">{connection.namespaceConfirmation}</p></td><td className="px-4 py-4">{connection.allowedHosts.map((host) => <code key={host} className="mb-1 block break-all text-xs text-gray-700">{host}</code>)}</td><td className="px-4 py-4 text-xs text-gray-600">{dateText(connection.lastSuccessAt)}{connection.lastReceiptId && <div className="mt-1 text-gray-400">Receipt {connection.lastReceiptId}</div>}</td><td className="px-4 py-4 text-right"><div className="flex justify-end gap-2">{connection.enabled && <button onClick={() => setAction({ connection, kind: "disable" })} className="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-100">Disable</button>}<button onClick={() => setAction({ connection, kind: "rotate" })} className="inline-flex items-center gap-1 rounded-lg border border-[#b8d5ed] bg-[#eef7fd] px-3 py-1.5 text-xs font-semibold text-[#21679d] hover:bg-[#dfeff9]"><RotateCw className="h-3 w-3" />{connection.enabled ? "Rotate" : "Rotate & re-enable"}</button></div></td></tr>)}</tbody></table></div>}
        </section>

        <section className="mb-6 overflow-hidden rounded-xl border border-gray-200 bg-white">
          <div className="border-b border-gray-200 px-5 py-4"><h2 className="font-semibold text-gray-900">Delivery receipts</h2><p className="mt-0.5 text-xs text-gray-500">Sanitized payload only. Rejected receipts retain the recorded reason for diagnosis.</p></div>
          {loading ? <div className="space-y-3 p-5">{[1,2,3,4].map((value) => <div key={value} className="h-12 animate-pulse rounded bg-gray-100" />)}</div> :
            <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-sm"><thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500"><tr><th className="px-4 py-3">Received</th><th className="px-4 py-3">Outcome</th><th className="px-4 py-3">VIN / connection</th><th className="px-4 py-3">Evidence</th><th className="px-4 py-3">Payload</th></tr></thead><tbody>{data?.receipts.map((receipt) => <tr key={receipt.id} className="border-t border-gray-100 align-top"><td className="px-4 py-3 text-xs text-gray-600">{dateText(receipt.receivedAt)}</td><td className="px-4 py-3"><span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${receipt.outcome === "accepted" ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-800"}`}>{receipt.outcome}</span>{receipt.reason && <p className="mt-1 max-w-[200px] text-xs text-red-700">{receipt.reason}</p>}</td><td className="px-4 py-3 text-xs"><code>{receipt.vin || "VIN unavailable"}</code><div className="mt-1 text-gray-500">{receipt.connectionId}</div></td><td className="px-4 py-3 text-xs text-gray-600"><div>{receipt.durationMs == null ? "Duration unavailable" : `${receipt.durationMs}ms`}</div><div className="mt-1 break-all text-gray-400">{receipt.correlationId || "No correlation ID"}</div></td><td className="px-4 py-3"><button onClick={() => setExpandedReceipt(expandedReceipt === receipt.id ? null : receipt.id)} className="inline-flex items-center gap-1 text-xs font-medium text-[#21679d]">{expandedReceipt === receipt.id ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}{expandedReceipt === receipt.id ? "Hide" : "View"} sanitized JSON</button>{expandedReceipt === receipt.id && <pre className="mt-2 max-w-sm overflow-auto rounded bg-gray-950 p-3 text-xs leading-5 text-gray-100">{JSON.stringify(receipt.payload, null, 2)}</pre>}</td></tr>)}{data?.receipts.length === 0 && <tr><td colSpan={5} className="px-4 py-10 text-center text-sm text-gray-500">No receipts matched the selected 30-day window.</td></tr>}</tbody></table></div>}
          <div className="flex items-center justify-between border-t border-gray-200 px-5 py-3"><span className="text-xs text-gray-500">Page {page}</span><div className="flex gap-2"><button disabled={loading || page <= 1} onClick={() => load(page - 1)} className="rounded border border-gray-300 px-3 py-1.5 text-xs disabled:opacity-40">Previous</button><button disabled={loading || !data?.hasMore} onClick={() => load(page + 1)} className="rounded border border-gray-300 px-3 py-1.5 text-xs disabled:opacity-40">Next</button></div></div>
        </section>

        <section className="rounded-xl border border-gray-200 bg-white p-5"><h2 className="font-semibold text-gray-900">URL candidates by vehicle</h2><p className="mt-1 text-xs text-gray-500">Informational association provenance. URLs are rendered as text; this screen does not navigate to external, secret, or customer URLs.</p><div className="mt-4 space-y-2">{data?.vehicleUrls.length ? data.vehicleUrls.map((item) => <div key={item.receiptId} className="grid gap-1 rounded-lg border border-gray-100 bg-gray-50 p-3 text-xs md:grid-cols-[1fr_1fr_2fr]"><code>{item.vin}</code><span className="text-gray-500">MOS {item.mosShopId} · receipt {item.receiptId}</span><code className="break-all text-gray-700">{item.vehicleUrl}</code></div>) : <p className="py-4 text-sm text-gray-500">No URL candidates in this result set.</p>}</div></section>
      </>}

      {showSetup && <div className="fixed inset-0 z-50 overflow-y-auto bg-gray-950/50 p-4"><div className="mx-auto my-6 max-w-2xl rounded-xl bg-white shadow-2xl"><div className="flex items-center justify-between border-b border-gray-200 p-5"><div><h2 className="font-semibold text-gray-900">Configure AppFueled feed</h2><p className="mt-1 text-xs text-amber-700">Unverified deployment / setup — validate the live host with your deployment owner.</p></div><button onClick={() => setShowSetup(false)} aria-label="Close setup"><X className="h-5 w-5 text-gray-500" /></button></div><form onSubmit={submitSetup} className="space-y-4 p-5">
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><strong>Credential handling:</strong> the webhook URL is a secret and will be shown once after setup. Do not paste it into tickets or customer communications.</div>
        <div className="grid gap-4 md:grid-cols-2"><label className="text-sm font-medium text-gray-700">Connection identifier<input required value={setup.connectionId} onChange={(event) => setSetup({...setup, connectionId: event.target.value})} className={inputClass} /></label><label className="text-sm font-medium text-gray-700">Known MOS shop ID<input required list="known-mos-shops" value={setup.mosShopId} onChange={(event) => setSetup({...setup, mosShopId: event.target.value})} className={inputClass} /><datalist id="known-mos-shops">{knownMosShopIds.map((id) => <option key={id} value={id} />)}</datalist><span className="mt-1 block text-xs font-normal text-gray-500">Server verifies this known MOS association.</span></label><label className="text-sm font-medium text-gray-700">Incoming numeric shop identifier<input required min="1" inputMode="numeric" pattern="[1-9][0-9]*" value={setup.incomingShopId} onChange={(event) => setSetup({...setup, incomingShopId: event.target.value})} className={inputClass} /></label><label className="text-sm font-medium text-gray-700">Identifier namespace<select required value={setup.shopIdNamespace} onChange={(event) => setSetup({...setup, shopIdNamespace: event.target.value as "" | "mos" | "provider"})} className={inputClass}><option value="">Choose explicitly</option><option value="mos">MOS namespace</option><option value="provider">Provider namespace</option></select></label></div>
        <label className="block text-sm font-medium text-gray-700">Namespace confirmation note <span className="font-normal text-gray-500">(minimum 10 characters)</span><textarea name="namespaceConfirmation" required minLength={10} value={setup.namespaceConfirmation} onChange={(event) => setSetup({...setup, namespaceConfirmation: event.target.value})} className={inputClass} rows={2} placeholder="State how the incoming shop identifier was verified." /></label>
        <label className="block text-sm font-medium text-gray-700">Allowed exact public DNS hostnames <span className="font-normal text-gray-500">(one hostname per line)</span><textarea required value={setup.allowedHosts} onChange={(event) => setSetup({...setup, allowedHosts: event.target.value})} className={inputClass} rows={3} placeholder={"vehicles.customer.com\ninventory.customer.com"} /><span className="mt-1 block text-xs font-normal text-gray-500">Hostnames only: no scheme, path, port, localhost, private IPs, or wildcards.</span></label>
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3"><p className="text-sm font-medium text-gray-800">Deployment base URL</p><code className="mt-1 block break-all text-xs text-gray-700">{baseUrl || "Loading from API…"}</code><label className="mt-3 flex items-start gap-2 text-sm text-gray-700"><input required type="checkbox" checked={setup.hostConfirmed} onChange={(event) => setSetup({...setup, hostConfirmed: event.target.checked, confirmedBaseUrl: baseUrl})} className="mt-1" />I confirm this exact base URL is the intended operator deployment host.</label></div>
        <div className="flex justify-end gap-3"><button type="button" onClick={() => setShowSetup(false)} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700">Cancel</button><button disabled={busy || !baseUrl} className="inline-flex items-center gap-2 rounded-lg bg-[#3c81c3] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy && <Loader2 className="h-4 w-4 animate-spin" />}Create secure feed</button></div>
      </form></div></div>}

      {secret && <div className="fixed inset-0 z-[60] flex items-center justify-center bg-gray-950/60 p-4"><div className="w-full max-w-xl rounded-xl bg-white p-6 shadow-2xl"><div className="flex items-center gap-2 text-emerald-700"><KeyRound className="h-5 w-5" /><h2 className="font-semibold">One-time credential reveal</h2></div><p className="mt-2 text-sm text-gray-600">Connection <code>{secret.connectionId}</code>. Copy this secret now; it cannot be retrieved from this screen later.</p><code className="mt-4 block break-all rounded-lg bg-gray-950 p-4 text-sm text-gray-100">{secret.url}</code><div className="mt-5 flex justify-end gap-3"><button onClick={() => { setRevealedCredential(secret.connectionId); setSecret(null); }} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium">I copied it</button><button onClick={copySecret} className="inline-flex items-center gap-2 rounded-lg bg-[#3c81c3] px-4 py-2 text-sm font-semibold text-white">{copied ? <Check className="h-4 w-4" /> : <Clipboard className="h-4 w-4" />}{copied ? "Copied" : "Copy secret"}</button></div></div></div>}
      {action && <div className="fixed inset-0 z-[60] flex items-center justify-center bg-gray-950/60 p-4"><div className="w-full max-w-md rounded-xl bg-white p-6 shadow-2xl"><div className="flex gap-3"><AlertTriangle className="h-6 w-6 shrink-0 text-red-600" /><div><h2 className="font-semibold text-gray-900">{action.kind === "disable" ? "Disable credential?" : "Rotate and re-enable credential?"}</h2><p className="mt-2 text-sm text-gray-600">{action.kind === "disable" ? "New deliveries using this credential will stop. This does not delete receipt evidence." : "The prior credential will be invalidated. A new secret will be shown once; distribute it only through an approved secure channel."}</p></div></div><div className="mt-6 flex justify-end gap-3"><button onClick={() => setAction(null)} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium">Cancel</button><button onClick={confirmAction} disabled={busy} className="inline-flex items-center gap-2 rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy && <Loader2 className="h-4 w-4 animate-spin" />}Confirm {action.kind}</button></div></div></div>}
    </div>
  );
}