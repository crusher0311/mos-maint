"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Tag, Loader2, Save, Download, RotateCcw } from "lucide-react";

interface FontStyle {
  bold?: boolean;
  italic?: boolean;
  size?: number;
}

interface KeytagConfig {
  enabled: boolean;
  showLogo: boolean;
  fontStyles: {
    customerName: FontStyle;
    vehicleInfo: FontStyle;
    roNumber: FontStyle;
    mileage: FontStyle;
  };
  colors: {
    text: string;
    background: string;
  };
  defaultSize: string;
}

const DEFAULT_CONFIG: KeytagConfig = {
  enabled: true,
  showLogo: false,
  fontStyles: {
    customerName: { bold: true, italic: false, size: 14 },
    vehicleInfo: { bold: false, italic: false, size: 12 },
    roNumber: { bold: true, italic: false, size: 12 },
    mileage: { bold: true, italic: false, size: 14 },
  },
  colors: {
    text: "#000000",
    background: "#FFFFFF",
  },
  defaultSize: "dymo30252",
};

const KEYTAG_SIZES = [
  { value: "dymo30252", label: "Dymo 30252 (1⅛\" x 3½\")" },
];

export default function KeytagSettingsPage() {
  const [config, setConfig] = useState<KeytagConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shopName, setShopName] = useState<string>("");

  const sampleData = {
    customerName: "John Smith",
    vehicleInfo: "2018 Toyota Camry",
    vin: "4T1BF1FK8JU123456",
    roNumber: "456789",
    mileage: "124,382",
  };

  useEffect(() => {
    async function loadSettings() {
      try {
        const res = await fetch("/api/keytag/settings");
        if (res.ok) {
          const data = await res.json();
          setConfig({ ...DEFAULT_CONFIG, ...data.config });
          setShopName(data.shopName || "");
        }
      } catch (err) {
        console.error("Failed to load keytag settings:", err);
        setError("Failed to load settings");
      } finally {
        setLoading(false);
      }
    }
    loadSettings();
  }, []);

  const previewUrlRef = useRef<string | null>(null);

  const generatePreview = useCallback(async (currentConfig: KeytagConfig) => {
    setPreviewLoading(true);
    try {
      const res = await fetch("/api/keytag/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...sampleData,
          previewConfig: currentConfig,
        }),
      });

      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        if (previewUrlRef.current) {
          URL.revokeObjectURL(previewUrlRef.current);
        }
        previewUrlRef.current = url;
        setPreviewUrl(url);
      }
    } catch (err) {
      console.error("Failed to generate preview:", err);
    } finally {
      setPreviewLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!loading) {
      const debounce = setTimeout(() => {
        generatePreview(config);
      }, 500);
      return () => clearTimeout(debounce);
    }
  }, [config, loading, generatePreview]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/keytag/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config }),
      });

      if (!res.ok) {
        throw new Error("Failed to save settings");
      }
    } catch (err) {
      setError("Failed to save settings");
      console.error(err);
    } finally {
      setSaving(false);
    }
  }

  function handleReset() {
    setConfig(DEFAULT_CONFIG);
  }

  async function handleDownload() {
    if (!previewUrl) return;
    
    try {
      const res = await fetch("/api/keytag/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...sampleData,
          previewConfig: config,
        }),
      });

      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `keytag-sample.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      console.error("Failed to download:", err);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Tag className="w-8 h-8 text-blue-600" />
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Keytag Settings</h1>
            <p className="text-sm text-gray-500">Configure your keytag appearance and layout</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleReset}
            className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 flex items-center gap-2"
          >
            <RotateCcw className="w-4 h-4" />
            Reset
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Save Settings
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="space-y-6">
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
              <h2 className="text-lg font-semibold mb-4">Size</h2>
              <select
                value={config.defaultSize}
                onChange={(e) => setConfig({ ...config, defaultSize: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                {KEYTAG_SIZES.map((size) => (
                  <option key={size.value} value={size.value}>{size.label}</option>
                ))}
              </select>
              <p className="text-xs text-gray-500 mt-2">
                Dymo 30252 is a standard address label size (1⅛" x 3½")
              </p>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
              <h2 className="text-lg font-semibold mb-4">Colors</h2>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Text Color</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={config.colors.text}
                      onChange={(e) => setConfig({
                        ...config,
                        colors: { ...config.colors, text: e.target.value }
                      })}
                      className="w-10 h-10 rounded border cursor-pointer"
                    />
                    <input
                      type="text"
                      value={config.colors.text}
                      onChange={(e) => setConfig({
                        ...config,
                        colors: { ...config.colors, text: e.target.value }
                      })}
                      className="flex-1 px-2 py-1 text-sm border rounded"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Background</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={config.colors.background}
                      onChange={(e) => setConfig({
                        ...config,
                        colors: { ...config.colors, background: e.target.value }
                      })}
                      className="w-10 h-10 rounded border cursor-pointer"
                    />
                    <input
                      type="text"
                      value={config.colors.background}
                      onChange={(e) => setConfig({
                        ...config,
                        colors: { ...config.colors, background: e.target.value }
                      })}
                      className="flex-1 px-2 py-1 text-sm border rounded"
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
              <h2 className="text-lg font-semibold mb-4">Font Styles</h2>
              <div className="space-y-4">
                {[
                  { key: "customerName", label: "Customer Name" },
                  { key: "vehicleInfo", label: "Vehicle Info" },
                  { key: "roNumber", label: "RO Number" },
                  { key: "mileage", label: "Mileage" },
                ].map(({ key, label }) => (
                  <div key={key} className="flex items-center justify-between">
                    <span className="text-sm font-medium text-gray-700">{label}</span>
                    <div className="flex items-center gap-3">
                      <label className="flex items-center gap-1 text-sm">
                        <input
                          type="checkbox"
                          checked={config.fontStyles[key as keyof typeof config.fontStyles]?.bold || false}
                          onChange={(e) => setConfig({
                            ...config,
                            fontStyles: {
                              ...config.fontStyles,
                              [key]: {
                                ...config.fontStyles[key as keyof typeof config.fontStyles],
                                bold: e.target.checked,
                              },
                            },
                          })}
                          className="rounded"
                        />
                        Bold
                      </label>
                      <label className="flex items-center gap-1 text-sm">
                        <input
                          type="checkbox"
                          checked={config.fontStyles[key as keyof typeof config.fontStyles]?.italic || false}
                          onChange={(e) => setConfig({
                            ...config,
                            fontStyles: {
                              ...config.fontStyles,
                              [key]: {
                                ...config.fontStyles[key as keyof typeof config.fontStyles],
                                italic: e.target.checked,
                              },
                            },
                          })}
                          className="rounded"
                        />
                        Italic
                      </label>
                      <input
                        type="number"
                        min="8"
                        max="24"
                        value={config.fontStyles[key as keyof typeof config.fontStyles]?.size || 12}
                        onChange={(e) => setConfig({
                          ...config,
                          fontStyles: {
                            ...config.fontStyles,
                            [key]: {
                              ...config.fontStyles[key as keyof typeof config.fontStyles],
                              size: parseInt(e.target.value) || 12,
                            },
                          },
                        })}
                        className="w-16 px-2 py-1 text-sm border rounded text-center"
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="lg:sticky lg:top-6 h-fit">
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold">Preview</h2>
                <button
                  onClick={handleDownload}
                  disabled={!previewUrl || previewLoading}
                  className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded-lg flex items-center gap-2 disabled:opacity-50"
                >
                  <Download className="w-4 h-4" />
                  Download
                </button>
              </div>
              
              <div className="bg-gray-100 rounded-lg p-4 flex items-center justify-center">
                {previewUrl ? (
                  <div className="relative w-full">
                    <img
                      src={previewUrl}
                      alt="Keytag Preview"
                      className="rounded shadow-lg border border-gray-300 w-full"
                      style={{ 
                        aspectRatio: "3.5 / 1.125",
                        objectFit: "contain",
                        backgroundColor: "#fff"
                      }}
                    />
                    {previewLoading && (
                      <div className="absolute inset-0 bg-white/50 flex items-center justify-center rounded">
                        <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                  </div>
                )}
              </div>
              
              <div className="text-center text-xs text-gray-400 mt-2">
                Actual size: 3½" × 1⅛" (Dymo 30252)
              </div>

              <div className="mt-4 text-xs text-gray-500">
                <p className="font-medium mb-2">Sample Data:</p>
                <ul className="space-y-1">
                  <li><span className="text-gray-400">Customer:</span> {sampleData.customerName}</li>
                  <li><span className="text-gray-400">Vehicle:</span> {sampleData.vehicleInfo}</li>
                  <li><span className="text-gray-400">VIN:</span> {sampleData.vin}</li>
                  <li><span className="text-gray-400">RO#:</span> {sampleData.roNumber}</li>
                  <li><span className="text-gray-400">Mileage:</span> {sampleData.mileage}</li>
                </ul>
              </div>
            </div>

            <div className="mt-4 bg-blue-50 rounded-xl p-4 border border-blue-100">
              <h3 className="text-sm font-semibold text-blue-900 mb-2">Keytag Info</h3>
              <p className="text-xs text-blue-700">
                Keytags are printed on Dymo 30252 labels and display customer name, vehicle info, RO number, and mileage. 
                They attach to customer keys while vehicles are in the shop.
              </p>
            </div>
        </div>
      </div>
    </div>
  );
}
