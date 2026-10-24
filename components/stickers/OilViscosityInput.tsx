"use client";
import { useId } from "react";
import { stickerViscosity } from "@/lib/sticker-viscosity";

export function OilViscosityInput({ value, onChange }: { value: string; onChange(value: string): void }) {
  const id = useId();
  return <div className="space-y-1">
    <label htmlFor={id} className="block text-sm font-medium text-gray-700">Oil viscosity (optional)</label>
    <div className="flex gap-2">
      <input id={id} list={`${id}-grades`} maxLength={24} value={value}
        onChange={e => onChange(e.target.value.replace(/[^a-zA-Z0-9 \-]/g, "").slice(0, 24))}
        onBlur={() => onChange(stickerViscosity.normalize(value) ?? "")}
        placeholder="Choose or enter, e.g. 5W-30" className="w-full px-3 py-2 border rounded-lg" />
      <button type="button" onClick={() => onChange("")} className="text-sm underline">Clear</button>
    </div>
    <datalist id={`${id}-grades`}>{stickerViscosity.common.map(grade => <option key={grade} value={grade} />)}</datalist>
    <p className="text-xs text-gray-500">Print only. Requires an Oil viscosity element in the sticker layout.</p>
  </div>;
}
