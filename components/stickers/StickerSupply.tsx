"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

interface Supply {
  enabled: boolean;
  capacity: number;
  threshold: number;
  used: number;
  revision: string;
  low: boolean;
}

type SupplyResponse = { supply: Supply | null; canManage: boolean };
type SupplyWrite =
  | { operation: "configure"; enabled: boolean; capacity: number; threshold: number; revision: string | null }
  | { operation: "reset"; revision: string };

function isSupplyResponse(value: unknown): value is SupplyResponse {
  if (!value || typeof value !== "object") return false;
  const data = value as SupplyResponse;
  if (typeof data.canManage !== "boolean") return false;
  if (data.supply === null) return true;
  const supply = data.supply;
  return !!supply && typeof supply.enabled === "boolean" &&
    typeof supply.low === "boolean" && typeof supply.revision === "string" &&
    Number.isSafeInteger(supply.capacity) && supply.capacity > 0 &&
    Number.isSafeInteger(supply.threshold) && supply.threshold >= 0 &&
    supply.threshold <= supply.capacity &&
    Number.isSafeInteger(supply.used) && supply.used >= 0;
}

export function StickerSupply({ manage = false }: { manage?: boolean }) {
  const id = useId();
  const [data, setData] = useState<SupplyResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [capacity, setCapacity] = useState("");
  const [threshold, setThreshold] = useState("");
  const [pending, setPending] = useState<SupplyWrite | null>(null);
  const [loadedRoll, setLoadedRoll] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const dirty = useRef(false);
  const draftRevision = useRef<string | null>(null);
  const mounted = useRef(false);
  const writing = useRef(false);
  const controller = useRef<AbortController | null>(null);

  const refresh = useCallback(async (resetDraft = false) => {
    if (writing.current || document.visibilityState === "hidden") return;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    try {
      const response = await fetch("/api/sticker/supply", {
        credentials: "include", cache: "no-store", signal: request.signal,
      });
      if (!response.ok) throw new Error("Supply unavailable");
      const result: unknown = await response.json();
      if (!isSupplyResponse(result)) throw new Error("Invalid supply response");
      if (!mounted.current || request.signal.aborted) return;
      setData(result);
      setUnavailable(false);
      if (resetDraft || !dirty.current) {
        draftRevision.current = result.supply?.revision ?? null;
        setEnabled(result.supply?.enabled ?? false);
        setCapacity(result.supply ? String(result.supply.capacity) : "");
        setThreshold(result.supply ? String(result.supply.threshold) : "");
        dirty.current = false;
      }
    } catch {
      if (!mounted.current || request.signal.aborted) return;
      setUnavailable(true);
    } finally {
      if (mounted.current && !request.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
      else controller.current?.abort();
    };
    const onFocus = () => { void refresh(); };
    const timer = window.setInterval(() => { void refresh(); }, 30_000);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    window.addEventListener("sticker-supply-refresh", onFocus);
    return () => {
      mounted.current = false;
      controller.current?.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("sticker-supply-refresh", onFocus);
    };
  }, [refresh]);

  const supply = data?.supply;
  const allowed = manage && data?.canManage === true && !unavailable && !loading;
  const busy = saving || pending !== null;
  const defaultThreshold = Math.ceil(Number(capacity) * 0.95);

  function prepareConfiguration() {
    if (!allowed || busy) return;
    const nextCapacity = Number(capacity);
    const nextThreshold = threshold.trim() === "" ? defaultThreshold : Number(threshold);
    if (!Number.isSafeInteger(nextCapacity) || nextCapacity < 1 ||
      !Number.isSafeInteger(nextThreshold) || nextThreshold < 1 || nextThreshold > nextCapacity) {
      setMessage("Enter a whole-number capacity of at least 1 and a low-stock threshold between 1 and capacity.");
      return;
    }
    setMessage(null);
    setPending({
      operation: "configure", enabled, capacity: nextCapacity,
      threshold: nextThreshold, revision: draftRevision.current,
    });
  }

  async function save() {
    if (!pending || !allowed || writing.current ||
      (pending.operation === "reset" && !loadedRoll)) return;
    writing.current = true;
    controller.current?.abort();
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch("/api/sticker/supply", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pending),
      });
      if (!mounted.current) return;
      if (response.status === 409) {
        setMessage("This roll estimate changed elsewhere. The latest data has been requested. Review it and confirm again.");
        setPending(null);
        setLoadedRoll(false);
        writing.current = false;
        await refresh(true);
        return;
      }
      if (!response.ok) {
        if (response.status === 403) {
          setData(current => current ? { ...current, canManage: false } : current);
          throw new Error("You no longer have permission to manage this roll estimate.");
        }
        throw new Error("Could not save the roll estimate. Refresh and review the latest data before trying again.");
      }
      setPending(null);
      setLoadedRoll(false);
      dirty.current = false;
      writing.current = false;
      await refresh(true);
      if (mounted.current) setMessage("Roll estimate saved.");
    } catch (error) {
      if (mounted.current) {
        setMessage(error instanceof Error ? error.message : "Could not save the roll estimate.");
        setPending(null);
        setUnavailable(true);
      }
    } finally {
      writing.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  return (
    <section aria-labelledby={`${id}-title`} className="bg-white rounded-xl border border-gray-200 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`${id}-title`} className="font-semibold text-gray-900">Sticker roll estimate</h2>
        <button type="button" onClick={() => { void refresh(); }} disabled={saving || loading}
          className="inline-flex items-center gap-1 text-sm text-[#3c81c3] hover:underline disabled:opacity-50">
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </button>
      </div>
      <p className="mt-1 text-xs text-gray-500">
        One shared roll estimate for this shop, across all users and printers. Browser printing and PDF downloads cannot confirm physical consumption.
      </p>
      {loading ? (
        <div role="status" aria-label="Loading roll estimate" className="mt-4 space-y-2 animate-pulse">
          <div className="h-4 w-40 bg-gray-100 rounded" /><div className="h-3 w-64 max-w-full bg-gray-100 rounded" />
        </div>
      ) : unavailable ? (
        <p role="status" className="mt-3 text-sm text-amber-800">Roll estimate unavailable. This does not mean zero usage. Use Refresh to retry.</p>
      ) : supply?.enabled ? (
        <div className="mt-3">
          <p className="text-sm text-gray-900">
            Estimated used: <span className="font-semibold tabular-nums">{supply.used.toLocaleString()} / {supply.capacity.toLocaleString()}</span> stickers
          </p>
          <p className="mt-1 text-xs text-gray-500">Low-stock notice starts at {supply.threshold.toLocaleString()} estimated used.</p>
        </div>
      ) : <p className="mt-3 text-sm text-gray-600">Roll tracking is off. No roll estimate is being maintained.</p>}
      {supply?.enabled && supply.low && (
        <div role="status" className="mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p><strong>Sticker roll may be running low.</strong> Check the physical roll before loading more stickers.{unavailable ? " This is the last known status; the current estimate is unavailable." : ""}</p>
        </div>
      )}
      {manage && !loading && (
        <div className="mt-4 border-t border-gray-100 pt-4">
          {!data?.canManage && !unavailable && <p className="mb-3 text-xs text-gray-500">Only shop owners, admins, and platform admins can manage this estimate.</p>}
          <fieldset disabled={!allowed || busy} className="space-y-3 disabled:opacity-60">
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={enabled} onChange={event => { dirty.current = true; setEnabled(event.target.checked); }}
                className="rounded border-gray-300 text-[#3c81c3] focus:ring-[#3c81c3]" />
              Enable shared roll tracking (opt-in)
            </label>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="text-sm text-gray-700">
                Roll capacity (stickers)
                <input type="number" min="1" step="1" value={capacity}
                  onChange={event => { dirty.current = true; setCapacity(event.target.value); }}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:ring-2 focus:ring-[#3c81c3]" />
              </label>
              <label className="text-sm text-gray-700">
                Low-stock threshold (estimated used)
                <input type="number" min="1" max={capacity || undefined} step="1" value={threshold}
                  placeholder={Number(capacity) > 0 ? String(defaultThreshold) : "Defaults to 95% of capacity"}
                  onChange={event => { dirty.current = true; setThreshold(event.target.value); }}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:ring-2 focus:ring-[#3c81c3]" />
              </label>
            </div>
            <p className="text-xs text-gray-500">Enabling initializes the estimate from now, not from historical prints. Leave the threshold blank to use 95% of capacity, rounded up.</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={prepareConfiguration}
                className="rounded-lg bg-[#3c81c3] px-3 py-2 text-sm font-medium text-white hover:bg-[#3270aa] disabled:opacity-50">
                Review configuration
              </button>
              {supply?.enabled && <button type="button" onClick={() => {
                setMessage(null); setLoadedRoll(false); setPending({ operation: "reset", revision: supply.revision });
              }} className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
                New roll / reset estimate
              </button>}
            </div>
          </fieldset>
          {pending && (
            <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-gray-800">
              {pending.operation === "reset" ? (
                <>
                  <p className="font-medium">Reset the shared estimate to zero?</p>
                  <p className="mt-1 text-xs">Only reset after replacing the physical roll. This affects the entire shop.</p>
                  <label className="mt-3 flex items-center gap-2">
                    <input type="checkbox" checked={loadedRoll} disabled={saving}
                      onChange={event => setLoadedRoll(event.target.checked)} className="rounded border-gray-300 text-[#3c81c3]" />
                    New roll loaded
                  </label>
                </>
              ) : (
                <>
                  <p className="font-medium">{pending.enabled ? (!supply?.enabled ? "Initialize the shared roll estimate from now?" : "Update the shared roll configuration?") : "Turn off shared roll tracking?"}</p>
                  <p className="mt-1 text-xs">Capacity: {pending.capacity.toLocaleString()} stickers. Low-stock threshold: {pending.threshold.toLocaleString()} estimated used. {!supply?.enabled && pending.enabled ? "Past printing will not be counted." : "This applies to the whole shop."}</p>
                </>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" onClick={() => { void save(); }}
                  disabled={!allowed || saving || (pending.operation === "reset" && !loadedRoll)}
                  className="rounded-lg bg-[#3c81c3] px-3 py-2 text-sm font-medium text-white disabled:opacity-50">
                  {saving ? "Saving…" : pending.operation === "reset" ? "Confirm new roll and reset" : "Confirm configuration"}
                </button>
                <button type="button" disabled={saving} onClick={() => { setPending(null); setLoadedRoll(false); }}
                  className="rounded-lg border border-gray-300 px-3 py-2 text-sm hover:bg-white disabled:opacity-50">Cancel</button>
              </div>
            </div>
          )}
          {message && <p role="status" className="mt-3 text-sm text-gray-700">{message}</p>}
        </div>
      )}
    </section>
  );
}

export default StickerSupply;
