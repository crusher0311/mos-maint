"use client";

import { useId, useRef, useState } from "react";
import { RefreshCw, Upload, Trash2, AlertTriangle } from "lucide-react";
import { resolveQrBackground } from "@/lib/sticker-qr-appearance";
import type { StickerQrPreferences, useStickerQrAppearance } from "./useStickerQrAppearance";

interface StickerQrAppearanceSettingProps extends StickerQrPreferences {
  onChange: (preferences: StickerQrPreferences) => void;
  background: string;
  included: boolean;
  customQrAvailable: boolean;
  qr: ReturnType<typeof useStickerQrAppearance>;
}

export default function StickerQrAppearanceSetting({
  qrSource,
  qrBackgroundMode,
  onChange,
  background,
  included,
  customQrAvailable,
  qr,
}: StickerQrAppearanceSettingProps) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const resolved = resolveQrBackground(qrBackgroundMode, background);
  const buttonClass = "inline-flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed";

  return (
    <section className="bg-white rounded-xl border border-gray-200 p-6" aria-labelledby={`${id}-title`}>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h2 id={`${id}-title`} className="font-semibold text-gray-900">QR Code Appearance</h2>
        <button type="button" onClick={qr.refresh} disabled={!included || qr.previewLoading || qr.mediaBusy || (qrSource === "custom" && !customQrAvailable)} className={buttonClass}>
          <RefreshCw size={14} />
          {qr.previewLoading ? "Loading preview…" : "Refresh QR"}
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="space-y-4">
          <fieldset disabled={qr.mediaBusy}>
            <legend className="text-sm font-medium text-gray-700 mb-2">QR source</legend>
            <div className="space-y-2">
              <label className="flex items-start gap-2 p-3 border border-gray-200 rounded-lg cursor-pointer">
                <input className="mt-1 text-blue-600 focus:ring-blue-500" type="radio" name={`${id}-source`} value="generated" checked={qrSource === "generated"} onChange={() => onChange({ qrSource: "generated", qrBackgroundMode })} />
                <span className="text-sm text-gray-900">MOS-generated code<span className="block text-gray-500 mt-1">Uses your configured appointment, website, or VHI scan destination.</span></span>
              </label>
              <label className="flex items-start gap-2 p-3 border border-gray-200 rounded-lg cursor-pointer">
                <input className="mt-1 text-blue-600 focus:ring-blue-500" type="radio" name={`${id}-source`} value="custom" checked={qrSource === "custom"} onChange={() => onChange({ qrSource: "custom", qrBackgroundMode })} />
                <span className="text-sm text-gray-900">Uploaded QR code<span className="block text-gray-500 mt-1">The uploaded code controls its destination. MOS appointment and VHI routing do not apply.</span></span>
              </label>
            </div>
          </fieldset>

          <div className="p-3 rounded-lg bg-gray-50 space-y-3">
            <p className="text-sm text-gray-700">{customQrAvailable ? "A custom QR image is uploaded." : "No custom QR image uploaded."}</p>
            <p id={`${id}-upload-help`} className="text-xs text-gray-500">PNG, JPEG, or WebP · up to 500KB · maximum 2048px per side. The image must contain a readable QR code.</p>
            <input ref={inputRef} className="sr-only" type="file" accept="image/png,image/jpeg,image/webp" aria-label={customQrAvailable ? "Replace custom QR image" : "Upload custom QR image"} aria-describedby={`${id}-upload-help`} disabled={qr.mediaBusy} onChange={async event => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              setNotice(null);
              setConfirmRemoval(false);
              if (await qr.upload(file)) setNotice("QR image uploaded. Select Uploaded QR code to use it.");
            }} />
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={qr.mediaBusy} className={buttonClass} onClick={() => inputRef.current?.click()}><Upload size={14} />{qr.mediaBusy ? "Updating image…" : customQrAvailable ? "Replace image" : "Upload image"}</button>
              {customQrAvailable && <button type="button" disabled={qr.mediaBusy} className={buttonClass} onClick={() => { setConfirmRemoval(true); setNotice(null); }}><Trash2 size={14} />Remove</button>}
            </div>
            {confirmRemoval && (
              <div role="group" aria-label="Confirm QR image removal" className="border border-amber-200 rounded-lg bg-amber-50 p-3 space-y-3">
                <p className="text-sm text-amber-900">Remove this image? Uploaded QR remains selected if active. Switch to MOS-generated explicitly to use a generated code.</p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" disabled={qr.mediaBusy} className={buttonClass} onClick={async () => {
                    if (await qr.remove()) {
                      setConfirmRemoval(false);
                      setNotice("QR image removed. Your selected QR source has not changed.");
                    }
                  }}>Remove image</button>
                  <button type="button" disabled={qr.mediaBusy} className={buttonClass} onClick={() => setConfirmRemoval(false)}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="space-y-4">
          <div>
            <label htmlFor={`${id}-background`} className="block text-sm font-medium text-gray-700 mb-1">QR background</label>
            <select id={`${id}-background`} value={qrBackgroundMode} onChange={event => onChange({ qrSource, qrBackgroundMode: event.target.value === "match" ? "match" : "white" })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
              <option value="white">White (recommended)</option>
              <option value="match">Match sticker background</option>
            </select>
            <p className="text-sm text-gray-500 mt-2">Opaque uploaded artwork is never recolored. Only transparent areas can match a safe, light sticker background. Unsafe backgrounds use white to protect scan contrast.</p>
          </div>
          {resolved.warning && <p role="status" className="flex items-start gap-2 text-sm p-3 rounded-lg bg-amber-50 text-amber-800"><AlertTriangle size={16} className="shrink-0 mt-0.5" />{resolved.warning}</p>}
          {!included ? (
            <p className="text-sm text-gray-500 border border-dashed border-gray-300 rounded-lg p-4">QR codes are excluded from this sticker. Enable “Show QR code” in Sticker Options to preview or print one.</p>
          ) : qrSource === "custom" && !customQrAvailable ? (
            <p role="status" className="text-sm text-amber-800 bg-amber-50 rounded-lg p-4">Upload a custom QR image or explicitly select MOS-generated code. No generated code will be substituted.</p>
          ) : qr.previewLoading ? (
            <div role="status" aria-label="Loading QR preview" className="w-28 h-28 rounded-lg bg-gray-100 animate-pulse" />
          ) : qr.qrUrl ? (
            <div className="inline-flex border border-gray-200 rounded-lg p-3" style={{ backgroundColor: resolved.color }}>
              <img src={qr.qrUrl} alt={qrSource === "custom" ? "Uploaded QR preview" : "MOS-generated QR preview"} className="w-28 h-28 object-contain" />
            </div>
          ) : null}
        </div>
      </div>
      {qr.previewError && <div role="alert" className="mt-4 p-3 rounded-lg bg-red-50 text-sm text-red-700 flex flex-wrap items-center justify-between gap-3"><p>{qr.previewError}</p><button type="button" onClick={qr.refresh} className={buttonClass}>Retry preview</button></div>}
      {qr.mediaError && <p role="alert" className="mt-4 p-3 rounded-lg bg-red-50 text-sm text-red-700">{qr.mediaError}</p>}
      {notice && <p role="status" className="mt-4 text-sm text-green-700">{notice}</p>}
    </section>
  );
}
