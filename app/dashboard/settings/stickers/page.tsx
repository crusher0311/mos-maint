"use client";

import { useState, useEffect } from "react";
import { Loader2, Check, Download, QrCode, Palette, Type, Phone, Link2, Calendar, Gauge, ImageIcon } from "lucide-react";

interface StickerConfig {
  enabled: boolean;
  logo: string;
  phone: string;
  tagline: string;
  serviceLabel: string;
  colors: {
    primary: string;
    secondary: string;
    text: string;
  };
  defaultSize: string;
  appointmentUrl: string;
  useKilometers: boolean;
  defaultMileageInterval: number;
  defaultMonthsInterval: number;
}

const STICKER_SIZES = [
  { value: "2x2", label: "2\" x 2\"" },
  { value: "2x2.5", label: "2\" x 2.5\"" },
  { value: "2x3", label: "2\" x 3\"" },
  { value: "2x3.5", label: "2\" x 3.5\"" },
];

const DEFAULT_CONFIG: StickerConfig = {
  enabled: true,
  logo: "",
  phone: "",
  tagline: "Schedule Service",
  serviceLabel: "Next Oil Service",
  colors: {
    primary: "#cc0000",
    secondary: "#1976d2",
    text: "#ffffff",
  },
  defaultSize: "2x2.5",
  appointmentUrl: "",
  useKilometers: false,
  defaultMileageInterval: 5000,
  defaultMonthsInterval: 6,
};

export default function StickerSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  
  const [config, setConfig] = useState<StickerConfig>(DEFAULT_CONFIG);

  useEffect(() => {
    fetchSettings();
  }, []);

  useEffect(() => {
    if (!loading) {
      refreshQrPreview();
    }
  }, [config.colors.primary, loading]);

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
            serviceLabel: data.config.serviceLabel ?? DEFAULT_CONFIG.serviceLabel,
            colors: {
              primary: data.config.colors?.primary ?? DEFAULT_CONFIG.colors.primary,
              secondary: data.config.colors?.secondary ?? DEFAULT_CONFIG.colors.secondary,
              text: data.config.colors?.text ?? DEFAULT_CONFIG.colors.text,
            },
            defaultSize: data.config.defaultSize ?? DEFAULT_CONFIG.defaultSize,
            appointmentUrl: data.config.appointmentUrl ?? DEFAULT_CONFIG.appointmentUrl,
            useKilometers: data.config.useKilometers ?? DEFAULT_CONFIG.useKilometers,
            defaultMileageInterval: data.config.defaultMileageInterval ?? DEFAULT_CONFIG.defaultMileageInterval,
            defaultMonthsInterval: data.config.defaultMonthsInterval ?? DEFAULT_CONFIG.defaultMonthsInterval,
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
          serviceLabel: config.serviceLabel,
          colors: config.colors,
          defaultSize: config.defaultSize,
          appointmentUrl: config.appointmentUrl,
          useKilometers: config.useKilometers,
          defaultMileageInterval: config.defaultMileageInterval,
          defaultMonthsInterval: config.defaultMonthsInterval,
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

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[300px]">
        <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <main className="p-6 max-w-4xl">
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

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-6">
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <div className="flex items-center gap-2 mb-4">
              <QrCode className="w-5 h-5 text-blue-600" />
              <h2 className="font-semibold text-gray-900">QR Code Settings</h2>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  <div className="flex items-center gap-2">
                    <Link2 className="w-4 h-4" />
                    Appointment URL (optional)
                  </div>
                </label>
                <input
                  type="url"
                  value={config.appointmentUrl}
                  onChange={(e) => setConfig({ ...config, appointmentUrl: e.target.value })}
                  placeholder="https://your-booking-page.com"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Leave empty to use your shop&apos;s default appointment page from your SMS system.
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  <div className="flex items-center gap-2">
                    <Palette className="w-4 h-4" />
                    Accent Color
                  </div>
                </label>
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
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
                  />
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  Color for QR code, date, and mileage on the sticker
                </p>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <div className="flex items-center gap-2 mb-4">
              <Type className="w-5 h-5 text-blue-600" />
              <h2 className="font-semibold text-gray-900">Sticker Content</h2>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  <div className="flex items-center gap-2">
                    <ImageIcon className="w-4 h-4" />
                    Shop Logo URL
                  </div>
                </label>
                <input
                  type="url"
                  value={config.logo}
                  onChange={(e) => setConfig({ ...config, logo: e.target.value })}
                  placeholder="https://your-site.com/logo.png"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
                {config.logo && (
                  <div className="mt-2 p-2 bg-gray-50 rounded-lg">
                    <img 
                      src={config.logo} 
                      alt="Shop logo preview" 
                      className="max-h-16 mx-auto object-contain"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                  </div>
                )}
                <p className="text-xs text-gray-500 mt-1">
                  Your shop logo will appear at the top of the sticker. Use a URL to your logo image.
                </p>
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
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Tagline
                </label>
                <input
                  type="text"
                  value={config.tagline}
                  onChange={(e) => setConfig({ ...config, tagline: e.target.value })}
                  placeholder="Schedule Service"
                  maxLength={30}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Appears below your phone number
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Service Label
                </label>
                <input
                  type="text"
                  value={config.serviceLabel}
                  onChange={(e) => setConfig({ ...config, serviceLabel: e.target.value })}
                  placeholder="Next Oil Service"
                  maxLength={25}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Label above the date/mileage (e.g., &quot;Next Oil Service&quot;, &quot;Service Due&quot;)
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Default Sticker Size
                </label>
                <select
                  value={config.defaultSize}
                  onChange={(e) => setConfig({ ...config, defaultSize: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  {STICKER_SIZES.map((size) => (
                    <option key={size.value} value={size.value}>
                      {size.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id="useKilometers"
                  checked={config.useKilometers}
                  onChange={(e) => setConfig({ ...config, useKilometers: e.target.checked })}
                  className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                />
                <label htmlFor="useKilometers" className="text-sm text-gray-700">
                  Use kilometers instead of miles
                </label>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <div className="flex items-center gap-2 mb-4">
              <Calendar className="w-5 h-5 text-blue-600" />
              <h2 className="font-semibold text-gray-900">Default Service Intervals</h2>
            </div>
            <p className="text-sm text-gray-600 mb-4">
              These defaults will be printed on stickers when generating for customers.
            </p>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  <div className="flex items-center gap-2">
                    <Gauge className="w-4 h-4" />
                    {config.useKilometers ? "Kilometers" : "Miles"} Interval
                  </div>
                </label>
                <select
                  value={config.defaultMileageInterval}
                  onChange={(e) => setConfig({ ...config, defaultMileageInterval: Number(e.target.value) })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  {config.useKilometers ? (
                    <>
                      <option value={5000}>5,000 km</option>
                      <option value={8000}>8,000 km</option>
                      <option value={10000}>10,000 km</option>
                      <option value={15000}>15,000 km</option>
                    </>
                  ) : (
                    <>
                      <option value={3000}>3,000 miles</option>
                      <option value={5000}>5,000 miles</option>
                      <option value={7500}>7,500 miles</option>
                      <option value={10000}>10,000 miles</option>
                    </>
                  )}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  <div className="flex items-center gap-2">
                    <Calendar className="w-4 h-4" />
                    Months Interval
                  </div>
                </label>
                <select
                  value={config.defaultMonthsInterval}
                  onChange={(e) => setConfig({ ...config, defaultMonthsInterval: Number(e.target.value) })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value={3}>3 months</option>
                  <option value={6}>6 months</option>
                  <option value={9}>9 months</option>
                  <option value={12}>12 months</option>
                </select>
              </div>
            </div>
          </div>

          <div className="flex gap-3">
            <button
              onClick={saveSettings}
              disabled={saving}
              className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {saving ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Check className="w-4 h-4" />
              )}
              Save Settings
            </button>
          </div>
        </div>

        <div className="space-y-6">
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="font-semibold text-gray-900 mb-4">QR Code Preview</h2>
            <div className="flex justify-center p-4 bg-gray-50 rounded-lg">
              {qrUrl ? (
                <img 
                  src={qrUrl} 
                  alt="QR Code Preview" 
                  className="w-48 h-48 rounded-lg shadow-sm"
                />
              ) : (
                <div className="w-48 h-48 bg-gray-200 rounded-lg flex items-center justify-center">
                  <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                </div>
              )}
            </div>
            <p className="text-sm text-gray-500 text-center mt-3">
              Customers scan this to schedule an appointment
            </p>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="font-semibold text-gray-900 mb-4">Download Sticker</h2>
            <p className="text-sm text-gray-600 mb-4">
              Generate a print-ready sticker image with your settings.
            </p>
            
            <div className="grid grid-cols-2 gap-2 mb-4">
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
              {downloading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Download className="w-4 h-4" />
              )}
              Download {STICKER_SIZES.find(s => s.value === config.defaultSize)?.label} Sticker
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
