"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { DestinationSettings, LabelKind } from "@/lib/print-queue/ipp-contract";
import { printJson, readBrowserDefault, resolvedDefault, writeBrowserDefault } from "./saved-print-client";
import { useSavedPrinting } from "./useSavedPrinting";

const button = "rounded-lg border px-3 py-2 text-sm font-medium hover:bg-gray-50 disabled:opacity-50";

function PreferencesCard({ kind }: { kind: LabelKind }) {
  const [settings, setSettings] = useState<DestinationSettings | null>(null);
  const [selection, setSelection] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const printing = useSavedPrinting();
  async function load() {
    setLoading(true); setMessage("");
    try {
      const data = await printJson<DestinationSettings>(`/api/print/destinations?kind=${kind}`);
      if (data.kind !== kind || !Number.isInteger(data.shopId)) throw new Error("Printing settings did not match this shop.");
      setSettings(data); setSelection(resolvedDefault(data) || "");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not load destinations."); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [kind]); // Label kind is the resource identity.
  async function save(shop: boolean) {
    if (!settings || busy) return;
    setBusy(true); setMessage("");
    try {
      if (shop) {
        await printJson(`/api/print/destinations?kind=${kind}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, destinationId: selection || null }) });
        setSettings({ ...settings, defaultDestinationId: selection || null });
      } else writeBrowserDefault(settings, selection || null);
      setMessage(shop ? "Shop default saved." : "Browser default saved for this shop.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not save preferences."); }
    finally { setBusy(false); }
  }
  async function test() {
    if (busy) return;
    setBusy(true); setMessage("");
    try {
      const choice = await printing.choose(kind, true);
      if (!choice) return;
      await printing.submitTest(choice);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not print test label."); }
    finally { setBusy(false); }
  }
  const selected = settings?.destinations.find(item => item.id === selection);
  const unavailable = !!selection && (!selected || !selected.online || !selected.supported);
  const nameFor = (id: string | null | undefined) => id === undefined ? "Use shop default" : id === null ? "Browser Print" : settings?.destinations.find(item => item.id === id)?.name || "Unavailable saved destination";
  return <section className="rounded-xl border border-gray-200 bg-white">
    <div className="border-b px-6 py-4"><h2 className="text-lg font-semibold text-gray-900">{kind === "sticker" ? "Oil stickers" : "Keytags"}</h2></div>
    <div className="space-y-4 p-6">
      {loading ? <div role="status" aria-label="Loading printing preferences" className="h-24 animate-pulse rounded-lg bg-gray-100" /> : settings ? <>
        <p className="text-sm text-gray-500">Shop default: {nameFor(settings.defaultDestinationId)}<br />This browser: {nameFor(readBrowserDefault(settings))}</p>
        <label className="block text-sm font-medium text-gray-700">Default destination
          <select value={selection} onChange={event => setSelection(event.target.value)} className="mt-2 w-full rounded-lg border bg-white p-2">
            <option value="">Browser Print</option>
            {selection && !selected && <option value={selection}>Unavailable saved destination</option>}
            {settings.destinations.map(item => <option key={item.id} value={item.id}>{item.name} · {item.stock.width / 100} × {item.stock.height / 100} mm · {item.supported ? "Supported" : "Unsupported"} · {item.online ? "Online" : "Offline"}</option>)}
          </select>
        </label>
        {!settings.destinations.length && <p className="rounded-lg bg-gray-50 p-4 text-sm text-gray-600">No saved {kind} printers are available for this shop. Connect a supported printer using the shop print agent, or use Browser Print.</p>}
        {selected && <p className="text-sm text-gray-600">{selected.model} · Stock {selected.stock.width / 100} × {selected.stock.height / 100} mm · {selected.supported ? "Supported" : "Unsupported"} · {selected.online ? "Online" : "Offline"}</p>}
        {unavailable && <p role="alert" className="text-sm text-amber-700">This selection is unavailable. Printing never redirects to a different destination automatically.</p>}
        <div className="flex flex-wrap gap-2">
          <button type="button" className={button} disabled={busy || unavailable} onClick={() => void save(false)}>Save browser default</button>
          <button type="button" className={button} disabled={busy || unavailable || !settings.canManage} onClick={() => void save(true)}>Save shop default</button>
          <button type="button" className={button} disabled={busy} onClick={() => { try { writeBrowserDefault(settings, undefined); setSelection(settings.defaultDestinationId || ""); setMessage("Browser override removed."); } catch { setMessage("Browser storage unavailable."); } }}>Use shop default</button>
          <button type="button" className={button} disabled={busy || !settings.canManage} title={!settings.canManage ? "Manager permission required" : "Print a non-customer calibration label"} onClick={() => void test()}>Print test label</button>
        </div>
        {!settings.canManage && <p className="text-xs text-gray-500">Only managers can change the shop default. Browser preferences affect only this browser.</p>}
      </> : <button type="button" className={button} onClick={() => void load()}>Retry printing preferences</button>}
      {message && <p role="status" className="rounded-lg border bg-gray-50 p-3 text-sm">{message}</p>}
    </div>
    {printing.dialog}
  </section>;
}

export default function PrintingPreferences() {
  return <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6">
    <div><h1 className="text-2xl font-bold text-gray-900">Printing preferences</h1><p className="mt-2 text-sm text-gray-600">Set separate defaults for stickers and keytags. One-print overrides never change your defaults.</p></div>
    <PreferencesCard kind="sticker" />
    <PreferencesCard kind="keytag" />
    <div className="rounded-xl border bg-gray-50 p-5 text-sm text-gray-600"><p>Browser Print always remains available. Existing TCP printing is unchanged. Saved IPP jobs are never automatically retried or sent to a different printer when an outcome is unknown.</p><Link href="/dashboard/settings/stickers" className="mt-3 inline-block text-blue-600 underline">Sticker rendering settings</Link><span className="mx-3">·</span><Link href="/dashboard/settings/keytags" className="text-blue-600 underline">Keytag rendering settings</Link></div>
  </div>;
}
