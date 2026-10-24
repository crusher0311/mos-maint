"use client";

import React from "react";
import type { StickerScanDestination } from "@/lib/sticker-redirect";

export default function StickerScanDestinationSetting({ value, onChange, appfueledVhiQrAvailable = false }: {
  value: StickerScanDestination | "appfueled";
  onChange: (value: StickerScanDestination | "appfueled") => void;
  appfueledVhiQrAvailable?: boolean;
}) {
  return <>
    <label htmlFor="scan-destination" className="block text-sm font-medium text-gray-700 mb-1">QR scan destination</label>
    <select
      id="scan-destination"
      value={value}
      onChange={(e) => {
        const destination = e.target.value as StickerScanDestination | "appfueled";
        if (destination === "appfueled" && !appfueledVhiQrAvailable && value !== "appfueled") return;
        onChange(destination);
      }}
      className="w-full px-3 py-2 border border-gray-300 rounded-lg mb-2"
    >
      <option value="appointment">Appointment booking (default)</option>
      <option value="website">Shop website</option>
      <option value="vhi">Vehicle health report (VHI)</option>
      <option value="appfueled" disabled={!appfueledVhiQrAvailable && value !== "appfueled"}>AppFueled vehicle VHI</option>
    </select>
    <p className="text-sm text-gray-500 mb-3">New stickers stay dynamic after printing. VHI requires a vehicle-specific sticker and maintenance access; otherwise scans open appointment booking, then the shop website. Website scans fall back to booking if no website is set. Older stickers printed with a direct URL cannot be changed.</p>
    <p className="text-sm text-gray-500 mb-3">AppFueled vehicle VHI is separate from the MOS vehicle health report above. It requires an explicit feature grant for this shop and opting in here. Vehicle-specific AppFueled QR stickers cannot print when access is unavailable or the vehicle URL is missing or conflicting. Saved choices and vehicle URL data are retained if access is removed. Uploaded QR images use their own destination and ignore this setting.</p>
    {!appfueledVhiQrAvailable && <p className="text-sm text-gray-500 mb-3">{value === "appfueled" ? "AppFueled VHI QR access is not currently granted. Your saved choice is retained; restore access or choose another destination before printing generated QR stickers." : "AppFueled VHI QR is not enabled for this shop. Ask a platform admin for access before selecting it."}</p>}
  </>;
}
