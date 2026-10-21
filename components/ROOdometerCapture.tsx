"use client";

import { useState } from "react";
import { Camera, CheckCircle } from "lucide-react";
import { convertOdometer, type DistanceUnit, type OdometerCapture } from "./ro-odometer";
import type { useRORecovery } from "./use-ro-recovery";

export function ROOdometerCapture({ recovery, capture, onCapture, onApply }: {
  recovery: ReturnType<typeof useRORecovery>; capture: OdometerCapture | null;
  onCapture: (value: OdometerCapture) => void; onApply: (reading: string, capture: OdometerCapture) => void;
}) {
  const [selectedPhoto, setSelectedPhoto] = useState("");
  const result = capture?.suggestion;
  const sourceUnit = result?.unit === "unknown" ? capture?.selectedUnit : result?.unit;
  const target = recovery.distanceUnit;
  let value: number | null = null;
  let conversionError = "";
  try {
    if (result?.kind === "odometer" && result.reading !== null && sourceUnit && target)
      value = convertOdometer(result.reading, sourceUnit, target);
  } catch (cause) { conversionError = cause instanceof Error ? cause.message : "Reading cannot be converted."; }
  const disabled = !recovery.odometerSupported || !recovery.enabled || !recovery.session?.shared || recovery.busy ||
    recovery.sharedBlocked || !!recovery.session?.payload;
  const confirmationCurrent = capture?.confirmed && capture.confirmed.unit === target &&
    capture.confirmed.sourceUnit === sourceUnit && capture.confirmed.value === value;
  return <section className="rounded-lg border border-gray-200 p-4 space-y-3" aria-label="Odometer photo interpretation">
    <div><h3 className="text-sm font-semibold text-gray-900">Read the odometer from a photo</h3>
      <p className="mt-1 text-xs text-gray-500">Photograph the total odometer, not Trip A or Trip B. The original photo stays in arrival documentation; no inspection finding is created.</p></div>
    <label className={`inline-flex items-center gap-2 border-2 border-dashed rounded-lg px-3 py-2.5 text-sm ${disabled ? "border-gray-200 text-gray-400" : "border-blue-200 text-blue-700 cursor-pointer"}`}>
      <Camera className="w-4 h-4" />{recovery.busy ? "Saving photo / reading odometer" : "Scan odometer photo"}
      <input className="sr-only" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif" capture="environment" disabled={disabled}
        onChange={async event => {
          const file = event.target.files?.[0]; event.target.value = "";
          if (!file) return;
          const scanned = await recovery.scanOdometer(file);
          if (scanned) onCapture({ ...scanned, selectedUnit: scanned.suggestion.unit === "unknown" ? "" : scanned.suggestion.unit, confirmed: null });
        }} />
    </label>
    {!!recovery.session?.shared && recovery.odometerSupported && !!recovery.session.photos.some(photo => photo.serverSaved) &&
      <div className="space-y-2">
        <label className="block text-xs text-gray-600">Use an arrival photo already saved to this draft
          <select value={selectedPhoto || recovery.lastOdometerPhotoId} disabled={disabled}
            onChange={event => setSelectedPhoto(event.target.value)}
            className="mt-1 block w-full border border-gray-300 rounded-lg px-3 py-2 bg-white text-sm">
            <option value="">Choose a saved photo</option>
            {recovery.session.photos.filter(photo => photo.serverSaved).map(photo =>
              <option key={photo.requestId} value={photo.requestId}>{photo.name}</option>)}
          </select>
        </label>
        <button type="button" disabled={disabled || !(selectedPhoto || recovery.lastOdometerPhotoId)}
          onClick={async () => {
            const reading = await recovery.readSavedOdometer(selectedPhoto || recovery.lastOdometerPhotoId);
            if (reading) onCapture({ ...reading, selectedUnit: reading.suggestion.unit === "unknown" ? "" : reading.suggestion.unit, confirmed: null });
          }} className="text-xs font-medium text-blue-700 border border-blue-200 rounded-lg px-3 py-2 disabled:opacity-50">
          Read or recover this exact photo
        </button>
        <p className="text-xs text-gray-500">A lost reading response can be recovered using the same photo ID, without uploading a duplicate image.</p>
      </div>}
    {!recovery.odometerSupported && <p className="text-xs text-gray-500">Photo interpretation is not enabled on this server. You can still enter mileage manually and retain an arrival photo.</p>}
    {recovery.odometerSupported && !recovery.session?.shared && <p className="text-xs text-gray-500">Save this check-in to the server before scanning, so its original photo can travel with the draft.</p>}
    {!target && recovery.odometerSupported && <p className="text-xs text-amber-800">The shop’s odometer unit could not be verified. No suggested reading can be applied until the server supplies that unit.</p>}
    {result && capture && <div className="rounded-lg border border-blue-100 bg-blue-50/50 p-3 space-y-3" aria-live="polite">
      {result.kind !== "odometer" ? <p className="text-sm text-amber-800">{result.kind === "trip" ?
        "This looks like a trip meter, not the total odometer. Your previous mileage is unchanged." :
        "The total odometer is unreadable. No digits were guessed; your previous mileage is unchanged."} Enter mileage manually or take a clearer photo.</p> :
        <>
          <div><p className="text-xs text-gray-500">Suggested total odometer · {result.confidence} confidence</p>
            <p className="text-lg font-semibold text-gray-900">{result.reading?.toLocaleString()} <span className="text-sm font-normal">{result.unit === "unknown" ? "unit not detected" : result.unit}</span></p></div>
          {result.unit === "unknown" && <label className="block text-xs text-gray-700">Confirm the unit shown on the vehicle
            <select className="block w-full border border-gray-300 rounded-lg bg-white px-3 py-2 text-sm mt-1" value={capture.selectedUnit}
              onChange={e => onCapture({ ...capture, selectedUnit: e.target.value as DistanceUnit | "", confirmed: null })}>
              <option value="">Choose miles or kilometers</option><option value="miles">Miles</option><option value="kilometers">Kilometers</option>
            </select></label>}
          {value !== null && <p className="text-xs text-gray-600">Will apply <strong>{value.toLocaleString()} {target}</strong> to this check-in.
            {sourceUnit !== target && <> Converted from {result.reading?.toLocaleString()} {sourceUnit}, rounded to the nearest whole {target === "miles" ? "mile" : "kilometer"}.</>}
            {" "}Check the digits against the original arrival photo before confirming.</p>}
          {conversionError && <p role="alert" className="text-xs text-red-700">{conversionError}</p>}
          {!!capture.confirmed && !confirmationCurrent && <p className="text-xs text-amber-800">The shop unit or conversion changed. Review and confirm the displayed value again; the earlier confirmation will not be applied to a new record.</p>}
          {confirmationCurrent && capture.confirmed ? <p className="flex gap-2 items-center text-xs text-blue-700"><CheckCircle className="w-4 h-4" />Confirmed {capture.confirmed.value.toLocaleString()} {capture.confirmed.unit}. Saved with this draft after the server acknowledges the change.</p> :
            <button type="button" disabled={value === null || disabled} onClick={() => {
              if (value === null || !sourceUnit || !target) return;
              onApply(String(value), { ...capture, confirmed: { value, unit: target, sourceUnit, at: new Date().toISOString() } });
            }} className="text-sm px-3 py-2 bg-blue-600 rounded-lg text-white disabled:opacity-50">Confirm digits and apply {target ?? "reading"}</button>}
          <p className="text-xs text-gray-500">Until you confirm, your current mileage remains unchanged.</p>
        </>}
    </div>}
  </section>;
}
