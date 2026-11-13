"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { IPP_STATUS_LABELS, type DestinationSettings, type IppStatusView, type LabelKind, type PrintStock, type SavedDestination } from "@/lib/print-queue/ipp-contract";
import { assertMatchingStock, blobToDataUrl, printJson, resolvedDefault, writeBrowserDefault } from "./saved-print-client";
import { isMobilePrintBrowser, openMobilePlaceholderWindow } from "@/lib/print-mobile";

export type PrintChoice = { transport: "browser"; mobileWindow: Window | null } | { transport: "ipp"; destination: SavedDestination; printActionId: string };
const button = "px-3 py-2 rounded-lg border text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50";

export function useSavedPrinting() {
  const cache = useRef<Partial<Record<LabelKind, DestinationSettings>>>({});
  const overrideNext = useRef<Partial<Record<LabelKind, boolean>>>({});
  const browserNext = useRef<Partial<Record<LabelKind, boolean>>>({});
  const [, refreshControls] = useState(0);
  const [settings, setSettings] = useState<DestinationSettings | null>(null);
  const [kind, setKind] = useState<LabelKind | null>(null);
  const [selection, setSelection] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<IppStatusView | null>(null);
  const [sending, setSending] = useState(false);
  const [testMode, setTestMode] = useState(false);
  const [reserveDesktop, setReserveDesktop] = useState(false);
  const resolver = useRef<((choice: PrintChoice | null) => void) | null>(null);
  const locked = useRef(false);
  const alive = useRef(true);
  const action = useRef<string | null>(null);
  const preparingAction = useRef<string | null>(null);
  const dialogElement = useRef<HTMLElement | null>(null);
  const savingRef = useRef(false);
  savingRef.current = saving;
  useEffect(() => { alive.current = true; return () => { alive.current = false; resolver.current?.(null); }; }, []);
  useEffect(() => {
    if (!kind) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => dialogElement.current?.focus());
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && resolver.current && !savingRef.current) {
        event.preventDefault(); finish(null); return;
      }
      if (event.key !== "Tab") return;
      const nodes = Array.from(dialogElement.current?.querySelectorAll<HTMLElement>('button:not([disabled]),select:not([disabled]),a[href]') || []);
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogElement.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogElement.current)) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", onKey);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("keydown", onKey); if (before?.isConnected) before.focus(); };
  }, [kind]);
  useEffect(() => {
    function refresh() {
      for (const labelKind of ["sticker", "keytag"] as const) {
        void printJson<DestinationSettings>(`/api/print/destinations?kind=${labelKind}`).then(data => {
          if (alive.current && data.kind === labelKind && Number.isInteger(data.shopId) && Array.isArray(data.destinations)) {
            cache.current[labelKind] = data;
            refreshControls(value => value + 1);
          }
        }).catch(() => { /* A print must explicitly choose when preferences cannot be verified. */ });
      }
    }
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  async function load(labelKind: LabelKind) {
    setLoading(true); setMessage(""); setSettings(null);
    try {
      const data = await printJson<DestinationSettings>(`/api/print/destinations?kind=${labelKind}`);
      if (!alive.current) return;
      if (data.kind !== labelKind || !Number.isInteger(data.shopId) || !Array.isArray(data.destinations)) throw new Error("Printing settings did not match this shop.");
      setSettings(data); setSelection(resolvedDefault(data) || "");
      cache.current[labelKind] = data;
      refreshControls(value => value + 1);
    } catch (error) { if (alive.current) setMessage(error instanceof Error ? error.message : "Could not load printers."); }
    finally { if (alive.current) setLoading(false); }
  }
  function choose(labelKind: LabelKind, calibration = false, reserveDesktopWindow = false): Promise<PrintChoice | null> {
    if (locked.current) return Promise.resolve(null);
    const cached = cache.current[labelKind];
    const forcePicker = overrideNext.current[labelKind];
    overrideNext.current[labelKind] = false;
    refreshControls(value => value + 1);
    if (!calibration && browserNext.current[labelKind]) {
      browserNext.current[labelKind] = false;
      return Promise.resolve({ transport: "browser", mobileWindow: isMobilePrintBrowser() || reserveDesktopWindow ? openMobilePlaceholderWindow(labelKind) : null });
    }
    if (!calibration && !forcePicker && cached) {
      const id = resolvedDefault(cached);
      const destination = cached.destinations.find(item => item.id === id && item.kind === labelKind);
      if (!id) return Promise.resolve({ transport: "browser", mobileWindow: isMobilePrintBrowser() || reserveDesktopWindow ? openMobilePlaceholderWindow(labelKind) : null });
      if (destination?.online && destination.supported) {
        const printActionId = crypto.randomUUID();
        locked.current = true; preparingAction.current = printActionId;
        return Promise.resolve({ transport: "ipp", destination, printActionId });
      }
      // A stale/offline selection is retained by load(); never choose another
      // destination or Browser Print implicitly.
    }
    locked.current = true;
    setKind(labelKind); setTestMode(calibration); setReserveDesktop(reserveDesktopWindow); setStatus(null); setSending(false); setMessage("");
    void load(labelKind);
    return new Promise(resolve => { resolver.current = resolve; });
  }
  function finish(choice: PrintChoice | null) {
    resolver.current?.(choice); resolver.current = null;
    preparingAction.current = choice?.transport === "ipp" ? choice.printActionId : null;
    setKind(null); locked.current = choice?.transport === "ipp";
  }
  function cancelPreparation() {
    if (preparingAction.current) { preparingAction.current = null; locked.current = false; }
  }
  async function save(shop: boolean) {
    if (!settings || saving) return;
    setSaving(true); setMessage("");
    try {
      if (shop) {
        await printJson(`/api/print/destinations?kind=${settings.kind}`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: settings.kind, destinationId: selection || null }),
        });
        setSettings({ ...settings, defaultDestinationId: selection || null });
        cache.current[settings.kind] = { ...settings, defaultDestinationId: selection || null };
      } else writeBrowserDefault(settings, selection || null);
      refreshControls(value => value + 1);
      setMessage(shop ? "Shop default saved." : "Browser default saved for this shop and label type.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not save default."); }
    finally { setSaving(false); }
  }
  async function submit(choice: PrintChoice, blob: Blob | null, stock: PrintStock, calibration = false) {
    if (choice.transport !== "ipp") return;
    preparingAction.current = null;
    locked.current = true; action.current = choice.printActionId;
    setKind(choice.destination.kind); setSending(true); setStatus(null); setMessage("Preparing saved-printer job…");
    let posted = false;
    try {
      if (!calibration) assertMatchingStock(choice.destination, stock);
      const imageBase64 = blob ? await blobToDataUrl(blob) : undefined;
      posted = true;
      const result = await printJson<{ success: boolean; jobId: string }>(calibration ? "/api/print/test" : "/api/print/enqueue", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(calibration
          ? { kind: choice.destination.kind, destinationId: choice.destination.id, revision: choice.destination.revision, stock, printActionId: choice.printActionId }
          : { transport: "ipp", type: choice.destination.kind, destinationId: choice.destination.id,
            revision: choice.destination.revision, stock, printActionId: choice.printActionId, imageBase64 }),
      });
      if (!result.success || !result.jobId) throw new Error("Queue acknowledgement unavailable");
      setMessage("");
      setStatus({ jobId: result.jobId, destinationId: choice.destination.id, status: "queued" });
      for (let attempt = 0; attempt < 24 && alive.current; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 2500));
        if (!alive.current) return;
        const view = await printJson<IppStatusView>(`/api/print/status?jobId=${encodeURIComponent(result.jobId)}`);
        if (view.jobId !== result.jobId || view.destinationId !== choice.destination.id || !Object.prototype.hasOwnProperty.call(IPP_STATUS_LABELS, view.status)) throw new Error("Print status could not be verified.");
        setStatus(view);
        if (["completed", "failed", "unknown"].includes(view.status)) return;
      }
      setMessage("Status checking stopped. Completion is not confirmed. Check the printer before printing again.");
    } catch (error) {
      setMessage(posted
        ? `Outcome unknown. Check the printer before printing again. No fallback or reprint was attempted. Action: ${action.current}. ${error instanceof Error ? error.message : ""}`
        : error instanceof Error ? error.message : "Could not prepare label. Nothing was sent.");
    } finally { if (alive.current) setSending(false); }
  }
  const selected = settings?.destinations.find(destination => destination.id === selection);
  const unavailable = !!selection && (!selected || !selected.supported || !selected.online);
  const dialog = kind && (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4">
      <section ref={dialogElement} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="saved-print-title" className="max-h-[90dvh] overflow-auto w-full max-w-lg rounded-xl bg-white shadow-xl">
        <div className="border-b px-6 py-4"><h2 id="saved-print-title" className="font-semibold text-gray-900">{resolver.current ? `Print ${kind}` : "Saved printer status"}</h2></div>
        <div className="space-y-4 p-6 text-sm text-gray-700">
          {resolver.current ? <>
            <p>{testMode ? "Print a non-customer calibration label rendered by MOS. Manager permission is required." : "Choose a destination for this print only. Defaults change only when you save them."}</p>
            {loading ? <div role="status" className="h-20 animate-pulse rounded-lg bg-gray-100" aria-label="Loading saved printers" /> : <>
              <label className="block font-medium">One-print override
                <select className="mt-2 w-full rounded-lg border p-2 font-normal" value={selection} onChange={event => setSelection(event.target.value)}>
                  <option value="">Browser Print</option>
                  {selection && !selected && <option value={selection}>Saved selection unavailable — choose explicitly</option>}
                  {settings?.destinations.map(destination => <option key={destination.id} value={destination.id}>{destination.name} · {destination.stock.width / 100} × {destination.stock.height / 100} mm · {destination.supported ? "Supported" : "Unsupported"} · {destination.online ? "Online" : "Offline"}</option>)}
                </select>
              </label>
              {!settings ? <button type="button" className={button} onClick={() => void load(kind)}>Retry printers</button> : <>
                {!settings.destinations.length && <p>No saved printers for this label type. Browser Print and existing TCP controls are still available.</p>}
                <div className="flex flex-wrap gap-2">
                  <button type="button" className={button} disabled={saving || unavailable} onClick={() => void save(false)}>Save browser default</button>
                  <button type="button" className={button} disabled={saving || unavailable || !settings.canManage} title={!settings.canManage ? "Manager permission required" : undefined} onClick={() => void save(true)}>Save shop default</button>
                  <button type="button" className={button} disabled={saving} onClick={() => { try { writeBrowserDefault(settings, undefined); setSelection(settings.defaultDestinationId || ""); setMessage("Browser now uses the shop default."); } catch { setMessage("Browser storage unavailable."); } }}>Use shop default</button>
                </div>
              </>}
              {unavailable && <p role="alert" className="text-amber-700">Selected printer is unavailable. Nothing will be redirected. Select another destination explicitly.</p>}
            </>}
            <Link className="inline-block text-blue-600 underline" href="/dashboard/settings/printing" target="_blank">Printing preferences</Link>
          </> : <>
            {status && <p role="status" className="font-medium">{IPP_STATUS_LABELS[status.status]}{status.error ? ` — ${status.error}` : ""}</p>}
            {status && <p className="break-all text-xs text-gray-500">Job: {status.jobId}</p>}
            <p>No automatic fallback or resubmission. A queued job is not confirmation of a printed label.</p>
          </>}
          {message && <p role="status" className="break-words rounded-lg border bg-gray-50 p-3">{message}</p>}
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t bg-gray-50 px-6 py-4">
          {resolver.current ? <>
            <button type="button" className={button} disabled={saving} onClick={() => finish(null)}>Cancel</button>
            {!testMode && <button type="button" className={button} disabled={saving} onClick={() => finish({ transport: "browser", mobileWindow: isMobilePrintBrowser() || reserveDesktop ? openMobilePlaceholderWindow(kind) : null })}>Browser Print</button>}
            <button type="button" className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50" disabled={loading || saving || !selected || unavailable || (testMode && !settings?.canManage)} onClick={() => { if (selected) finish({ transport: "ipp", destination: selected, printActionId: crypto.randomUUID() }); }}>{testMode ? "Print calibration label" : "Send to saved printer"}</button>
          </> : <button type="button" className={button} disabled={sending} onClick={() => { setKind(null); locked.current = false; }}> {sending ? "Checking status…" : "Close — I will check the printer before reprinting"}</button>}
        </div>
      </section>
    </div>
  );
  function controls(labelKind: LabelKind) {
    const resource = cache.current[labelKind];
    const id = resource ? resolvedDefault(resource) : undefined;
    const destination = resource?.destinations.find(item => item.id === id);
    return <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
      <span>{labelKind === "sticker" ? "Stickers" : "Keytags"}: {resource ? id ? destination ? `${destination.name} · ${destination.stock.width / 100} × ${destination.stock.height / 100} mm · ${destination.supported ? "Supported" : "Unsupported"} · ${destination.online ? "Online" : "Offline"}` : "Saved destination unavailable" : "Browser Print" : "Preferences checked when printing"}</span>
      <button type="button" className="text-blue-600 hover:underline" aria-pressed={!!overrideNext.current[labelKind]} onClick={() => { browserNext.current[labelKind] = false; overrideNext.current[labelKind] = !overrideNext.current[labelKind]; refreshControls(value => value + 1); }}>{overrideNext.current[labelKind] ? "Override ready — click Print (cancel)" : "One-print override"}</button>
      <button type="button" className="text-blue-600 hover:underline" aria-pressed={!!browserNext.current[labelKind]} onClick={() => { overrideNext.current[labelKind] = false; browserNext.current[labelKind] = !browserNext.current[labelKind]; refreshControls(value => value + 1); }}>{browserNext.current[labelKind] ? "Browser Print ready — click Print (cancel)" : "Browser Print"}</button>
      <Link className="text-blue-600 hover:underline" href="/dashboard/settings/printing" target="_blank">Printing preferences</Link>
    </div>;
  }
  return { choose, submit, controls, cancelPreparation, submitTest: (choice: PrintChoice) => choice.transport === "ipp" ? submit(choice, null, choice.destination.stock, true) : Promise.resolve(), dialog };
}
