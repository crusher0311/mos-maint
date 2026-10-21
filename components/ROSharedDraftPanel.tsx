"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Cloud, CloudOff, Monitor, Smartphone, RefreshCw, ShieldCheck } from "lucide-react";
import { handoffHref } from "./ro-shared-draft-client";
import type { useRORecovery } from "./use-ro-recovery";
import { ROCoworkerTransfer } from "./ROCoworkerTransfer";

type Recovery = ReturnType<typeof useRORecovery>;
export function ROSharedDraftPanel({ recovery, fields, onResume }: {
  recovery: Recovery; fields: string; onResume: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [qr, setQr] = useState("");
  const [qrError, setQrError] = useState("");
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const id = recovery.session?.shared?.id;
  const synced = !!id && recovery.sharedStatus === "saved";
  const photoCount = recovery.session?.photos.filter(p => p.serverSaved).length ?? 0;
  useEffect(() => {
    let alive = true;
    setQr(""); setQrError("");
    if (id && expanded && synced) {
      void QRCode.toDataURL(handoffHref(window.location.origin, id), { width: 224, margin: 2, errorCorrectionLevel: "M",
        color: { dark: "#1e3a5f", light: "#f8fafc" } })
        .then(url => { if (alive) setQr(url); })
        .catch(() => { if (alive) setQrError("QR could not be generated. Use the signed-in link instead."); });
    }
    return () => { alive = false; };
  }, [id, expanded, synced]);
  const canResume = !!recovery.serverDraft && (!recovery.localDraftExists ||
    recovery.session?.handoffRequestId === recovery.serverDraft.id);
  const pending = !!recovery.session?.payload || !!recovery.session?.pendingCreates?.contact || !!recovery.session?.pendingCreates?.vehicle;
  if (!recovery.enabled) return null;
  if (!recovery.sharedSupported) return <section className="mx-4 sm:mx-6 my-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2" aria-label="Device handoff">
    <p className="text-xs text-gray-600 flex items-center gap-2"><Monitor className="w-4 h-4 shrink-0" />This check-in is saved on this browser only.</p>
    <p className="text-xs text-gray-500 mt-1">Phone handoff is unavailable until authenticated server drafts are enabled. Do not switch devices to recover a pending creation.</p>
  </section>;
  return <section className={`mx-4 sm:mx-6 my-3 rounded-lg border shrink-0 max-h-[45dvh] overflow-y-auto ${recovery.sharedBlocked ? "border-amber-200 bg-amber-50" : "border-blue-100 bg-blue-50/60"}`} aria-label="Check-in device handoff">
    <div className="p-3 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
          {synced ? <Cloud className="w-4 h-4 text-blue-600 shrink-0" /> : <CloudOff className="w-4 h-4 text-amber-700 shrink-0" />}
          {recovery.sharedBlocked ? "Resume before editing" : synced ? "Check-in saved to server" :
            recovery.sharedStatus === "saving" ? "Saving check-in to server" : id ? "Changes are not synchronized" : "One check-in. Either device."}
        </h3>
        <p className="text-xs text-gray-600 mt-1" role="status" aria-live="polite">
          {recovery.sharedBlocked ? recovery.serverDraft?.transfer
            ? "Editing is paused for a coworker transfer. Open Device handoff to review it."
            : canResume
              ? "A saved check-in is waiting. Resume it on this device to unlock the fields; this does not create another ticket."
              : "Editing is paused to protect saved work. Open Device handoff to review the check-in before continuing."
            : synced ? `Details and ${photoCount} arrival ${photoCount === 1 ? "photo" : "photos"} confirmed. No customer, vehicle or RO is created by switching devices.` :
            id ? "Your device copy is retained. Save and confirm before switching devices." :
              "Save this guided check-in, then capture vehicle details on your phone and continue here."}
        </p>
        {recovery.sharedBlocked && canResume && !recovery.serverDraft?.transfer && <button
          type="button" disabled={recovery.busy} onClick={onResume}
          className="mt-2 min-h-11 rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white disabled:opacity-50 inline-flex items-center gap-2">
          <Monitor className="w-4 h-4" />Resume on this device
        </button>}
      </div>
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(v => !v)} className="text-xs font-medium text-blue-700 py-1 shrink-0">
        {expanded ? "Hide handoff" : "Device handoff"}
      </button>
    </div>
    {expanded && <div className="border-t border-blue-100 p-3 space-y-3">
      {id && <ROCoworkerTransfer recovery={recovery} fields={fields}/>}
      {!!recovery.serverDraft && <div className="rounded-lg bg-white/70 border border-blue-100 p-3">
        <p className="text-sm font-medium text-gray-800">Resume your server check-in on this device</p>
        <p className="text-xs text-gray-600 mt-1">This explicitly transfers editing to this device. The other device must resume again before changing or creating anything.</p>
        {!canResume && <p className="text-xs text-amber-800 mt-2">A different local draft is retained. Resolve or explicitly discard it first; it will not be overwritten.</p>}
        <div className="flex flex-wrap gap-3 mt-3">
          <button type="button" disabled={recovery.busy || !canResume} onClick={onResume}
            className="rounded-lg bg-blue-600 text-white text-xs font-medium px-3 py-2 disabled:opacity-50 inline-flex items-center gap-2">
            <Monitor className="w-4 h-4" />Resume server check-in here
          </button>
          <button type="button" disabled={recovery.busy} onClick={() => void recovery.refreshSharedDraft()}
            className="text-xs text-blue-700 inline-flex items-center gap-1 disabled:opacity-50"><RefreshCw className="w-3 h-3" />Refresh availability</button>
        </div>
      </div>}
      {!recovery.sharedBlocked && !pending && <button type="button" disabled={recovery.busy || !recovery.ready || recovery.needsResume}
        onClick={() => void recovery.shareDraft(fields)}
        className="rounded-lg border border-blue-200 bg-white px-3 py-2 text-xs font-medium text-blue-700 disabled:opacity-50 inline-flex items-center gap-2">
        <Cloud className="w-4 h-4" />{id ? "Save details and retry unsynced photos" : recovery.localDraftExists ? "Move this local draft to server" : "Save check-in to server"}
      </button>}
      {!id && pending && <p className="text-xs text-amber-800">This device has a retained native request. Resolve it using its existing recovery controls before moving to a shared draft.</p>}
      {synced && !recovery.sharedBlocked && <div className="flex flex-col sm:flex-row gap-4 items-start">
        <div className="shrink-0 rounded-lg border border-blue-100 bg-slate-50 p-1">
          {qr ? <img src={qr} alt="QR link to this check-in. Sign in with the same shop and advisor to continue." width={160} height={160} /> :
            qrError ? <p className="w-40 p-3 text-xs text-red-700">{qrError}</p> :
              <div className="w-40 h-40 bg-blue-100/60 animate-pulse rounded" aria-label="Preparing QR code" />}
        </div>
        <div className="space-y-2">
          <h4 className="text-sm font-semibold text-gray-900 flex items-center gap-2"><Smartphone className="w-4 h-4" />Continue on phone</h4>
          <ol className="text-xs text-gray-600 list-decimal pl-4 space-y-1">
            <li>Scan and sign in with the same advisor account and shop.</li>
            <li>Choose “Resume server check-in here”.</li>
            <li>Capture VIN, mileage and arrival photos in the same guided check-in.</li>
            <li>Back on desktop, refresh and resume this server check-in.</li>
          </ol>
          <button type="button" onClick={async () => {
            if (!id) return; setCopyError("");
            try { await navigator.clipboard.writeText(handoffHref(window.location.origin, id)); setCopied(true); }
            catch { setCopyError("Copy is unavailable. Open the signed-in link below and copy its address."); }
          }} className="text-xs text-blue-700 font-medium">{copied ? "Link copied" : "Copy signed-in link"}</button>
          <a className="block text-xs text-blue-700 underline" href={handoffHref(typeof window === "undefined" ? "" : window.location.origin, id!)}>Open this check-in</a>
          {copyError && <p role="alert" className="text-xs text-amber-800">{copyError}</p>}
        </div>
      </div>}
      <p className="text-xs text-gray-500 flex gap-2 items-start"><ShieldCheck className="w-3.5 h-3.5 shrink-0 mt-0.5" />The link contains only a draft ID. It does not sign anyone in or grant access. Unconfirmed device-only photos do not travel with the link.</p>
    </div>}
  </section>;
}

export function VehicleArrivalCapture({ vin, mileage, vinConfirmed, mileageConfirmed, onVinChange, onMileageChange,
  onVinConfirm, onMileageConfirm }: {
  vin: string; mileage: string; vinConfirmed: boolean; mileageConfirmed: boolean;
  onVinChange: (value: string) => void; onMileageChange: (value: string) => void;
  onVinConfirm: (value: boolean) => void; onMileageConfirm: (value: boolean) => void;
}) {
  const validVin = /^[A-HJ-NPR-Z0-9]{17}$/.test(vin);
  const validMileage = /^\d{1,7}$/.test(mileage) && Number(mileage) <= 9_999_999;
  return <section className="border border-blue-100 bg-blue-50/50 rounded-lg p-4 space-y-3" aria-label="Manual arrival capture">
    <div><h3 className="text-sm font-semibold text-gray-900">At the vehicle</h3>
      <p className="text-xs text-gray-500 mt-1">Read the VIN and odometer yourself, then confirm them. Camera photos are supporting evidence, not automatic readings.</p></div>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div><label htmlFor="arrival-manual-vin" className="block text-xs font-medium text-gray-700 mb-1">VIN · 17 characters</label>
        <input id="arrival-manual-vin" autoCapitalize="characters" autoCorrect="off" spellCheck={false} maxLength={17}
          value={vin} onChange={e => onVinChange(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono" />
        <label className="mt-2 flex items-start gap-2 text-xs text-gray-600"><input type="checkbox" checked={vinConfirmed}
          disabled={!validVin} onChange={e => onVinConfirm(e.target.checked)} />I checked this VIN on the vehicle.</label>
        {!!vin && !validVin && <p className="text-xs text-amber-800 mt-1">Use 17 VIN characters; I, O and Q are not valid.</p>}
      </div>
      <div><label htmlFor="arrival-manual-mileage" className="block text-xs font-medium text-gray-700 mb-1">Odometer reading</label>
        <input id="arrival-manual-mileage" inputMode="numeric" pattern="[0-9]*" maxLength={7} value={mileage}
          onChange={e => onMileageChange(e.target.value.replace(/\D/g, ""))}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        <label className="mt-2 flex items-start gap-2 text-xs text-gray-600"><input type="checkbox" checked={mileageConfirmed}
          disabled={!validMileage} onChange={e => onMileageConfirm(e.target.checked)} />I checked this reading on the odometer.</label>
        <p className="text-xs text-gray-500 mt-1">Use the shop’s configured distance unit.</p>
      </div>
    </div>
  </section>;
}
