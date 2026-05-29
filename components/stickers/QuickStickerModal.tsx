"use client";

import { useState, useEffect } from "react";
import { X, Loader2, Printer, Wifi, Check, AlertCircle } from "lucide-react";
import {
  DEFAULT_INTERVALS,
  getVisibleOilTypes,
  resolveOilTypeLabel,
  type IntervalsConfig,
} from "@/lib/sticker-defaults";

type UnitType = "mi" | "km" | "hrs";

const UNIT_OPTIONS: { value: UnitType; label: string }[] = [
  { value: "mi", label: "Miles" },
  { value: "km", label: "Kilometers" },
  { value: "hrs", label: "Hours" },
];

interface QuickStickerModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function QuickStickerModal({ isOpen, onClose }: QuickStickerModalProps) {
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [currentMileage, setCurrentMileage] = useState<string>("");
  const [intervalType, setIntervalType] = useState<string>("synthetic");
  const [customMonths, setCustomMonths] = useState<number>(6);
  const [customMileage, setCustomMileage] = useState<string>("5000");
  const [stickerSize, setStickerSize] = useState<string>("2x2.5");
  const [unit, setUnit] = useState<UnitType>("mi");
  const [roundMileage, setRoundMileage] = useState(true);
  const [intervals, setIntervals] = useState<IntervalsConfig>(DEFAULT_INTERVALS);
  const [error, setError] = useState<string | null>(null);
  // ZINK "send to shop printer" — only offered once a printer is configured.
  const [zinkConfigured, setZinkConfigured] = useState(false);
  const [zinkOnline, setZinkOnline] = useState(false);
  const [zinkStatus, setZinkStatus] = useState<"idle" | "queuing" | "queued" | "error">("idle");

  useEffect(() => {
    if (isOpen) {
      fetchSettings();
      checkZink();
      setZinkStatus("idle");
    }
  }, [isOpen]);

  async function checkZink() {
    try {
      const res = await fetch("/api/print/enqueue");
      if (!res.ok) {
        setZinkConfigured(false);
        return;
      }
      const data = await res.json();
      setZinkConfigured(Boolean(data?.configured));
      setZinkOnline(Boolean(data?.agentOnline));
    } catch {
      setZinkConfigured(false);
    }
  }

  async function fetchSettings() {
    setLoading(true);
    try {
      const res = await fetch("/api/sticker/settings");
      if (res.ok) {
        const data = await res.json();
        if (data.config) {
          setUnit(data.config.useKilometers ? "km" : "mi");
          setRoundMileage(data.config.roundMileage ?? true);
          setStickerSize(data.config.defaultSize ?? "2x2.5");
          if (data.config.intervals) {
            setIntervals({
              diesel: data.config.intervals.diesel ?? DEFAULT_INTERVALS.diesel,
              euro: data.config.intervals.euro ?? DEFAULT_INTERVALS.euro,
              synthetic: data.config.intervals.synthetic ?? DEFAULT_INTERVALS.synthetic,
              conventional: data.config.intervals.conventional ?? DEFAULT_INTERVALS.conventional,
            });
          }
        }
      }
    } catch (err) {
      console.error("Failed to fetch sticker settings:", err);
    } finally {
      setLoading(false);
    }
  }

  function calculateServiceValues(): { nextServiceMileage: number; nextServiceDate: string } {
    const mileage = parseInt(currentMileage.replace(/,/g, ""), 10) || 0;
    
    let intervalMileage: number;
    let intervalMonths: number;

    if (intervalType === "custom") {
      intervalMileage = parseInt(customMileage.replace(/,/g, ""), 10) || 0;
      intervalMonths = customMonths;
    } else {
      const interval = intervals[intervalType as keyof IntervalsConfig];
      intervalMileage = interval.mileage;
      intervalMonths = interval.months;
    }

    const nextServiceMileage = mileage + intervalMileage;
    
    const nextDate = new Date();
    nextDate.setMonth(nextDate.getMonth() + intervalMonths);
    const nextServiceDate = nextDate.toISOString().split("T")[0];

    return { nextServiceMileage, nextServiceDate };
  }

  // Mobile (iOS Safari, Android Chrome) needs a different print path than
  // desktop. iOS Safari/AirPrint *ignore* CSS `@page { size }` and default
  // to letter, which is what produced the bug where a 2x2 sticker rendered
  // as a tiny image in the corner of an 8.5x11 sheet. The fix is to ask the
  // backend for a real PDF whose page size matches the sticker, then open
  // it in a new tab so AirPrint picks up the PDF's embedded page size.
  // Do NOT "simplify" this back into a popup with @page CSS — it will
  // regress mobile printing.
  function isMobileBrowser(): boolean {
    if (typeof navigator === "undefined") return false;
    const ua = navigator.userAgent || "";
    if (/iPad|iPhone|iPod|Android/i.test(ua)) return true;
    // iPadOS 13+ reports as Macintosh; distinguish by touch support.
    if (/Macintosh/.test(ua) && typeof navigator.maxTouchPoints === "number" && navigator.maxTouchPoints > 1) {
      return true;
    }
    return false;
  }

  async function handlePrint() {
    if (!currentMileage || parseInt(currentMileage.replace(/,/g, ""), 10) <= 0) {
      setError("Please enter a valid current reading");
      return;
    }

    setError(null);
    setGenerating(true);

    const useMobilePdfPath = isMobileBrowser();

    // CRITICAL: open the destination tab synchronously *off the user's tap*,
    // before any await. iOS Safari blocks `window.open` once a microtask
    // boundary has passed since the gesture, so opening it after `await fetch`
    // is silently rejected. Desktop Chrome has the same problem with
    // `printWindow.document.open()` / `document.write()` — the browser will
    // open the tab but refuse to honor those writes once the user gesture is
    // gone, leaving the popup stranded on `about:blank`. So we open the tab
    // synchronously here for *both* paths, write a placeholder, then either
    // navigate it (mobile PDF) or write the print HTML into it (desktop) once
    // the API call returns.
    // Note: do NOT use `noopener` here on desktop. `noopener` causes
    // `window.open` to return `null`, which would leave us with no handle to
    // write the sticker print HTML into — which is exactly the bug we are
    // fixing. The popup is same-origin and we control its content, so this
    // is safe.
    const printWindowFeatures = useMobilePdfPath ? "" : "width=600,height=800";
    const placeholderWindow: Window | null = window.open("", "_blank", printWindowFeatures);
    if (placeholderWindow) {
      try {
        placeholderWindow.document.open();
        placeholderWindow.document.write(
          '<!doctype html><html><head><meta charset="utf-8" /><title>Preparing sticker…</title>' +
            '<meta name="viewport" content="width=device-width,initial-scale=1" />' +
            '<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:24px;color:#374151}</style>' +
            "</head><body>Preparing sticker for printing…</body></html>",
        );
        placeholderWindow.document.close();
      } catch {
        // Some browsers throw on document.write into a same-origin blank
        // tab during navigation — non-fatal, the subsequent write/navigation
        // below still works.
      }
    }

    try {
      const { nextServiceMileage, nextServiceDate } = calculateServiceValues();

      const res = await fetch("/api/sticker/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          size: stickerSize,
          currentMileage: parseInt(currentMileage.replace(/,/g, ""), 10),
          nextServiceMileage,
          nextServiceDate,
          includeQR: true,
          useKilometers: unit === "km",
          useHours: unit === "hrs",
          format: useMobilePdfPath ? "pdf" : "png",
        }),
      });

      if (!res.ok) {
        throw new Error("Failed to generate sticker");
      }

      const blob = await res.blob();

      if (useMobilePdfPath) {
        const pdfUrl = URL.createObjectURL(blob);
        if (placeholderWindow && !placeholderWindow.closed) {
          placeholderWindow.location.href = pdfUrl;
        } else {
          // Popup was blocked (or never opened) — fall back to navigating
          // the current tab. AirPrint still picks up the PDF page size.
          window.location.href = pdfUrl;
        }
        // Release the blob URL once the new tab has had a chance to load it.
        // 60s is plenty even on a slow connection; revoking sooner can break
        // the navigation in iOS Safari.
        setTimeout(() => URL.revokeObjectURL(pdfUrl), 60_000);
        onClose();
        return;
      }

      // Desktop path: write the PNG into a popup with `@page size` CSS so
      // the browser's print dialog uses the sticker dimensions. This works
      // on Chrome/Edge/Firefox/desktop Safari today and we keep it as-is to
      // avoid regressing those flows.
      const reader = new FileReader();
      reader.onloadend = () => {
        const dataUrl = reader.result as string;

        const sizeDimensions: Record<string, { width: string; height: string }> = {
          "1.5x2.25": { width: "1.5in", height: "2.25in" },
          "2x2": { width: "2in", height: "2in" },
          "2x2.5": { width: "2in", height: "2.5in" },
          "2x3": { width: "2in", height: "3in" },
          "2x3.5": { width: "2in", height: "3.5in" },
        };
        const dims = sizeDimensions[stickerSize] || { width: "1.5in", height: "2.25in" };

        const printWindow = placeholderWindow && !placeholderWindow.closed ? placeholderWindow : null;
        if (!printWindow) {
          // Desktop popup blocked — fall back to the PDF path so the user
          // still gets a correctly-sized sticker instead of a dead button.
          fetch("/api/sticker/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              size: stickerSize,
              currentMileage: parseInt(currentMileage.replace(/,/g, ""), 10),
              nextServiceMileage,
              nextServiceDate,
              includeQR: true,
              useKilometers: unit === "km",
              useHours: unit === "hrs",
              format: "pdf",
            }),
          })
            .then((r) => (r.ok ? r.blob() : Promise.reject(new Error("PDF fallback failed"))))
            .then((pdfBlob) => {
              const pdfUrl = URL.createObjectURL(pdfBlob);
              window.location.href = pdfUrl;
              setTimeout(() => URL.revokeObjectURL(pdfUrl), 60_000);
            })
            .catch(() => {
              alert("Please allow popups to print stickers");
            });
          return;
        }

        printWindow.document.open();
        printWindow.document.write(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Print Sticker</title>
  <style>
    @page { 
      size: ${dims.width} ${dims.height}; 
      margin: 0 !important; 
    }

    * {
      margin: 0 !important;
      padding: 0 !important;
      box-sizing: border-box !important;
    }

    html {
      width: 100vw !important;
      height: 100vh !important;
    }

    body {
      width: 100vw !important;
      height: 100vh !important;
      overflow: hidden !important;
      background: white !important;
      position: relative !important;
    }

    img#printImg {
      position: absolute !important;
      left: 0 !important;
      top: 0 !important;
      width: 100vw !important;
      height: 100vh !important;
      display: block !important;
      object-fit: fill !important;
    }

    @media print {
      @page { 
        size: ${dims.width} ${dims.height}; 
        margin: 0 !important; 
      }
      html, body {
        width: 100% !important;
        height: 100% !important;
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
      }
      img#printImg {
        width: 100% !important;
        height: 100% !important;
      }
    }
  </style>
</head>
<body>
  <img id="printImg" src="${dataUrl}" />
  <script>
    const img = document.getElementById('printImg');
    img.onload = () => {
      setTimeout(() => {
        window.focus();
        window.print();
      }, 100);
    };
    img.onerror = () => {
      document.body.innerHTML = '<p>Failed to load image for printing.</p>';
    };
    if (img.complete) {
      setTimeout(() => {
        window.focus();
        window.print();
      }, 100);
    }
  </script>
</body>
</html>`);
        printWindow.document.close();
      };
      reader.readAsDataURL(blob);

      onClose();
    } catch (err) {
      console.error("Failed to generate sticker:", err);
      // If we opened a placeholder tab (mobile or desktop) and the request
      // blew up, close it so the user isn't stuck on "Preparing sticker…".
      if (placeholderWindow && !placeholderWindow.closed) {
        try { placeholderWindow.close(); } catch { /* ignore */ }
      }
      setError("Failed to generate sticker. Please try again.");
    } finally {
      setGenerating(false);
    }
  }

  // Send the rendered sticker to the shop's local ZINK printer via the
  // cloud print queue. Reuses the existing PNG generation, then hands the
  // image to the session-authed enqueue front door — the shop agent prints
  // it locally. No popup / browser print dialog involved.
  async function handleQueueToPrinter() {
    if (!currentMileage || parseInt(currentMileage.replace(/,/g, ""), 10) <= 0) {
      setError("Please enter a valid current reading");
      return;
    }
    setError(null);
    setZinkStatus("queuing");
    try {
      const { nextServiceMileage, nextServiceDate } = calculateServiceValues();
      const res = await fetch("/api/sticker/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          size: stickerSize,
          currentMileage: parseInt(currentMileage.replace(/,/g, ""), 10),
          nextServiceMileage,
          nextServiceDate,
          includeQR: true,
          useKilometers: unit === "km",
          useHours: unit === "hrs",
          format: "png",
        }),
      });
      if (!res.ok) throw new Error("Failed to generate sticker");
      const blob = await res.blob();
      const dataUrl: string = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error("Failed to read sticker image"));
        reader.readAsDataURL(blob);
      });

      const enqueueRes = await fetch("/api/print/enqueue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64: dataUrl, type: "sticker" }),
      });
      if (!enqueueRes.ok) {
        const j = await enqueueRes.json().catch(() => ({}));
        throw new Error(j.error || "Failed to queue print");
      }
      setZinkStatus("queued");
    } catch (err: any) {
      console.error("Failed to queue sticker to printer:", err);
      setZinkStatus("error");
      setError(err?.message || "Failed to queue print. Please try again.");
    }
  }

  function formatMileageInput(value: string): string {
    const numericValue = value.replace(/[^\d]/g, "");
    if (!numericValue) return "";
    return parseInt(numericValue, 10).toLocaleString();
  }

  const visibleOilTypes = getVisibleOilTypes(intervals);

  useEffect(() => {
    if (intervalType === "custom") return;
    const isVisible = visibleOilTypes.includes(intervalType as keyof IntervalsConfig);
    if (!isVisible) {
      setIntervalType(visibleOilTypes[0] ?? "custom");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervals, intervalType]);

  if (!isOpen) return null;

  const unitLabel = unit === "hrs" ? "hrs" : unit;
  const readingLabel = unit === "hrs" ? "Hours" : unit === "km" ? "Kilometers" : "Mileage";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h2 className="text-lg font-semibold text-gray-900">Quick Sticker</h2>
          <button
            onClick={onClose}
            className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
            </div>
          ) : (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Current {readingLabel}
                </label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <input
                      type="text"
                      value={currentMileage}
                      onChange={(e) => setCurrentMileage(formatMileageInput(e.target.value))}
                      placeholder={`e.g. 125,000`}
                      className="w-full px-4 py-2 pr-12 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    />
                    <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 text-sm">
                      {unitLabel}
                    </span>
                  </div>
                  <select
                    value={unit}
                    onChange={(e) => setUnit(e.target.value as UnitType)}
                    className="px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white text-sm"
                  >
                    {UNIT_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Service Interval
                </label>
                <select
                  value={intervalType}
                  onChange={(e) => setIntervalType(e.target.value)}
                  className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white"
                >
                  {visibleOilTypes.map((key) => {
                    const interval = intervals[key];
                    const label = resolveOilTypeLabel(key, intervals);
                    return (
                      <option key={key} value={key}>
                        {label} ({interval.mileage.toLocaleString()} {unitLabel} / {interval.months} mo)
                      </option>
                    );
                  })}
                  <option value="custom">Custom</option>
                </select>
              </div>

              {intervalType === "custom" && (
                <div className="bg-gray-50 rounded-lg p-4 space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Months Until Service
                    </label>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => setCustomMonths(Math.max(1, customMonths - 1))}
                        className="w-10 h-10 flex items-center justify-center border rounded-lg hover:bg-gray-100 text-lg font-medium"
                      >
                        -
                      </button>
                      <span className="w-16 text-center text-lg font-medium">
                        {customMonths} mo
                      </span>
                      <button
                        type="button"
                        onClick={() => setCustomMonths(Math.min(24, customMonths + 1))}
                        className="w-10 h-10 flex items-center justify-center border rounded-lg hover:bg-gray-100 text-lg font-medium"
                      >
                        +
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      {readingLabel} Until Service
                    </label>
                    <div className="relative">
                      <input
                        type="text"
                        value={customMileage}
                        onChange={(e) => setCustomMileage(formatMileageInput(e.target.value))}
                        placeholder="e.g. 5,000"
                        className="w-full px-4 py-2 pr-12 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      />
                      <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 text-sm">
                        {unitLabel}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {error && (
                <p className="text-sm text-red-600">{error}</p>
              )}
            </>
          )}
        </div>

        <div className="px-6 py-4 border-t bg-gray-50 flex flex-wrap justify-end items-center gap-3">
          {zinkConfigured && (
            <button
              onClick={handleQueueToPrinter}
              disabled={zinkStatus === "queuing" || loading || !currentMileage}
              title={
                zinkOnline
                  ? "Send to your shop's ZINK printer"
                  : "Queue for your shop's ZINK printer (agent currently offline — it will print when back online)"
              }
              className="px-4 py-2 bg-emerald-600 text-white rounded-lg font-medium hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {zinkStatus === "queuing" ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Sending...
                </>
              ) : zinkStatus === "queued" ? (
                <>
                  <Check className="w-4 h-4" />
                  Queued
                </>
              ) : zinkStatus === "error" ? (
                <>
                  <AlertCircle className="w-4 h-4" />
                  Retry Send
                </>
              ) : (
                <>
                  <Wifi className="w-4 h-4" />
                  Send to Shop Printer
                </>
              )}
            </button>
          )}
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg font-medium"
          >
            Cancel
          </button>
          <button
            onClick={handlePrint}
            disabled={generating || loading || !currentMileage}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {generating ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <Printer className="w-4 h-4" />
                Print Now
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
