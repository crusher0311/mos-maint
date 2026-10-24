"use client";
import { useEffect, useState } from "react";
import { validStickerColor } from "@/lib/sticker-colors";

export function StickerTextColorInput({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const valid = validStickerColor(draft);
  return <div className="min-w-0 flex-1">
    <input
      type="text"
      aria-label="Text color value"
      aria-invalid={!valid}
      value={draft}
      onChange={e => {
        const next = e.target.value;
        setDraft(next);
        if (validStickerColor(next)) onChange(next);
      }}
      maxLength={100}
      className="w-full px-2 py-1 text-sm border rounded"
    />
    {!valid && <p role="alert" className="text-xs text-red-600 mt-1">Use a color name, hex, RGB or HSL color. The last valid color is kept.</p>}
  </div>;
}
