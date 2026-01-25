"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { X, Loader2, Printer, RefreshCw } from "lucide-react";

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
  const [retrying, setRetrying] = useState(false);
  const printInProgressRef = useRef(false);

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

  const handlePrint = useCallback(async (isRetry = false) => {
    if (!currentMileage || parseInt(currentMileage.replace(/,/g, ""), 10) <= 0) {
      setError("Please enter a valid current reading");
      return;
    }

    if (printInProgressRef.current) {
      return;
    }
    printInProgressRef.current = true;

    setError(null);
    if (isRetry) {
      setRetrying(true);
    } else {
      setGenerating(true);
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
        }),
      });

      if (!res.ok) {
        throw new Error("Failed to generate sticker");
      }

      const blob = await res.blob();
      
      const reader = new FileReader();
      reader.onloadend = () => {
        const dataUrl = reader.result as string;
        
        // Define exact physical dimensions for each sticker size
        const sizeDimensions: Record<string, { width: string; height: string }> = {
          "1.5x2.25": { width: "1.5in", height: "2.25in" },
          "2x2": { width: "2in", height: "2in" },
          "2x2.5": { width: "2in", height: "2.5in" },
          "2x3": { width: "2in", height: "3in" },
          "2x3.5": { width: "2in", height: "3.5in" },
        };
        const dims = sizeDimensions[stickerSize] || { width: "1.5in", height: "2.25in" };
        
        // Print from NEW WINDOW with !important everywhere to prevent overrides
        const xOffset = "0in";
        const yOffset = "0in"; // Start at 0, adjust if needed
        
        const printWindow = window.open("", "_blank", "noopener,noreferrer,width=600,height=800");
        if (!printWindow) {
          alert("Please allow popups to print stickers");
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
      setError("Failed to generate sticker. Please try again.");
    } finally {
      setGenerating(false);
      setRetrying(false);
      printInProgressRef.current = false;
    }
  }, [currentMileage, stickerSize, unit, intervals, intervalType, customMileage, customMonths, onClose]);

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
                <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                  <div className="flex items-start gap-2">
                    <p className="text-sm text-red-700 flex-1">{error}</p>
                    <button
                      onClick={() => handlePrint(true)}
                      disabled={retrying}
                      className="text-red-700 hover:text-red-800 text-sm font-medium inline-flex items-center gap-1 disabled:opacity-50 flex-shrink-0"
                    >
                      {retrying ? (
                        <>
                          <Loader2 className="h-3 w-3 animate-spin" />
                          Retrying...
                        </>
                      ) : (
                        <>
                          <RefreshCw className="h-3 w-3" />
                          Retry
                        </>
                      )}
                    </button>
                  </div>
                </div>
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
            onClick={() => handlePrint(false)}
            disabled={generating || retrying || loading || !currentMileage}
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
