"use client";

import { useEffect, useState } from "react";
import type { QrArtworkGeometry } from "@/lib/sticker-qr-sizing";

export function useQrArtworkGeometry(url?: string) {
  const [result, setResult] = useState<{ url: string; geometry: QrArtworkGeometry | null } | null>(null);
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    const image = new Image();
    image.crossOrigin = "anonymous";
    const finish = (geometry: QrArtworkGeometry | null) => {
      if (!cancelled) setResult({ url, geometry });
    };
    image.onerror = () => finish(null);
    image.onload = async () => {
      try {
        // Bound CPU/memory on legacy or remote images; never modify the source.
        const scale = Math.min(1, 2048 / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) return finish(null);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const { inspectQrPixels } = await import("@/lib/sticker-qr-sizing");
        if (!cancelled) finish(inspectQrPixels(pixels.data, canvas.width, canvas.height));
      } catch {
        finish(null); // CORS/load/decode failures must not imply a safe size.
      }
    };
    image.src = url;
    return () => { cancelled = true; image.onload = null; image.onerror = null; };
  }, [url]);
  return result && result.url === url ? result.geometry : null;
}
