"use client";
import { useLayoutEffect, useRef } from "react";
import { StickerElement } from "@/lib/sticker-designer-types";
import { paintStickerText } from "@/lib/sticker-text-painter";

export function StickerTextPreview({ element, text }: { element: StickerElement; text: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const scale = 3;
    canvas.width = Math.ceil(element.width * scale);
    canvas.height = Math.ceil(element.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(scale, scale);
    paintStickerText(ctx, text, element);
  }, [element, text]);
  return <canvas ref={ref} aria-label={text} role="img" style={{ width: "100%", height: "100%", display: "block", pointerEvents: "none" }} />;
}
