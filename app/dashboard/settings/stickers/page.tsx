"use client";

import { useState, useEffect, useRef } from "react";
import { Loader2, Check, Download, QrCode, Palette, Type, Phone, Link2, Calendar, Gauge, ImageIcon, Upload } from "lucide-react";

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

interface FontStyle {
  bold: boolean;
  italic: boolean;
  size: number;
}

interface StickerConfig {
  enabled: boolean;
  logo: string;
  phone: string;
  tagline: string;
  taglineLine2: string;
  serviceLabel: string;
  showQRCode: boolean;
  roundMileage: boolean;
  usePredictiveDate: boolean;
  fontStyles: {
    phone: FontStyle;
    tagline: FontStyle;
    taglineLine2: FontStyle;
    serviceLabel: FontStyle;
    serviceValue: FontStyle;
  };
  colors: {
    primary: string;
    secondary: string;
    text: string;
    background: string;
    phoneColor: string;
    taglineColor: string;
    serviceLabelColor: string;
    serviceValueColor: string;
  };
  defaultSize: string;
  appointmentUrl: string;
  useKilometers: boolean;
  intervals: IntervalsConfig;
}

const STICKER_SIZES = [
  { value: "2x2", label: "2\" x 2\"" },
  { value: "2x2.5", label: "2\" x 2.5\"" },
  { value: "2x3", label: "2\" x 3\"" },
  { value: "2x3.5", label: "2\" x 3.5\"" },
];

const DEFAULT_INTERVALS: IntervalsConfig = {
  diesel: { mileage: 7500, months: 6 },
  euro: { mileage: 10000, months: 12 },
  synthetic: { mileage: 7500, months: 6 },
  conventional: { mileage: 3000, months: 3 },
};

const OIL_TYPES: { key: keyof IntervalsConfig; label: string; description: string }[] = [
  { key: "conventional", label: "Conventional", description: "Standard oil changes" },
  { key: "synthetic", label: "Synthetic", description: "Full synthetic oil" },
  { key: "euro", label: "European", description: "BMW, Mercedes, Audi, VW, etc." },
  { key: "diesel", label: "Diesel", description: "Diesel engines" },
];

const DEFAULT_FONT_STYLES = {
  phone: { bold: true, italic: false, size: 14 },
  tagline: { bold: false, italic: true, size: 11 },
  taglineLine2: { bold: false, italic: true, size: 11 },
  serviceLabel: { bold: false, italic: false, size: 12 },
  serviceValue: { bold: true, italic: true, size: 14 },
};

const DEFAULT_CONFIG: StickerConfig = {
  enabled: true,
  logo: "",
  phone: "",
  tagline: "",
  taglineLine2: "",
  serviceLabel: "Next Oil Service",
  showQRCode: true,
  roundMileage: true,
  usePredictiveDate: false,
  fontStyles: DEFAULT_FONT_STYLES,
  colors: {
    primary: "#cc0000",
    secondary: "#1976d2",
    text: "#ffffff",
    background: "#ffffff",
    phoneColor: "#000000",
    taglineColor: "#333333",
    serviceLabelColor: "#666666",
    serviceValueColor: "#cc0000",
  },
  defaultSize: "2x2.5",
  appointmentUrl: "",
  useKilometers: false,
  intervals: DEFAULT_INTERVALS,
};

export default function StickerSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  const [config, setConfig] = useState<StickerConfig>(DEFAULT_CONFIG);

  useEffect(() => {
    fetchSettings();
  }, []);

  useEffect(() => {
    if (!loading) {
      refreshQrPreview();
      debouncedRefreshPreview();
    }
  }, [config, loading]);
  
  function debouncedRefreshPreview() {
    if (previewTimeoutRef.current) {
      clearTimeout(previewTimeoutRef.current);
    }
    previewTimeoutRef.current = setTimeout(() => {
      refreshStickerPreview();
    }, 500);
  }
  
  async function refreshStickerPreview() {
    setPreviewLoading(true);
    try {
      const sampleMileage = config.roundMileage ? 165000 : 165123;
      const sampleDate = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
      
      const res = await fetch("/api/sticker/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nextServiceMileage: sampleMileage,
          nextServiceDate: sampleDate,
          size: config.defaultSize,
          includeQR: config.showQRCode,
          previewConfig: {
            logo: config.logo,
            phone: config.phone,
            tagline: config.tagline,
            taglineLine2: config.taglineLine2,
            serviceLabel: config.serviceLabel,
            fontStyles: config.fontStyles,
            colors: config.colors,
            useKilometers: config.useKilometers,
          },
        }),
      });
      
      if (res.ok) {
        const blob = await res.blob();
        if (previewUrl) {
          URL.revokeObjectURL(previewUrl);
        }
        setPreviewUrl(URL.createObjectURL(blob));
      }
    } catch (err) {
      console.error("Failed to refresh sticker preview:", err);
    } finally {
      setPreviewLoading(false);
    }
  }

  async function fetchSettings() {
    try {
      const res = await fetch("/api/sticker/settings");
      if (res.ok) {
        const data = await res.json();
        if (data.config) {
          setConfig({
            enabled: data.config.enabled ?? DEFAULT_CONFIG.enabled,
            logo: data.config.logo ?? DEFAULT_CONFIG.logo,
            phone: data.config.phone ?? DEFAULT_CONFIG.phone,
            tagline: data.config.tagline ?? DEFAULT_CONFIG.tagline,
            taglineLine2: data.config.taglineLine2 ?? DEFAULT_CONFIG.taglineLine2,
            serviceLabel: data.config.serviceLabel ?? DEFAULT_CONFIG.serviceLabel,
            showQRCode: data.config.showQRCode ?? DEFAULT_CONFIG.showQRCode,
            roundMileage: data.config.roundMileage ?? DEFAULT_CONFIG.roundMileage,
            usePredictiveDate: data.config.usePredictiveDate ?? DEFAULT_CONFIG.usePredictiveDate,
            fontStyles: {
              phone: data.config.fontStyles?.phone ?? DEFAULT_FONT_STYLES.phone,
              tagline: data.config.fontStyles?.tagline ?? DEFAULT_FONT_STYLES.tagline,
              taglineLine2: data.config.fontStyles?.taglineLine2 ?? DEFAULT_FONT_STYLES.taglineLine2,
              serviceLabel: data.config.fontStyles?.serviceLabel ?? DEFAULT_FONT_STYLES.serviceLabel,
              serviceValue: data.config.fontStyles?.serviceValue ?? DEFAULT_FONT_STYLES.serviceValue,
            },
            colors: {
              primary: data.config.colors?.primary ?? DEFAULT_CONFIG.colors.primary,
              secondary: data.config.colors?.secondary ?? DEFAULT_CONFIG.colors.secondary,
              text: data.config.colors?.text ?? DEFAULT_CONFIG.colors.text,
              background: data.config.colors?.background ?? DEFAULT_CONFIG.colors.background,
              phoneColor: data.config.colors?.phoneColor ?? DEFAULT_CONFIG.colors.phoneColor,
              taglineColor: data.config.colors?.taglineColor ?? DEFAULT_CONFIG.colors.taglineColor,
              serviceLabelColor: data.config.colors?.serviceLabelColor ?? DEFAULT_CONFIG.colors.serviceLabelColor,
              serviceValueColor: data.config.colors?.serviceValueColor ?? DEFAULT_CONFIG.colors.serviceValueColor,
            },
            defaultSize: data.config.defaultSize ?? DEFAULT_CONFIG.defaultSize,
            appointmentUrl: data.config.appointmentUrl ?? DEFAULT_CONFIG.appointmentUrl,
            useKilometers: data.config.useKilometers ?? DEFAULT_CONFIG.useKilometers,
            intervals: {
              diesel: data.config.intervals?.diesel ?? DEFAULT_INTERVALS.diesel,
              euro: data.config.intervals?.euro ?? DEFAULT_INTERVALS.euro,
              synthetic: data.config.intervals?.synthetic ?? DEFAULT_INTERVALS.synthetic,
              conventional: data.config.intervals?.conventional ?? DEFAULT_INTERVALS.conventional,
            },
          });
        }
      }
    } catch (err) {
      console.error("Failed to fetch sticker settings:", err);
    } finally {
      setLoading(false);
    }
  }

  async function refreshQrPreview() {
    try {
      const color = encodeURIComponent(config.colors.primary);
      const backgroundColor = encodeURIComponent("#ffffff");
      const res = await fetch(`/api/sticker/qr?size=200&color=${color}&backgroundColor=${backgroundColor}`);
      if (res.ok) {
        const blob = await res.blob();
        setQrUrl(URL.createObjectURL(blob));
      }
    } catch (err) {
      console.error("Failed to load QR preview:", err);
    }
  }

  async function saveSettings() {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/sticker/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: config.enabled,
          logo: config.logo,
          phone: config.phone,
          tagline: config.tagline,
          taglineLine2: config.taglineLine2,
          serviceLabel: config.serviceLabel,
          showQRCode: config.showQRCode,
          roundMileage: config.roundMileage,
          usePredictiveDate: config.usePredictiveDate,
          fontStyles: config.fontStyles,
          colors: config.colors,
          defaultSize: config.defaultSize,
          appointmentUrl: config.appointmentUrl,
          useKilometers: config.useKilometers,
          intervals: config.intervals,
        }),
      });
      
      if (res.ok) {
        setMessage({ type: "success", text: "Sticker settings saved!" });
      } else {
        const data = await res.json();
        setMessage({ type: "error", text: data.error || "Failed to save settings" });
      }
    } catch (err) {
      setMessage({ type: "error", text: "Failed to save settings" });
    } finally {
      setSaving(false);
    }
  }

  async function downloadSticker() {
    setDownloading(true);
    try {
      const res = await fetch("/api/sticker/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          size: config.defaultSize,
          primaryColor: config.colors.primary,
          backgroundColor: "#ffffff",
          tagline: config.tagline,
          phone: config.phone,
          useKilometers: config.useKilometers,
          includeQR: config.showQRCode,
        }),
      });
      
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `oil-sticker-${config.defaultSize}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } else {
        setMessage({ type: "error", text: "Failed to generate sticker" });
      }
    } catch (err) {
      setMessage({ type: "error", text: "Failed to download sticker" });
    } finally {
      setDownloading(false);
    }
  }

  function updateColor(colorKey: keyof typeof config.colors, value: string) {
    setConfig({
      ...config,
      colors: { ...config.colors, [colorKey]: value },
    });
  }

  function updateInterval(
    oilType: keyof IntervalsConfig,
    field: keyof IntervalConfig,
    value: number
  ) {
    const currentInterval = config.intervals?.[oilType] ?? DEFAULT_INTERVALS[oilType];
    setConfig({
      ...config,
      intervals: {
        ...DEFAULT_INTERVALS,
        ...config.intervals,
        [oilType]: {
          ...currentInterval,
          [field]: value,
        },
      },
    });
  }

  async function handleLogoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      setMessage({ type: "error", text: "Please select an image file" });
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      setMessage({ type: "error", text: "File size must be under 5MB" });
      return;
    }

    setUploading(true);
    setMessage(null);

    try {
      const urlRes = await fetch("/api/sticker/upload-logo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: file.name,
          contentType: file.type,
        }),
      });

      if (!urlRes.ok) {
        const err = await urlRes.json();
        throw new Error(err.error || "Failed to get upload URL");
      }

      const { uploadURL, publicURL, objectPath } = await urlRes.json();

      const uploadRes = await fetch(uploadURL, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type },
      });

      if (!uploadRes.ok) {
        throw new Error("Failed to upload file");
      }

      const finalizeRes = await fetch("/api/sticker/finalize-logo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ objectPath, publicURL }),
      });

      if (!finalizeRes.ok) {
        const err = await finalizeRes.json();
        throw new Error(err.error || "Failed to finalize upload");
      }

      const { logoUrl } = await finalizeRes.json();
      setConfig({ ...config, logo: logoUrl });
      setMessage({ type: "success", text: "Logo uploaded successfully!" });
    } catch (err) {
      console.error("Logo upload error:", err);
      setMessage({ type: "error", text: err instanceof Error ? err.message : "Upload failed" });
    } finally {
      setUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[300px]">
        <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <main className="p-6 max-w-6xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Oil Change Stickers</h1>
        <p className="text-gray-600 mt-1">
          Generate custom oil change stickers with QR codes that link to your appointment page.
        </p>
      </div>

      {message && (
        <div className={`mb-4 p-3 rounded-lg flex items-center gap-2 ${
          message.type === "success" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
        }`}>
          {message.type === "success" ? <Check className="w-4 h-4" /> : null}
          {message.text}
        </div>
      )}

      <div className="flex gap-6">
        <div className="flex-1 space-y-6 min-w-0">
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <div className="flex items-center gap-2 mb-4">
              <Type className="w-5 h-5 text-blue-600" />
              <h2 className="font-semibold text-gray-900">Sticker Content</h2>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  <div className="flex items-center gap-2">
                    <ImageIcon className="w-4 h-4" />
                    Shop Logo
                  </div>
                </label>
                <div className="flex gap-2">
                  <input
                    type="url"
                    value={config.logo}
                    onChange={(e) => setConfig({ ...config, logo: e.target.value })}
                    placeholder="Logo URL or upload"
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
                  />
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleLogoUpload}
                    className="hidden"
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                    className="px-3 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors disabled:opacity-50 flex items-center gap-1"
                  >
                    {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                  </button>
                </div>
                {config.logo && (
                  <div className="mt-2 p-2 bg-gray-50 rounded-lg">
                    <img 
                      src={config.logo} 
                      alt="Logo" 
                      className="max-h-12 mx-auto object-contain"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                  </div>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  <div className="flex items-center gap-2">
                    <Phone className="w-4 h-4" />
                    Shop Phone
                  </div>
                </label>
                <input
                  type="tel"
                  value={config.phone}
                  onChange={(e) => setConfig({ ...config, phone: e.target.value })}
                  placeholder="(555) 123-4567"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Tagline</label>
                <input
                  type="text"
                  value={config.tagline}
                  onChange={(e) => setConfig({ ...config, tagline: e.target.value })}
                  placeholder="Schedule Service"
                  maxLength={30}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Line 2 (Optional)</label>
                <input
                  type="text"
                  value={config.taglineLine2}
                  onChange={(e) => setConfig({ ...config, taglineLine2: e.target.value })}
                  placeholder="Address or extra info"
                  maxLength={35}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Service Label</label>
                <input
                  type="text"
                  value={config.serviceLabel}
                  onChange={(e) => setConfig({ ...config, serviceLabel: e.target.value })}
                  placeholder="Next Oil Service"
                  maxLength={25}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  <div className="flex items-center gap-2">
                    <Link2 className="w-4 h-4" />
                    Appointment URL
                  </div>
                </label>
                <input
                  type="url"
                  value={config.appointmentUrl}
                  onChange={(e) => setConfig({ ...config, appointmentUrl: e.target.value })}
                  placeholder="https://booking-page.com"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <div className="flex items-center gap-2 mb-4">
              <Gauge className="w-5 h-5 text-blue-600" />
              <h2 className="font-semibold text-gray-900">Sticker Options</h2>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Size</label>
                <select
                  value={config.defaultSize}
                  onChange={(e) => setConfig({ ...config, defaultSize: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  {STICKER_SIZES.map((size) => (
                    <option key={size.value} value={size.value}>{size.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">QR Color</label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={config.colors.primary}
                    onChange={(e) => updateColor("primary", e.target.value)}
                    className="w-10 h-10 rounded border border-gray-300 cursor-pointer"
                  />
                  <input
                    type="text"
                    value={config.colors.primary}
                    onChange={(e) => updateColor("primary", e.target.value)}
                    className="flex-1 px-2 py-2 border border-gray-300 rounded-lg text-sm"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Background</label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={config.colors.background}
                    onChange={(e) => updateColor("background", e.target.value)}
                    className="w-10 h-10 rounded border border-gray-300 cursor-pointer"
                  />
                  <input
                    type="text"
                    value={config.colors.background}
                    onChange={(e) => updateColor("background", e.target.value)}
                    className="flex-1 px-2 py-2 border border-gray-300 rounded-lg text-sm"
                  />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-3 bg-gray-50 rounded-lg">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={config.showQRCode}
                  onChange={(e) => setConfig({ ...config, showQRCode: e.target.checked })}
                  className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700">Show QR code</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={config.useKilometers}
                  onChange={(e) => setConfig({ ...config, useKilometers: e.target.checked })}
                  className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700">Use kilometers</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={config.roundMileage}
                  onChange={(e) => setConfig({ ...config, roundMileage: e.target.checked })}
                  className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700">Round mileage</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer" title="Calculate due date using vehicle's avg miles/day">
                <input
                  type="checkbox"
                  checked={config.usePredictiveDate}
                  onChange={(e) => setConfig({ ...config, usePredictiveDate: e.target.checked })}
                  className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700">Predictive date</span>
              </label>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <div className="flex items-center gap-2 mb-4">
              <Palette className="w-5 h-5 text-blue-600" />
              <h2 className="font-semibold text-gray-900">Text Styling</h2>
            </div>

            <div className="space-y-3">
              {[
                { key: "phone", label: "Phone", colorKey: "phoneColor" as const },
                { key: "tagline", label: "Tagline", colorKey: "taglineColor" as const },
                { key: "taglineLine2", label: "Line 2", colorKey: "taglineColor" as const },
                { key: "serviceLabel", label: "Label", colorKey: "serviceLabelColor" as const },
                { key: "serviceValue", label: "Date/Mileage", colorKey: "serviceValueColor" as const },
              ].map((item) => {
                const style = config.fontStyles[item.key as keyof typeof config.fontStyles];
                const colorValue = config.colors[item.colorKey];
                return (
                  <div key={item.key} className="flex items-center gap-3 p-2 bg-gray-50 rounded-lg">
                    <span className="w-20 font-medium text-gray-700 text-sm">{item.label}</span>
                    <input
                      type="color"
                      value={colorValue}
                      onChange={(e) => updateColor(item.colorKey, e.target.value)}
                      className="w-8 h-8 rounded border border-gray-300 cursor-pointer flex-shrink-0"
                    />
                    <input
                      type="text"
                      value={colorValue}
                      onChange={(e) => updateColor(item.colorKey, e.target.value)}
                      className="w-20 px-2 py-1 border border-gray-300 rounded text-sm"
                    />
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        value={style.size}
                        onChange={(e) => setConfig({
                          ...config,
                          fontStyles: {
                            ...config.fontStyles,
                            [item.key]: { ...style, size: Number(e.target.value) || 12 }
                          }
                        })}
                        className="w-14 px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                        min={8}
                        max={24}
                      />
                      <span className="text-xs text-gray-500">px</span>
                    </div>
                    <label className="flex items-center gap-1 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={style.bold}
                        onChange={(e) => setConfig({
                          ...config,
                          fontStyles: {
                            ...config.fontStyles,
                            [item.key]: { ...style, bold: e.target.checked }
                          }
                        })}
                        className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                      />
                      <span className="text-xs font-bold text-gray-700">B</span>
                    </label>
                    <label className="flex items-center gap-1 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={style.italic}
                        onChange={(e) => setConfig({
                          ...config,
                          fontStyles: {
                            ...config.fontStyles,
                            [item.key]: { ...style, italic: e.target.checked }
                          }
                        })}
                        className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                      />
                      <span className="text-xs italic text-gray-700">I</span>
                    </label>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <div className="flex items-center gap-2 mb-3">
              <Calendar className="w-5 h-5 text-blue-600" />
              <h2 className="font-semibold text-gray-900">Service Intervals</h2>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {OIL_TYPES.map((oilType) => {
                const interval = config.intervals?.[oilType.key] ?? DEFAULT_INTERVALS[oilType.key];
                return (
                  <div key={oilType.key} className="p-3 bg-gray-50 rounded-lg">
                    <div className="font-medium text-gray-900 text-sm mb-2">{oilType.label}</div>
                    <div className="space-y-2">
                      <div>
                        <label className="block text-xs text-gray-600">{config.useKilometers ? "km" : "Miles"}</label>
                        <input
                          type="number"
                          value={interval.mileage}
                          onChange={(e) => updateInterval(oilType.key, "mileage", Number(e.target.value) || 0)}
                          className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                          min={0}
                          step={500}
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-600">Months</label>
                        <input
                          type="number"
                          value={interval.months}
                          onChange={(e) => updateInterval(oilType.key, "months", Number(e.target.value) || 0)}
                          className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                          min={1}
                          max={24}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <button
            onClick={saveSettings}
            disabled={saving}
            className="w-full px-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2 font-medium"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            Save Settings
          </button>
        </div>

        <div className="w-80 flex-shrink-0">
          <div className="sticky top-6 space-y-6">
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <h2 className="font-semibold text-gray-900 mb-4">Preview</h2>
              <div className="flex justify-center p-4 bg-gray-100 rounded-lg relative">
                {previewUrl ? (
                  <div className="relative">
                    <img 
                      src={previewUrl} 
                      alt="Sticker Preview" 
                      className="rounded shadow-md"
                      style={{ 
                        width: "200px",
                        height: config.defaultSize === "2x2" ? "200px" : 
                                config.defaultSize === "2x2.5" ? "250px" : 
                                config.defaultSize === "2x3" ? "300px" : "350px",
                      }}
                    />
                    {previewLoading && (
                      <div className="absolute inset-0 bg-white/50 flex items-center justify-center rounded">
                        <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
                      </div>
                    )}
                  </div>
                ) : (
                  <div 
                    className="rounded shadow-md bg-white flex items-center justify-center"
                    style={{ 
                      width: "200px",
                      height: config.defaultSize === "2x2" ? "200px" : 
                              config.defaultSize === "2x2.5" ? "250px" : 
                              config.defaultSize === "2x3" ? "300px" : "350px",
                    }}
                  >
                    <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                  </div>
                )}
              </div>
              <p className="text-xs text-gray-500 text-center mt-3">
                Sample preview with {config.roundMileage ? "rounded" : "exact"} mileage
              </p>
            </div>

            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <h2 className="font-semibold text-gray-900 mb-3">Download</h2>
              <div className="grid grid-cols-2 gap-2 mb-3">
                {STICKER_SIZES.map((size) => (
                  <button
                    key={size.value}
                    onClick={() => setConfig({ ...config, defaultSize: size.value })}
                    className={`px-3 py-2 text-sm rounded-lg border transition-colors ${
                      config.defaultSize === size.value
                        ? "border-blue-600 bg-blue-50 text-blue-700"
                        : "border-gray-200 hover:border-gray-300"
                    }`}
                  >
                    {size.label}
                  </button>
                ))}
              </div>
              <button
                onClick={downloadSticker}
                disabled={downloading}
                className="w-full px-4 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                Download {STICKER_SIZES.find(s => s.value === config.defaultSize)?.label}
              </button>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
