"use client";

import { useState, useEffect } from "react";
import { X, Loader2, Printer } from "lucide-react";

interface IntervalConfig {
  mileage: number;
  months: number;
}

interface IntervalsConfig {
  diesel: IntervalConfig;
  euro: IntervalConfig;
  synthetic: IntervalConfig;
  conventional: IntervalConfig;
}

const DEFAULT_INTERVALS: IntervalsConfig = {
  diesel: { mileage: 7500, months: 6 },
  euro: { mileage: 10000, months: 12 },
  synthetic: { mileage: 7500, months: 6 },
  conventional: { mileage: 3000, months: 3 },
};

const INTERVAL_OPTIONS = [
  { key: "conventional", label: "Conventional" },
  { key: "synthetic", label: "Synthetic" },
  { key: "euro", label: "European" },
  { key: "diesel", label: "Diesel" },
  { key: "custom", label: "Custom" },
] as const;

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

  useEffect(() => {
    if (isOpen) {
      fetchSettings();
    }
  }, [isOpen]);

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
    // is silently rejected. We open with a tiny "loading" placeholder, then
    // navigate it to the PDF blob URL once the request comes back. Desktop
    // still benefits from this — `window.open` after an await is also
    // popup-blocked on some desktop Safari configs.
    let mobilePrintWindow: Window | null = null;
    if (useMobilePdfPath) {
      mobilePrintWindow = window.open("", "_blank");
      if (mobilePrintWindow) {
        try {
          mobilePrintWindow.document.open();
          mobilePrintWindow.document.write(
            '<!doctype html><html><head><meta charset="utf-8" /><title>Preparing sticker…</title>' +
              '<meta name="viewport" content="width=device-width,initial-scale=1" />' +
              '<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:24px;color:#374151}</style>' +
              "</head><body>Preparing sticker for printing…</body></html>",
          );
          mobilePrintWindow.document.close();
        } catch {
          // Some browsers throw on document.write into a same-origin blank
          // tab during navigation — non-fatal, the location swap below still
          // works.
        }
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
        if (mobilePrintWindow && !mobilePrintWindow.closed) {
          mobilePrintWindow.location.href = pdfUrl;
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

        const printWindow = window.open("", "_blank", "noopener,noreferrer,width=600,height=800");
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
      // If we opened a placeholder mobile tab and the request blew up,
      // close it so the user isn't stuck on "Preparing sticker…".
      if (mobilePrintWindow && !mobilePrintWindow.closed) {
        try { mobilePrintWindow.close(); } catch { /* ignore */ }
      }
      setError("Failed to generate sticker. Please try again.");
    } finally {
      setGenerating(false);
    }
  }

  function formatMileageInput(value: string): string {
    const numericValue = value.replace(/[^\d]/g, "");
    if (!numericValue) return "";
    return parseInt(numericValue, 10).toLocaleString();
  }

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
                  {INTERVAL_OPTIONS.map((opt) => (
                    <option key={opt.key} value={opt.key}>
                      {opt.label}
                      {opt.key !== "custom" && intervals[opt.key as keyof IntervalsConfig] && (
                        ` (${intervals[opt.key as keyof IntervalsConfig].mileage.toLocaleString()} ${unitLabel} / ${intervals[opt.key as keyof IntervalsConfig].months} mo)`
                      )}
                    </option>
                  ))}
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

        <div className="px-6 py-4 border-t bg-gray-50 flex justify-end gap-3">
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
