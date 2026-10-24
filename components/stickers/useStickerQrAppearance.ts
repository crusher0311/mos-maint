"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type StickerQrSource = "generated" | "custom";
export type StickerQrBackgroundMode = "white" | "match";

export interface StickerQrPreferences {
  qrSource: StickerQrSource;
  qrBackgroundMode: StickerQrBackgroundMode;
}

export const DEFAULT_QR_PREFERENCES: StickerQrPreferences = {
  qrSource: "generated",
  qrBackgroundMode: "white",
};

export function normalizeStickerQrPreferences(
  config: Partial<StickerQrPreferences> | null | undefined,
): StickerQrPreferences {
  return {
    qrSource: config?.qrSource === "custom" ? "custom" : "generated",
    qrBackgroundMode: config?.qrBackgroundMode === "match" ? "match" : "white",
  };
}

async function responseError(response: Response, fallback: string) {
  const body = await response.json().catch(() => null);
  return new Error(typeof body?.error === "string" ? body.error : fallback);
}

async function readUpload(file: File): Promise<string> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    throw new Error("Choose a PNG, JPEG, or WebP image.");
  }
  if (file.size > 500 * 1024) {
    throw new Error("The QR image must be 500KB or smaller.");
  }
  const objectUrl = URL.createObjectURL(file);
  try {
    await new Promise<void>((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        if (image.naturalWidth > 2048 || image.naturalHeight > 2048) {
          reject(new Error("The QR image must be no larger than 2048px on either side."));
        } else if (!image.naturalWidth || !image.naturalHeight) {
          reject(new Error("This image could not be read."));
        } else {
          resolve();
        }
      };
      image.onerror = () => reject(new Error("This image could not be read. Choose a valid PNG, JPEG, or WebP."));
      image.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string" || !result.includes(",")) {
        reject(new Error("This image could not be read."));
        return;
      }
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(new Error("This image could not be read."));
    reader.readAsDataURL(file);
  });
}

/**
 * The page owns preferences so both save paths serialize the same config.
 * Upload/removal deliberately never change qrSource.
 * Availability comes from the TOP-LEVEL settings response, not its config.
 */
export function useStickerQrAppearance({
  qrSource,
  qrBackgroundMode,
  background,
  included,
  ready,
  customQrAvailable,
  onCustomQrAvailableChange,
}: StickerQrPreferences & {
  background: string;
  included: boolean;
  ready: boolean;
  customQrAvailable: boolean;
  onCustomQrAvailableChange: (available: boolean) => void;
}) {
  const [preview, setPreview] = useState<{ key: string; url: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [mediaBusy, setMediaBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const previewController = useRef<AbortController | null>(null);
  const mediaController = useRef<AbortController | null>(null);
  const urlRef = useRef<string | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const availabilityCallback = useRef(onCustomQrAvailableChange);
  availabilityCallback.current = onCustomQrAvailableChange;

  const query = new URLSearchParams({
    source: qrSource,
    backgroundMode: qrBackgroundMode,
    background,
  }).toString();
  const requestKey = `${query}:${included}:${customQrAvailable}:${ready}:${revision}`;
  const keyRef = useRef(requestKey);
  keyRef.current = requestKey;

  const clearPreview = useCallback(() => {
    generation.current += 1;
    previewController.current?.abort();
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    setPreview(null);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
      previewController.current?.abort();
      mediaController.current?.abort();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
  }, []);

  useEffect(() => {
    clearPreview();
    setPreviewError(null);
    setPreviewLoading(false);
    if (!ready || !included || (qrSource === "custom" && !customQrAvailable)) return;

    const controller = new AbortController();
    previewController.current = controller;
    const requestGeneration = generation.current;
    const isCurrent = () =>
      !controller.signal.aborted &&
      generation.current === requestGeneration &&
      keyRef.current === requestKey;
    setPreviewLoading(true);
    void (async () => {
      try {
        const response = await fetch(`/api/sticker/qr-cache?${query}`, {
          credentials: "include",
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw await responseError(response,
          qrSource === "custom" ? "The uploaded QR image is unavailable. Upload it again or switch to the generated code." : "Could not load the generated QR preview.");
        const blob = await response.blob();
        if (!isCurrent()) return;
        if (blob.type !== "image/png") throw new Error("The QR preview did not return a PNG image. Please retry.");
        const url = URL.createObjectURL(blob);
        urlRef.current = url;
        setPreview({ key: requestKey, url });
      } catch (error) {
        if (isCurrent()) setPreviewError(error instanceof Error ? error.message : "Could not load the QR preview.");
      } finally {
        if (isCurrent()) setPreviewLoading(false);
      }
    })();
    return () => controller.abort();
  }, [requestKey, query, qrSource, customQrAvailable, included, ready, clearPreview]);

  const refresh = useCallback(() => {
    clearPreview();
    setRevision(value => value + 1);
  }, [clearPreview]);

  const mutateMedia = useCallback(async (file?: File) => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setMediaBusy(true);
    setMediaError(null);
    const controller = new AbortController();
    mediaController.current = controller;
    try {
      const base64Data = file ? await readUpload(file) : undefined;
      if (controller.signal.aborted) return false;
      const response = await fetch("/api/sticker/custom-qr", {
        method: file ? "POST" : "DELETE",
        credentials: "include",
        signal: controller.signal,
        ...(file ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contentType: file.type, base64Data }),
        } : {}),
      });
      if (!response.ok) throw await responseError(response,
        file ? "The image could not be uploaded. It must contain a readable QR code." : "The QR image could not be removed.");
      if (file) {
        const result = await response.json();
        if (result.success !== true) throw new Error("The QR upload was not confirmed. Please retry.");
      }
      if (!mounted.current || controller.signal.aborted) return false;
      // Invalidate in-flight results before notifying the page.
      clearPreview();
      availabilityCallback.current(Boolean(file));
      setRevision(value => value + 1);
      return true;
    } catch (error) {
      if (mounted.current && !controller.signal.aborted) {
        setMediaError(error instanceof Error ? error.message : "Could not update the QR image.");
      }
      return false;
    } finally {
      busyRef.current = false;
      if (mounted.current) setMediaBusy(false);
    }
  }, [clearPreview]);

  return {
    // Gate by key during render too: an old generated code must never flash
    // while an effect is waiting to run after switching to custom.
    qrUrl: included && ready && preview?.key === requestKey ? preview.url : undefined,
    previewLoading,
    previewError,
    mediaError,
    mediaBusy,
    refresh,
    upload: (file: File) => mutateMedia(file),
    remove: () => mutateMedia(),
  };
}
