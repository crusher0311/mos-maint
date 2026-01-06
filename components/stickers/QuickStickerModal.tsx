"use client";

import { useState, useEffect } from "react";
import { X, Loader2, Download, Printer } from "lucide-react";

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

const STICKER_SIZES = [
  { value: "2x2", label: "2\" x 2\"" },
  { value: "2x2.5", label: "2\" x 2.5\"" },
  { value: "2x3", label: "2\" x 3\"" },
  { value: "2x3.5", label: "2\" x 3.5\"" },
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
  const [useKilometers, setUseKilometers] = useState(false);
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
          setUseKilometers(data.config.useKilometers ?? false);
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

  async function handleGenerate() {
    if (!currentMileage || parseInt(currentMileage.replace(/,/g, ""), 10) <= 0) {
      setError("Please enter a valid current mileage");
      return;
    }

    setError(null);
    setGenerating(true);

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
        }),
      });

      if (!res.ok) {
        throw new Error("Failed to generate sticker");
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);

      const link = document.createElement("a");
      link.href = url;
      link.download = `quick-sticker-${stickerSize}.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      onClose();
    } catch (err) {
      console.error("Failed to generate sticker:", err);
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

  const distanceLabel = useKilometers ? "km" : "mi";

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
                  Current {useKilometers ? "Kilometers" : "Mileage"}
                </label>
                <div className="relative">
                  <input
                    type="text"
                    value={currentMileage}
                    onChange={(e) => setCurrentMileage(formatMileageInput(e.target.value))}
                    placeholder={`e.g. 125,000`}
                    className="w-full px-4 py-2 pr-12 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                  <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 text-sm">
                    {distanceLabel}
                  </span>
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
                        ` (${intervals[opt.key as keyof IntervalsConfig].mileage.toLocaleString()} ${distanceLabel} / ${intervals[opt.key as keyof IntervalsConfig].months} mo)`
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
                      {useKilometers ? "Kilometers" : "Miles"} Until Service
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
                        {distanceLabel}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Sticker Size
                </label>
                <select
                  value={stickerSize}
                  onChange={(e) => setStickerSize(e.target.value)}
                  className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white"
                >
                  {STICKER_SIZES.map((size) => (
                    <option key={size.value} value={size.value}>
                      {size.label}
                    </option>
                  ))}
                </select>
              </div>

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
            onClick={handleGenerate}
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
                <Download className="w-4 h-4" />
                Download Sticker
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
