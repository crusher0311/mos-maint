"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight, Check, Clock3, KeyRound, LockKeyhole, RefreshCw, ShieldCheck } from "lucide-react";
import styles from "./exports.module.css";

type Shop = { shopId: number; name: string };
type Config = {
  revision: number; destination: string; shopIds: number[]; timeZone: string;
  dailyTime: string; initialSnapshot: boolean; paused: boolean; revoked: boolean; confirmedAt: string | null;
};
type ExportData = {
  enterprise: { id: string; name: string }; shops: Shop[]; config: Config | null;
  status: Array<{ shopId: number; window: unknown; lastSuccess: unknown; failure: unknown; coverage: unknown; pendingDeliveryId: string | null; attempts: number }>;
  history: Array<{ deliveryId: string; shopId: number; window: unknown; acceptedAt: string | null; recordCount: number }>;
  workerAvailable: boolean; enabled: boolean;
};
type Draft = Pick<Config, "destination" | "shopIds" | "timeZone" | "dailyTime" | "initialSnapshot">;
const emptyDraft: Draft = { destination: "", shopIds: [], timeZone: "UTC", dailyTime: "02:00", initialSnapshot: false };

// Only display known, non-sensitive operational fields; never dump server objects.
function detail(value: unknown): string {
  if (value === null || value === undefined || value === "") return "Not yet reported";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    const fields = value as Record<string, unknown>;
    return ["start", "end", "from", "to", "observedCount", "recordCount", "snapshotCount", "observedThrough", "since", "through", "mode", "status", "scanned", "missing", "oversized"]
      .filter(key => fields[key] !== undefined && typeof fields[key] !== "object")
      .map(key => `${key}: ${String(fields[key])}`).join(" · ") || "Coverage details not reported";
  }
  return "Not yet reported";
}

function dateLabel(value: unknown): string {
  if (!value) return "No successful delivery yet";
  if (typeof value !== "string" && typeof value !== "number") return "Success reported";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Timestamp unavailable" : date.toLocaleString();
}

function failureLabel(value: unknown): string {
  if (!value) return "No failure reported";
  // Failures may contain receiver bodies or credentials. Do not render arbitrary text.
  const code = typeof value === "object" ? (value as Record<string, unknown>).code : value;
  const known: Record<string, string> = {
    timeout: "Receiver timed out.", TIMEOUT: "Receiver timed out.",
    delivery_failed: "Delivery failed. Check your receiver before retrying.",
    network_error: "Could not reach the receiver.", NETWORK_ERROR: "Could not reach the receiver.",
    http_error: "Receiver did not accept the delivery.",
    invalid_destination: "The destination is not eligible for delivery.",
  };
  return typeof code === "string" && known[code] ? known[code] : "Delivery failed. Receiver details are hidden for security.";
}

export default function ProtractorExportsPage() {
  const [data, setData] = useState<ExportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [approved, setApproved] = useState(false);
  const [contract, setContract] = useState(false);
  const [resumeConfirmed, setResumeConfirmed] = useState(false);
  const [review, setReview] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const enterpriseId = useRef<string | null>(null);
  const mounted = useRef(true);

  const load = useCallback(async (initialize = false) => {
    setRefreshing(true);
    setError("");
    try {
      if (!enterpriseId.current) {
        const identityResponse = await fetch("/api/dashboard/enterprise-users", { credentials: "include", cache: "no-store" });
        if (identityResponse.status === 401 || identityResponse.status === 403) {
          if (mounted.current) { setDenied(true); setData(null); setSecret(null); }
          return;
        }
        if (!identityResponse.ok) throw new Error("Unable to load your enterprise account. Try again.");
        const identity = await identityResponse.json();
        if (!identity.enterprise?.id) throw new Error("An enterprise account is required to manage exports.");
        enterpriseId.current = identity.enterprise.id;
      }
      const response = await fetch(`/api/enterprise/protractor-exports?enterpriseId=${encodeURIComponent(enterpriseId.current!)}`, {
        credentials: "include", cache: "no-store",
      });
      if (response.status === 401 || response.status === 403) {
        if (mounted.current) { setDenied(true); setData(null); setSecret(null); }
        return;
      }
      if (!response.ok) throw new Error("Unable to load export settings. Try again.");
      const result: ExportData = await response.json();
      if (!mounted.current) return;
      setDenied(false);
      setData(result);
      if (initialize) {
        setDraft(result.config ? {
          destination: result.config.destination, shopIds: [...result.config.shopIds],
          timeZone: result.config.timeZone, dailyTime: result.config.dailyTime,
          initialSnapshot: result.config.initialSnapshot,
        } : emptyDraft);
        setApproved(false); setContract(false); setResumeConfirmed(false); setReview(false);
      }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "Unable to load exports.");
    } finally {
      if (mounted.current) { setLoading(false); setRefreshing(false); }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load(true);
    const clearSecret = () => { setSecret(null); setRevealed(false); };
    window.addEventListener("pagehide", clearSecret);
    return () => { mounted.current = false; window.removeEventListener("pagehide", clearSecret); };
  }, [load]);

  const config = data?.config;
  const blocked = !!busy || refreshing || !!error || denied;
  const unavailable = !data?.enabled || !data?.workerAvailable;
  const shopName = (id: number) => data?.shops.find(shop => shop.shopId === id)?.name || `Shop ${id}`;

  async function mutate(action: "configure" | "resume" | "pause" | "revoke" | "retry", shopId?: number) {
    if (!data || blocked || (action === "configure" && secret)) return;
    if (action === "revoke" && !window.confirm("Revoke this export configuration? Delivery authorization will be removed. Configure and approve again before sending more exports.")) return;
    setBusy(shopId === undefined ? action : `${action}-${shopId}`);
    setError(""); setNotice("");
    try {
      const response = await fetch("/api/enterprise/protractor-exports", {
        method: "POST", credentials: "include", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enterpriseId: data.enterprise.id, action, revision: config?.revision ?? null,
          ...(action === "configure" ? { ...draft, destination: draft.destination.trim(), redistributionApproved: true, contractConfirmed: true } : {}),
          ...(action === "resume" ? { contractConfirmed: true } : {}),
          ...(shopId !== undefined ? { shopId } : {}),
        }),
      });
      if (response.status === 401 || response.status === 403) { setDenied(true); setData(null); setSecret(null); throw new Error("You do not have permission to manage these exports."); }
      if (response.status === 409) throw new Error("This configuration changed in another session. Reload settings and review the current revision before trying again.");
      if (!response.ok) throw new Error("The request could not be completed. Reload settings to check the current state before trying again.");
      const result = await response.json();
      if (action === "configure") {
        setSecret(typeof result.signingSecret === "string" ? result.signingSecret : null);
        setRevealed(false); setCopied(false);
        setNotice(result.signingSecret ? "Configuration saved paused. Set up your receiver before resuming." : "Configuration saved paused, but no signing secret was returned. Do not resume until receiver setup is complete.");
      } else {
        setNotice(action === "retry" ? "Retry requested. Refresh delivery status to see the outcome." : `Exports ${action === "resume" ? "resumed" : action === "pause" ? "paused" : "revoked"}.`);
      }
      setResumeConfirmed(false);
      await load(action === "configure");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Request failed. Reload settings and try again.");
    } finally { setBusy(""); }
  }

  function reviewConfiguration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.shopIds.length || !approved || !contract) return;
    try {
      const destination = new URL(draft.destination);
      if (destination.protocol !== "https:" || destination.username || destination.password || destination.hash) {
        setNotice("Use an HTTPS receiver URL without embedded credentials or a fragment."); return;
      }
      new Intl.DateTimeFormat("en-US", { timeZone: draft.timeZone }).format();
    } catch { setNotice("Enter a valid HTTPS destination and IANA time zone, such as America/Chicago."); return; }
    setNotice(""); setReview(true);
  }

  if (loading) return (
    <div className={`${styles.page} flex-1 p-6 md:p-8`} aria-busy="true" aria-label="Loading export settings">
      <div className="max-w-5xl mx-auto space-y-6"><div className="h-6 w-44 bg-slate-200 rounded" /><div className="h-24 bg-slate-200 rounded-xl" /><div className="h-80 bg-slate-200 rounded-xl" /><p className="text-sm text-slate-600">Loading enterprise exports…</p></div>
    </div>
  );

  if (denied || !data) return (
    <div className={`${styles.page} flex-1 p-6 md:p-8`}>
      <div className={`${styles.panel} max-w-xl mx-auto my-12 p-8 text-center`}>
        <LockKeyhole className="w-9 h-9 text-blue-600 mx-auto mb-4" />
        <h1 className="text-xl font-semibold">{denied ? "Export access restricted" : "Exports could not be loaded"}</h1>
        <p className="text-sm text-slate-600 my-3">{denied ? "Your account does not have permission to manage organization exports. Contact your enterprise administrator." : error}</p>
        <div className="flex justify-center flex-wrap gap-4 mt-6"><Link href="/dashboard/enterprise" className={styles.secondary}>Back to enterprise</Link><button className={styles.primary} onClick={() => void load(true)} disabled={refreshing}>Try again</button></div>
      </div>
    </div>
  );

  return (
    <div className={`${styles.page} flex-1 overflow-auto`}>
      <div className="max-w-5xl mx-auto px-4 py-6 md:p-8 space-y-6">
        <Link href="/dashboard/enterprise" className="inline-flex items-center gap-2 text-sm text-slate-600 hover:text-blue-700"><ArrowLeft className="w-4 h-4" /> Enterprise overview</Link>
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div><p className="text-xs font-semibold uppercase tracking-widest text-blue-700 mb-2">{data.enterprise.name} / Data delivery</p><h1 className="text-2xl md:text-3xl font-bold tracking-tight">Daily Protractor exports</h1><p className="mt-2 text-sm text-slate-600">One destination. A daily schedule. Only the locations you approve.</p></div>
          <span className={`rounded-full px-3 py-1.5 text-xs font-semibold border ${!config || config.revoked ? "bg-slate-100 border-slate-200 text-slate-600" : config.paused ? "bg-amber-50 border-amber-200 text-amber-800" : "bg-emerald-50 border-emerald-200 text-emerald-800"}`}>{!config ? "Not configured" : config.revoked ? "Revoked" : config.paused ? "Paused" : "Active"}{config ? ` · Revision ${config.revision}` : ""}</span>
        </header>

        {error && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"><p>{error}</p><button type="button" className="mt-2 font-semibold underline" disabled={refreshing || !!busy} onClick={() => void load(true)}>Reload current settings (discards unsaved edits)</button></div>}
        {notice && <p role="status" className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">{notice}</p>}
        {!data.enabled && <div role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><strong>Organization exports are disabled platform-wide.</strong> No deliveries will run. Contact your platform administrator. Pause and revoke remain available.</div>}
        {!data.workerAvailable && <div role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><strong>Delivery worker unavailable.</strong> Scheduled deliveries and retries cannot run. You can prepare a paused configuration; resume after the worker is available.</div>}

        <section className="rounded-xl border border-blue-200 bg-blue-50/70 p-5 flex items-start gap-3">
          <ShieldCheck className="w-5 h-5 shrink-0 text-blue-600 mt-0.5" />
          <div><h2 className="font-semibold text-blue-950 text-sm">Know what is being shared</h2><p className="text-sm text-blue-900 mt-1 leading-relaxed">Exports contain MOS-observed latest Protractor snapshots only. Coverage depends on what MOS has observed; this is not a complete historical archive, a record of every change, or a deletion feed. DVI data is not included.</p></div>
        </section>

        {secret && <section aria-labelledby="secret-heading" className="rounded-xl border-2 border-blue-300 bg-blue-50 p-5">
          <h2 id="secret-heading" className="flex gap-2 items-center font-semibold"><KeyRound className="w-5 h-5 text-blue-700" /> Save your signing secret now</h2>
          <p className="text-sm text-slate-700 mt-2 mb-4">This secret is shown only for this save and is not stored in your browser. Save it in your receiver&apos;s secret manager. Do not send it in URLs or share it with unauthorized users. Leaving or reloading this page loses it.</p>
          <label htmlFor="signing-secret" className="sr-only">One-time signing secret</label>
          <input id="signing-secret" className={`${styles.input} font-mono text-sm`} type={revealed ? "text" : "password"} readOnly value={secret} autoComplete="off" spellCheck={false} />
          <div className="flex flex-wrap gap-2 mt-3">
            <button type="button" className={styles.secondary} onClick={() => setRevealed(!revealed)}>{revealed ? "Hide secret" : "Reveal secret"}</button>
            <button type="button" className={styles.secondary} onClick={async () => { try { await navigator.clipboard.writeText(secret); setCopied(true); } catch { setNotice("Clipboard unavailable. Reveal the secret and copy it securely by hand."); } }}>{copied ? "Copied — clear clipboard after setup" : "Copy secret"}</button>
            <button type="button" className={styles.primary} onClick={() => { if (window.confirm("Have you securely saved the signing secret? It cannot be shown again.")) { setSecret(null); setRevealed(false); setCopied(false); } }}>I saved it securely</button>
          </div>
        </section>}

        {config && <section className={`${styles.panel} p-5 md:p-6`} aria-labelledby="controls-heading">
          <div className="flex flex-wrap justify-between gap-3"><h2 id="controls-heading" className="font-semibold">Delivery controls</h2><p className="text-xs text-slate-500">Approval: {config.confirmedAt ? dateLabel(config.confirmedAt) : "Not recorded"}</p></div>
          <p className="text-sm text-slate-600 mt-2 break-all">{config.destination}</p><p className="text-sm text-slate-600 mt-1">Daily at {config.dailyTime} · {config.timeZone} · {config.shopIds.length} explicitly approved location{config.shopIds.length === 1 ? "" : "s"}</p>
          <p className="text-sm text-slate-600 mt-1">Approved scope: {config.shopIds.map(shopName).join(", ") || "No locations"}</p>
          <p className="text-sm text-slate-600 mt-1">Initial observed snapshot: {config.initialSnapshot ? "Included" : "Not included — start from scope baseline"}</p>
          {config.paused && !config.revoked && <label className="flex items-start gap-2 text-sm text-slate-700 mt-4"><input type="checkbox" className="mt-1" checked={resumeConfirmed} onChange={e => setResumeConfirmed(e.target.checked)} disabled={blocked || !!secret} /><span>I have saved the receiver signing secret, verified receiver setup, and confirm the current destination, location scope, schedule, initial snapshot choice and redistribution contract before resuming.</span></label>}
          <div className="flex flex-wrap gap-2 mt-4">
            {!config.revoked && (config.paused ? <button type="button" className={styles.primary} disabled={blocked || unavailable || !resumeConfirmed || !!secret} onClick={() => void mutate("resume")}>{busy === "resume" ? "Resuming…" : "Resume deliveries"}</button> : <button type="button" className={styles.secondary} disabled={blocked} onClick={() => void mutate("pause")}>{busy === "pause" ? "Pausing…" : "Pause deliveries"}</button>)}
            {!config.revoked && <button type="button" className={`${styles.secondary} text-red-700`} disabled={blocked} onClick={() => void mutate("revoke")}>{busy === "revoke" ? "Revoking…" : "Revoke authorization"}</button>}
          </div>
          {config.revoked && <p className="mt-3 text-sm text-slate-600">Save a newly approved configuration below to set up exports again.</p>}
        </section>}

        <section className={styles.panel} aria-labelledby="setup-heading">
          <div className="p-5 md:px-6 border-b border-slate-200"><h2 id="setup-heading" className="font-semibold">{config ? "Edit export configuration" : "Set up daily delivery"}</h2><p className="text-sm text-slate-500 mt-1">Every save requires fresh approval and starts paused.</p></div>
          <form onSubmit={reviewConfiguration} className="p-5 md:p-6 space-y-5">
            <fieldset disabled={blocked || !!secret || review} className="space-y-5 disabled:opacity-60">
              <div><label htmlFor="destination" className="block text-sm font-medium mb-2">HTTPS receiver destination</label><input id="destination" type="url" required placeholder="https://receiver.your-company.com/protractor" className={styles.input} value={draft.destination} onChange={e => setDraft({ ...draft, destination: e.target.value })} /><p className="text-xs text-slate-500 mt-2">Use a receiver you control. Do not embed credentials in the URL.</p></div>
              <fieldset><legend className="text-sm font-medium mb-2">Approved locations <span className="text-slate-500 font-normal">· {draft.shopIds.length} selected</span></legend><p className="text-xs text-slate-500 mb-3">Select each location explicitly. Sibling and future locations are never added automatically.</p>
                {data.shops.length ? <div className="grid grid-cols-1 md:grid-cols-2 gap-2">{data.shops.map(shop => <label key={shop.shopId} className={`flex items-center gap-3 rounded-lg border p-3 text-sm cursor-pointer ${draft.shopIds.includes(shop.shopId) ? "border-blue-300 bg-blue-50" : "border-slate-200"}`}><input type="checkbox" checked={draft.shopIds.includes(shop.shopId)} onChange={e => setDraft({ ...draft, shopIds: e.target.checked ? [...draft.shopIds, shop.shopId] : draft.shopIds.filter(id => id !== shop.shopId) })} /><span>{shop.name}<span className="block text-xs text-slate-500">Shop {shop.shopId}</span></span></label>)}</div> : <p className="rounded-lg border border-dashed border-slate-300 p-5 text-sm text-slate-600">No eligible Protractor locations are available. Ask your administrator to verify your location access and Protractor setup.</p>}
              </fieldset>
              <div className="grid grid-cols-1 md:grid-cols-[2fr_1fr] gap-4"><div><label htmlFor="timezone" className="block text-sm font-medium mb-2">IANA time zone</label><input id="timezone" className={styles.input} value={draft.timeZone} required placeholder="America/Chicago" onChange={e => setDraft({ ...draft, timeZone: e.target.value })} /><p className="text-xs text-slate-500 mt-2">For example, America/Chicago or UTC. Uses local time in this zone.</p></div><div><label htmlFor="daily-time" className="block text-sm font-medium mb-2">Daily delivery time</label><input id="daily-time" className={styles.input} required type="time" step="60" value={draft.dailyTime} onChange={e => setDraft({ ...draft, dailyTime: e.target.value })} /></div></div>
              <label className="flex items-start gap-3 rounded-lg bg-slate-50 border border-slate-200 p-4 text-sm"><input type="checkbox" className="mt-1" checked={draft.initialSnapshot} onChange={e => setDraft({ ...draft, initialSnapshot: e.target.checked })} /><span><span className="font-medium block">Include an initial observed snapshot</span><span className="text-slate-600">Begin with the latest snapshots already observed by MOS for the selected locations. This does not recover missing historical data. Leave unchecked to begin from the new scope baseline.</span></span></label>
              {config && <p className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><strong>Saving replaces the existing approval.</strong> The scope baseline resets, and pending deliveries from the prior revision are cancelled. The replacement configuration is paused until you confirm and resume it.</p>}
              <div className="space-y-3 border-t border-slate-200 pt-4">
                <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" required checked={approved} onChange={e => setApproved(e.target.checked)} /><span>I am authorized to approve redistribution of these locations&apos; Protractor data to this destination.</span></label>
                <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" required checked={contract} onChange={e => setContract(e.target.checked)} /><span>I confirm the receiving party&apos;s contract permits this export, understand the MOS-observed coverage limits and exclusion of DVI, and approve the destination, exact location selection, time zone, daily schedule and initial snapshot choice.</span></label>
              </div>
            </fieldset>
            {!review ? <button type="submit" className={styles.primary} disabled={blocked || !!secret || !data.enabled || !draft.shopIds.length || !approved || !contract}>Review configuration <ArrowUpRight className="inline w-4 h-4 ml-1" /></button> : <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 space-y-3">
              <h3 className="font-semibold">Confirm this exact scope</h3><dl className="text-sm space-y-2"><div><dt className="text-slate-500">Destination</dt><dd className="break-all">{draft.destination}</dd></div><div><dt className="text-slate-500">Locations</dt><dd>{draft.shopIds.map(shopName).join(", ")}</dd></div><div><dt className="text-slate-500">Schedule</dt><dd>Daily at {draft.dailyTime} in {draft.timeZone}</dd></div><div><dt className="text-slate-500">Initial observed snapshot</dt><dd>{draft.initialSnapshot ? "Included" : "Not included — start from new baseline"}</dd></div></dl>
              <p className="text-sm">The configuration will be paused. A new signing secret is returned once for receiver setup.{config ? " Prior-revision pending deliveries will be cancelled and the scope baseline reset." : ""}</p>
              <div className="flex flex-wrap gap-2"><button type="button" className={styles.primary} disabled={blocked || !data.enabled || !!secret} onClick={() => void mutate("configure")}>{busy === "configure" ? "Saving…" : "Approve & save paused"}</button><button type="button" className={styles.secondary} disabled={!!busy} onClick={() => setReview(false)}>Back to editing</button></div>
            </div>}
          </form>
        </section>

        <section className={styles.panel} aria-labelledby="status-heading">
          <div className="p-5 md:px-6 border-b border-slate-200 flex flex-wrap justify-between items-center gap-3"><div><h2 id="status-heading" className="font-semibold">Location delivery status</h2><p className="text-xs text-slate-500 mt-1">Status is loaded on demand; refresh for the latest result.</p></div><button type="button" className={`${styles.secondary} inline-flex items-center gap-2`} disabled={refreshing || !!busy} onClick={() => void load()}><RefreshCw className="w-4 h-4" />{refreshing ? "Refreshing…" : "Refresh status"}</button></div>
          {data.status.length === 0 ? <div className="p-8 text-center"><Clock3 className="w-7 h-7 text-blue-400 mx-auto mb-3" /><h3 className="font-medium">No delivery activity yet</h3><p className="text-sm text-slate-500 mt-1">After receiver setup, resume an approved configuration to begin scheduled exports.</p></div> : <div className="divide-y divide-slate-200">{data.status.map((status, index) => <article key={`${status.shopId}-${index}`} className="p-5 md:px-6">
            <div className="flex flex-wrap justify-between gap-3 items-center"><h3 className="font-semibold text-sm">{shopName(status.shopId)} <span className="font-normal text-slate-500">/ {status.shopId}</span></h3><button type="button" className={styles.secondary} disabled={blocked || unavailable || !config || config.paused || config.revoked || !config.shopIds.includes(status.shopId) || (!status.pendingDeliveryId && !status.failure) || status.failure === "payload_retention_expired"} onClick={() => void mutate("retry", status.shopId)}>{busy === `retry-${status.shopId}` ? "Requesting…" : "Retry collection or delivery"}</button></div>
            <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4 text-sm mt-4"><div><dt className="text-xs text-slate-500 mb-1">Last success</dt><dd>{dateLabel(status.lastSuccess)}</dd></div><div><dt className="text-xs text-slate-500 mb-1">Delivery window</dt><dd className="break-words">{detail(status.window)}</dd></div><div><dt className="text-xs text-slate-500 mb-1">MOS-observed coverage</dt><dd className="break-words">{detail(status.coverage)}</dd></div><div><dt className="text-xs text-slate-500 mb-1">Failure (sanitized)</dt><dd className={status.failure ? "text-red-700" : "text-slate-600"}>{failureLabel(status.failure)}</dd></div><div><dt className="text-xs text-slate-500 mb-1">Pending delivery ID</dt><dd className="font-mono text-xs break-all">{status.pendingDeliveryId || "None"}</dd></div><div><dt className="text-xs text-slate-500 mb-1">Attempts</dt><dd>{status.attempts ?? 0}</dd></div></dl>
          </article>)}</div>}
          <p className="px-5 pb-5 text-xs text-slate-500">Retry requires an active approved configuration and an available worker. Failed collection resumes its existing window and cursor even without a pending delivery. Expired payloads require reconfiguration. Coverage is not proof of complete Protractor history.</p>
        </section>

        <section className={styles.panel} aria-labelledby="history-heading">
          <div className="p-5 md:px-6 border-b border-slate-200"><h2 id="history-heading" className="font-semibold">Accepted delivery history</h2><p className="text-xs text-slate-500 mt-1">Receiver acceptance does not guarantee downstream processing.</p></div>
          {!data.history.length ? <div className="p-8 text-center"><Check className="w-7 h-7 text-slate-400 mx-auto mb-3" /><p className="font-medium">No accepted deliveries yet</p><p className="text-sm text-slate-500 mt-1">Accepted deliveries will appear here with their window and record count.</p></div> : <div className="overflow-x-auto"><table className="w-full text-sm text-left"><thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="p-4 font-medium">Location / Delivery ID</th><th className="p-4 font-medium">Window</th><th className="p-4 font-medium">Accepted</th><th className="p-4 font-medium text-right">Records</th></tr></thead><tbody className="divide-y divide-slate-100">{data.history.map((item, index) => <tr key={`${item.deliveryId}-${index}`}><td className="p-4"><span className="font-medium">{shopName(item.shopId)}</span><span className="block font-mono text-xs text-slate-500 break-all mt-1">{item.deliveryId}</span></td><td className="p-4">{detail(item.window)}</td><td className="p-4">{item.acceptedAt ? dateLabel(item.acceptedAt) : "Not reported"}</td><td className="p-4 text-right tabular-nums">{item.recordCount.toLocaleString()}</td></tr>)}</tbody></table></div>}
        </section>
      </div>
    </div>
  );
}
