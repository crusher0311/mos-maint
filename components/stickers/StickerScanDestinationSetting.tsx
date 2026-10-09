"use client";

import React from "react";
import type { StickerScanDestination } from "@/lib/sticker-redirect";

export default function StickerScanDestinationSetting({ value, onChange }: {
  value: StickerScanDestination;
  onChange: (value: StickerScanDestination) => void;
}) {
  return <>
    <label htmlFor="scan-destination" className="block text-sm font-medium text-gray-700 mb-1">QR scan destination</label>
    <select
      id="scan-destination"
      value={value}
      onChange={(e) => onChange(e.target.value as StickerScanDestination)}
      className="w-full px-3 py-2 border border-gray-300 rounded-lg mb-2"
    >
      <option value="appointment">Appointment booking (default)</option>
      <option value="website">Shop website</option>
      <option value="vhi">Vehicle health report (VHI)</option>
    </select>
    <p className="text-sm text-gray-500 mb-3">New stickers stay dynamic after printing. VHI requires a vehicle-specific sticker and maintenance access; otherwise scans open appointment booking, then the shop website. Website scans fall back to booking if no website is set. Older stickers printed with a direct URL cannot be changed.</p>
  </>;
}
