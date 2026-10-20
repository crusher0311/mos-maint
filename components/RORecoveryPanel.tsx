"use client";
import { useEffect, useState } from "react";
import type { ArrivalPhoto } from "./ro-session-store";
import type { useRORecovery } from "./use-ro-recovery";

type Recovery = ReturnType<typeof useRORecovery>;
export function ArrivalPreview({ photo }: { photo: ArrivalPhoto }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const value = URL.createObjectURL(photo.blob); setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [photo.blob]);
  return <img src={url || undefined} alt={`Arrival documentation: ${photo.name}`} className="w-full h-24 object-cover rounded-lg" />;
}
export function ArrivalPhotoPicker({ recovery }: { recovery: Recovery }) {
  return <section className="border border-gray-200 rounded-lg p-4 space-y-3" aria-label="Arrival documentation">
    <div><h3 className="text-sm font-semibold text-gray-900">Arrival photos <span className="font-normal text-gray-500">· optional</span></h3>
      <p className="text-xs text-gray-500 mt-1">Document the vehicle as it arrived. These photos are not inspection ratings or checklist evidence. Up to 12 photos, 4 MB each.</p></div>
    {!recovery.enabled && <p className="text-xs text-gray-500">Arrival photo uploads require DVI access. Repair order creation is still available normally.</p>}
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
      {(["camera", "upload"] as const).map(source => <label key={source} className="text-gray-700">{source === "camera" ? "Capture arrival photo" : "Upload arrival photo"}
        <input className="block w-full text-xs mt-1" type="file" accept="image/jpeg,image/png,image/webp" capture={source === "camera" ? "environment" : undefined}
          disabled={!recovery.enabled || !recovery.ready || recovery.busy || !!recovery.session?.payload} onChange={event => {
            const file = event.target.files?.[0]; event.target.value = ""; if (file) void recovery.addPhoto(file);
          }} /></label>)}
    </div>
    {!!recovery.session?.photos.length && <ul className="grid grid-cols-2 sm:grid-cols-3 gap-3">{recovery.session.photos.map(photo => <li key={photo.requestId}>
      <ArrivalPreview photo={photo} /><span className="block text-xs text-gray-500 truncate">{photo.name}</span>
      <button className="text-xs text-red-600 mt-1" disabled={recovery.busy} onClick={() => void recovery.removePhoto(photo.requestId)}>Remove arrival photo</button>
    </li>)}</ul>}
  </section>;
}
export function RORecoveryPanel({ recovery, onClose }: { recovery: Recovery; onClose: () => void }) {
  const value = recovery.session;
  const result = value?.result;
  const remaining = value?.photos.filter(photo => !photo.uploaded).length ?? 0;
  return <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="ro-recovery-title">
    <section className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90dvh] overflow-y-auto p-6 space-y-5">
      <div className="flex items-start justify-between gap-4"><div><p className="text-xs uppercase tracking-wider text-blue-600 mb-2">Protractor repair order</p>
        <h2 id="ro-recovery-title" className="text-xl font-semibold text-gray-900">{result ? `RO #${result.workOrderNumber} confirmed` : "Verify the original creation request"}</h2></div>
        <button className="text-sm text-gray-500" onClick={onClose}>Close</button></div>
      <p className="text-sm text-gray-600">{result ? "The official repair order is saved. Arrival documentation and DVI are separate steps; retrying them never creates another RO." :
        "The original details and request ID are safely retained. A lost or incomplete response is not proof of failure. Verification only checks this request; it never sends a new provider write."}</p>
      {value?.payload && <p className="text-xs text-gray-500 break-all">Request {JSON.parse(value.payload).clientRequestId}</p>}
      {recovery.busy && <div role="status" aria-busy="true" className="rounded-lg bg-gray-100 p-4 text-sm text-gray-600">Waiting for confirmation. You can close this window; the original request is retained.</div>}
      {recovery.error && <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 p-3 rounded-lg">{recovery.error}</p>}
      {!!value?.photos.length && <section><h3 className="text-sm font-semibold text-gray-900 mb-3">Arrival documentation · {remaining ? `${remaining} awaiting upload` : "saved"}</h3>
        <ul className="grid grid-cols-2 sm:grid-cols-3 gap-3">{value.photos.map(photo => <li key={photo.requestId}><ArrivalPreview photo={photo} />
          <span className="block text-xs text-gray-500 mt-1">{photo.uploaded ? "Upload confirmed" : "Retained on this device"}</span></li>)}</ul>
        <p className="text-xs text-gray-500 mt-2">Arrival photos do not evaluate any inspection checklist item.</p></section>}
      {!!result?.packagesWithoutLines.length && <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
        <strong>Some jobs need parts or labor lines in Protractor</strong><ul className="list-disc pl-5 mt-2">{result.packagesWithoutLines.map((job, index) =>
          <li key={index}>{job.title}{job.code ? ` (${job.code})` : ""}</li>)}</ul><p className="mt-2">These were created as $0 headers. Open this RO in Protractor and add the lines manually.</p></div>}
      <div className="flex flex-wrap gap-3">
        {!result && <button className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm disabled:opacity-50" disabled={recovery.busy || !recovery.ready} onClick={() => void recovery.verify()}>Verify creation</button>}
        {result && remaining > 0 && <button className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm disabled:opacity-50" disabled={recovery.busy || !recovery.ready || !recovery.enabled} onClick={() => void recovery.retryPhotos()}>Retry arrival uploads only</button>}
        {result && !remaining && recovery.enabled && <button className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm disabled:opacity-50" disabled={recovery.busy || !recovery.ready} onClick={() => void recovery.continueDvi()}>Continue to DVI</button>}
        {result && !remaining && <button className="px-4 py-2 rounded-lg border border-gray-200 text-gray-700 text-sm disabled:opacity-50" disabled={recovery.busy || !recovery.ready} onClick={async () => { if (await recovery.finish()) onClose(); }}>Done</button>}
        {result && remaining > 0 && !recovery.enabled && <button className="px-4 py-2 rounded-lg border border-gray-200 text-gray-700 text-sm" disabled={recovery.busy} onClick={onClose}>Done · keep photos for later</button>}
      </div>
      <p className="text-xs text-gray-500">Kept on this browser until completion. Do not clear site data while creation or uploads are unconfirmed. Closing does not discard the original request.</p>
    </section>
  </div>;
}
