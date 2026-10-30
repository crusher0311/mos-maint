"use client";

import React, { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { Clock3, RefreshCw, ShieldCheck } from "lucide-react";
import {
  historyRequest, HistoryRequestError, needsExpansionConfirmation, statusLabel, validateConfig,
  type HistoryConfig, type HistoryShop, type HistorySnapshot, type ShopAction,
} from "./history-client";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const inputClass = "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 disabled:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-[#3c81c3]";
const buttonClass = "inline-flex items-center justify-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50";
const primaryClass = "inline-flex items-center justify-center rounded-lg bg-[#3c81c3] px-4 py-2 text-sm font-medium text-white hover:bg-[#326da5] disabled:cursor-not-allowed disabled:opacity-50";

export default function ProtractorHistoryClient() {
  const [snapshot, setSnapshot] = useState<HistorySnapshot | null>(null);
  const [draft, setDraft] = useState<HistoryConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [hoursConfirmed, setHoursConfirmed] = useState(false);
  const [timezoneConfirmed, setTimezoneConfirmed] = useState(false);
  const [expansionConfirmed, setExpansionConfirmed] = useState(false);
  const [pendingAction, setPendingAction] = useState<{ shop: HistoryShop; action: ShopAction } | null>(null);
  const [query, setQuery] = useState("");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const lock = useRef(false);
  const mounted = useRef(true);

  const refresh = useCallback(async (replaceDraft = false) => {
    const data = await historyRequest("GET") as HistorySnapshot;
    if (!mounted.current) return;
    setSnapshot(data);
    setUpdatedAt(new Date().toLocaleTimeString());
    if (replaceDraft) {
      setDraft(structuredClone(data.config));
      setHoursConfirmed(false);
      setTimezoneConfirmed(false);
      setExpansionConfirmed(false);
      setConflict(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh(true).catch(() => {
      if (mounted.current) setError("Unable to load Protractor history. Check your connection or try again when the history API is available.");
    }).finally(() => { if (mounted.current) setLoading(false); });
    return () => { mounted.current = false; };
  }, [refresh]);

  function change(patch: Partial<HistoryConfig>) {
    setDraft(current => current ? { ...current, ...patch } : current);
    setHoursConfirmed(false);
    setTimezoneConfirmed(false);
    setExpansionConfirmed(false);
    setNotice(null);
  }

  async function reload(replaceDraft: boolean) {
    if (lock.current) return;
    if (replaceDraft && draft && snapshot && JSON.stringify(draft) !== JSON.stringify(snapshot.config) &&
      !window.confirm("Discard your unsaved changes and load the latest configuration?")) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try { await refresh(replaceDraft); }
    catch { setError("Unable to refresh. Existing information may be stale. Try again before making changes."); }
    finally { lock.current = false; setBusy(false); setLoading(false); }
  }

  async function mutate(method: "PUT" | "POST", body: unknown) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    setPendingAction(null);
    try {
      await historyRequest(method, body);
      setNotice(method === "PUT" ? "Configuration saved. Eligible shops will be scheduled only outside business hours." :
        "Action accepted for scheduling. No direct provider call was made.");
      try { await refresh(method === "PUT"); }
      catch { setError("The request was accepted, but fresh status could not be loaded. Refresh before another action."); setConflict(true); }
    } catch (caught) {
      if (caught instanceof HistoryRequestError && caught.status === 409) {
        setConflict(true);
        setError("Configuration changed on the server. Your draft is preserved. Reload the latest configuration, review it, and confirm again. Nothing was retried.");
        try { await refresh(false); } catch { /* Explicit reload remains available. */ }
      } else {
        // The write may have reached the server. Do not automatically repeat it.
        setError(caught instanceof HistoryRequestError
          ? "The server rejected this request. Review the configuration and refresh status before trying again."
          : "The request outcome is uncertain. Reload status before trying again; the action was not automatically retried.");
        setConflict(true);
      }
    } finally { lock.current = false; setBusy(false); }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || !snapshot || busy || conflict) return;
    const validation = validateConfig(draft);
    if (validation) { setError(validation); return; }
    if (!hoursConfirmed || (draft.defaultTimezone && !timezoneConfirmed) ||
      (needsExpansionConfirmation(snapshot.config, draft) && !expansionConfirmed)) {
      setError("Review and complete the confirmations before saving.");
      return;
    }
    void mutate("PUT", { config: draft, confirmedHours: true });
  }

  const dirty = !!draft && !!snapshot && JSON.stringify(draft) !== JSON.stringify(snapshot.config);
  const expansion = !!draft && !!snapshot && needsExpansionConfirmation(snapshot.config, draft);
  const visibleShops = snapshot?.shops.filter(shop => shop.name.toLowerCase().includes(query.toLowerCase())) || [];
  const activeShop = snapshot?.shops.find(shop => shop.shopId === snapshot.runtime.shopId);
  const scoped = !!draft?.rolloutShopIds.length;
  const unknownSelections = draft?.rolloutShopIds.filter(id => !snapshot?.shops.some(shop => shop.shopId === id)) || [];

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 text-gray-900 sm:p-6 lg:p-8">
      <header className="flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
        <div>
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-[#3c81c3]"><Clock3 className="h-4 w-4" /> Protractor operations</div>
          <h1 className="text-2xl font-bold">Historical sync</h1>
          <p className="mt-1 max-w-2xl text-sm text-gray-600">Routine overnight history for connected shops. No agent or scripts required.</p>
        </div>
        <nav aria-label="Protractor operations" className="flex flex-wrap items-center gap-3 text-sm">
          <Link href="/platform-admin/sync-health" className="font-medium text-[#3c81c3] hover:underline">Sync health</Link>
          <Link href="/platform-admin/protractor-operator-stop" className="font-medium text-[#3c81c3] hover:underline">Operator stop</Link>
          <button type="button" className={buttonClass} disabled={busy || loading} onClick={() => void reload(false)}><RefreshCw className="h-4 w-4" /> Refresh status</button>
        </nav>
      </header>

      {error && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
        <p>{error}</p>
        <button type="button" className={`${buttonClass} mt-3`} disabled={busy} onClick={() => void reload(conflict || !draft)}>
          {conflict ? "Reload latest configuration" : "Retry status"}
        </button>
      </div>}
      {notice && <p role="status" className="rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-800">{notice}</p>}

      {loading ? <div role="status" aria-label="Loading historical sync" className="animate-pulse space-y-5">
        <div className="h-24 rounded-xl bg-gray-200" /><div className="h-96 rounded-xl bg-gray-200" />
      </div> : snapshot && draft ? <>
        <section aria-label="Current runtime" className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="rounded-lg bg-[rgba(60,129,195,0.12)] p-2 text-[#3c81c3]"><ShieldCheck className="h-5 w-5" /></div>
              <div><h2 className="font-semibold">{snapshot.runtime.active ? "History worker active" : "History worker idle"}</h2>
                <p className="mt-1 text-sm text-gray-600">{snapshot.runtime.active ? (activeShop?.name || "Connected shop") : "Waiting for eligible, off-hours work."}</p>
                <p className="mt-1 text-xs text-gray-500">Last outcome: {statusLabel(snapshot.runtime.lastOutcome)}</p>
              </div>
            </div>
            <div className="text-right text-xs text-gray-500">
              <span className={`inline-block rounded-full px-3 py-1 font-medium ${snapshot.config.enabled ? "bg-green-100 text-green-800" : "bg-slate-100 text-slate-700"}`}>{snapshot.config.enabled ? "Scheduling enabled" : "Scheduling disabled"}</span>
              <p className="mt-2">Status checked {updatedAt}. Refresh for latest.</p>
            </div>
          </div>
        </section>

        <form onSubmit={save} className="space-y-6">
          <fieldset disabled={busy || conflict} className="min-w-0 space-y-6">
            <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm sm:p-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div><h2 className="text-lg font-semibold">Scheduling policy</h2><p className="mt-1 text-sm text-gray-600">Saved policy controls future work. Disabled by default; opening this page starts nothing.</p></div>
                <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={draft.enabled} onChange={e => change({ enabled: e.target.checked })} className="h-4 w-4 accent-[#3c81c3]" /> Enable historical sync</label>
              </div>
              <div className="mt-6 grid gap-5 md:grid-cols-2">
                <label className="space-y-2 text-sm font-medium">Shops per tick
                  <select className={inputClass} value={draft.maxShopsPerTick} onChange={e => change({ maxShopsPerTick: Number(e.target.value) })}>
                    {[1, 2, 3].map(value => <option key={value} value={value}>{value} {value === 1 ? "shop" : "shops"}</option>)}
                  </select>
                </label>
                <label className="space-y-2 text-sm font-medium">History horizon
                  <select className={inputClass} value={draft.horizonYears} onChange={e => change({ horizonYears: Number(e.target.value) })}>
                    {[1, 2, 3, 4, 5].map(value => <option key={value} value={value}>{value} {value === 1 ? "year" : "years"}</option>)}
                  </select>
                </label>
              </div>
            </section>

            <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm sm:p-6">
              <h2 className="text-lg font-semibold">Business hours & timezone</h2>
              <p className="mt-1 text-sm text-gray-600">Enter business hours, not sync hours. History runs only outside this schedule in each shop’s local timezone. Closed means no business hours that day.</p>
              <div className="mt-5 space-y-2">
                {[...draft.week].sort((a, b) => a.day - b.day).map(row => <div key={row.day} className="grid grid-cols-2 items-center gap-3 rounded-lg bg-gray-50 p-3 md:grid-cols-[7rem_1fr_1fr_6rem]">
                  <span className="text-sm font-medium">{DAYS[row.day]}</span>
                  <label className="col-start-2 row-start-1 flex items-center justify-end gap-2 text-sm md:col-start-4"><input type="checkbox" checked={row.closed} onChange={e => change({ week: draft.week.map(day => day.day === row.day ? { ...day, closed: e.target.checked } : day) })} className="accent-[#3c81c3]" /> Closed</label>
                  <label className="text-xs text-gray-500 md:col-start-2 md:row-start-1">Opens<input aria-label={`${DAYS[row.day]} opens`} type="time" disabled={row.closed} value={row.open} className={inputClass} onChange={e => change({ week: draft.week.map(day => day.day === row.day ? { ...day, open: e.target.value } : day) })} /></label>
                  <label className="text-xs text-gray-500 md:col-start-3 md:row-start-1">Closes<input aria-label={`${DAYS[row.day]} closes`} type="time" disabled={row.closed} value={row.close} className={inputClass} onChange={e => change({ week: draft.week.map(day => day.day === row.day ? { ...day, close: e.target.value } : day) })} /></label>
                </div>)}
              </div>
              <div className="mt-5 max-w-xl">
                <label className="text-sm font-medium" htmlFor="fallback-timezone">Fallback timezone (optional)</label>
                <input id="fallback-timezone" type="text" autoComplete="off" placeholder="America/Chicago" value={draft.defaultTimezone || ""} className={`${inputClass} mt-2`} onChange={e => change({ defaultTimezone: e.target.value.trim() || null })} />
                <p className="mt-2 text-xs text-gray-500">Shop timezone always takes precedence. Without a known shop timezone or confirmed fallback, that shop is blocked. Missing hours also block scheduling.</p>
              </div>
            </section>

            <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm sm:p-6">
              <h2 className="text-lg font-semibold">Rollout scope</h2>
              <p className="mt-1 text-sm text-gray-600">Zero rollout IDs means fleetwide: all eligible connected shops, including future eligible connections. It does not mean no shops.</p>
              <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:gap-6">
                <label className="flex items-center gap-2 text-sm"><input type="radio" name="scope" checked={!scoped} onChange={() => { if (scoped && window.confirm("Clear the selected rollout and target all eligible connected shops? Saving will still require confirmation.")) change({ rolloutShopIds: [] }); }} /> All eligible connected shops</label>
                <label className="flex items-center gap-2 text-sm"><input type="radio" name="scope" checked={scoped} disabled={!scoped && !snapshot.shops.length} onChange={() => { if (!scoped && snapshot.shops[0]) change({ rolloutShopIds: [snapshot.shops[0].shopId] }); }} /> Selected shops only</label>
              </div>
              {scoped && <div className="mt-4 max-h-64 space-y-2 overflow-y-auto rounded-lg border border-gray-200 p-3">
                {snapshot.shops.map(shop => <label key={shop.shopId} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={draft.rolloutShopIds.includes(shop.shopId)} disabled={draft.rolloutShopIds.length === 1 && draft.rolloutShopIds.includes(shop.shopId)} onChange={e => change({ rolloutShopIds: e.target.checked ? [...draft.rolloutShopIds, shop.shopId] : draft.rolloutShopIds.filter(id => id !== shop.shopId) })} className="accent-[#3c81c3]" />{shop.name}
                </label>)}
                {unknownSelections.length > 0 && <p className="text-xs text-amber-800">{unknownSelections.length} unavailable shop selection(s) retained. Select fleetwide explicitly to clear them.</p>}
                <p className="pt-2 text-xs text-gray-500">At least one selection is required for a scoped rollout.</p>
              </div>}
            </section>

            <section className="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">
              <h2 className="font-semibold">Review before saving</h2>
              <label className="flex items-start gap-2"><input className="mt-1 accent-[#3c81c3]" type="checkbox" checked={hoursConfirmed} onChange={e => setHoursConfirmed(e.target.checked)} />I confirm the seven-day business-hours schedule is correct and history must not run during business hours.</label>
              {draft.defaultTimezone && <label className="flex items-start gap-2"><input className="mt-1 accent-[#3c81c3]" type="checkbox" checked={timezoneConfirmed} onChange={e => setTimezoneConfirmed(e.target.checked)} />I explicitly confirm {draft.defaultTimezone} as the fallback for shops without a known timezone.</label>}
              {expansion && <label className="flex items-start gap-2"><input className="mt-1 accent-[#3c81c3]" type="checkbox" checked={expansionConfirmed} onChange={e => setExpansionConfirmed(e.target.checked)} />I confirm enabling or expanding history scheduling for {scoped ? `${draft.rolloutShopIds.length} selected shop(s)` : "ALL eligible connected shops, including future connections"}.</label>}
            </section>
          </fieldset>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-gray-500">{conflict ? "Reload required before further changes." : dirty ? "Unsaved changes. Nothing has been scheduled from this draft." : "No unsaved changes."}</p>
            <div className="flex gap-2">
              <button type="button" className={buttonClass} disabled={busy || (!dirty && !conflict)} onClick={() => void reload(true)}>Reload configuration</button>
              <button type="submit" className={primaryClass} disabled={busy || conflict || !dirty || !hoursConfirmed || (!!draft.defaultTimezone && !timezoneConfirmed) || (expansion && !expansionConfirmed)}>{busy ? "Saving / refreshing…" : "Save configuration"}</button>
            </div>
          </div>
        </form>

        <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="flex flex-col justify-between gap-4 md:flex-row md:items-center">
            <div><h2 className="text-lg font-semibold">Shop status</h2><p className="mt-1 text-sm text-gray-600">Read-only worker status. Actions only enqueue or schedule; they never call the provider directly.</p></div>
            <label className="text-xs text-gray-500">Find a shop<input type="search" className={`${inputClass} mt-1`} value={query} onChange={e => setQuery(e.target.value)} placeholder="Search by name" /></label>
          </div>
          <p className="mt-4 rounded-lg bg-slate-50 p-3 text-xs leading-relaxed text-slate-600">Pause gracefully stops new requests; it does not cancel settled writes. Retry preserves history and cursors. Queue, resume, and retry still respect business hours, rollout, missing hours/timezone, disabled scheduling, emergency stop, and retry backoff.</p>
          {pendingAction && <div role="region" aria-label="Confirm shop action" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4">
            <p className="text-sm font-medium">Confirm {pendingAction.action} for {pendingAction.shop.name}?</p>
            <p className="mt-1 text-xs text-gray-600">{pendingAction.action === "pause" ? "New requests will stop gracefully; settled writes will remain." : "This schedules work only. All safety and off-hours gates remain in force."}</p>
            <div className="mt-3 flex gap-2"><button type="button" className={primaryClass} disabled={busy || conflict} onClick={() => void mutate("POST", { shopId: pendingAction.shop.shopId, action: pendingAction.action })}>Confirm {pendingAction.action}</button><button type="button" className={buttonClass} onClick={() => setPendingAction(null)}>Cancel</button></div>
          </div>}
          {!visibleShops.length ? <div className="py-12 text-center"><h3 className="font-medium">{snapshot.shops.length ? "No matching shops" : "No connected shops reported"}</h3><p className="mt-1 text-sm text-gray-500">{snapshot.shops.length ? "Try another shop name." : "Connected eligible shops will appear here when reported by the history service."}</p></div> :
            <ul className="mt-4 divide-y divide-gray-100">{visibleShops.map(shop => <li key={shop.shopId} className="flex flex-col justify-between gap-3 py-4 lg:flex-row lg:items-center">
              <div><h3 className="text-sm font-semibold">{shop.name}</h3><p className="mt-1 text-sm text-gray-600">{statusLabel(shop.status)} · {statusLabel(shop.reason)}</p>
                {shop.paused && <span className="mr-2 text-xs font-medium text-amber-800">Paused</span>}
                {shop.completed && <span className="text-xs font-medium text-green-800">History complete</span>}
                {shop.lastError && <p className="mt-1 text-xs text-red-700">Last attempt reported an error. Review restricted server diagnostics before retrying.</p>}
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={buttonClass} disabled={busy || conflict} onClick={() => setPendingAction({ shop, action: shop.paused ? "resume" : "pause" })}>{shop.paused ? "Resume" : "Pause"}</button>
                <button type="button" className={buttonClass} disabled={busy || conflict || shop.completed || shop.status === "running" || shop.status === "queued"} onClick={() => setPendingAction({ shop, action: "queue" })}>Queue</button>
                <button type="button" className={buttonClass} disabled={busy || conflict || (!shop.lastError && !["retry_backoff", "failed", "error"].includes(shop.status))} onClick={() => setPendingAction({ shop, action: "retry" })}>Retry</button>
              </div>
            </li>)}</ul>}
        </section>
      </> : !error && <p className="rounded-xl border border-gray-200 p-6 text-sm text-gray-600">History configuration is unavailable. Refresh status to try again.</p>}
    </div>
  );
}
