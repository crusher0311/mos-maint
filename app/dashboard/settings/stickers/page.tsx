"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Loader2, Check, Download, Calendar, Settings2, Upload, ChevronDown, ChevronRight, RefreshCw, Save } from "lucide-react";
import { StickerDesigner } from "@/components/sticker-designer";
import { StickerLayout, createDefaultLayout, getStickerSize, DEFAULT_STICKER_SIZE } from "@/lib/sticker-designer-types";

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

interface StickerDataConfig {
  enabled: boolean;
  logo: string;
  phone: string;
  tagline: string;
  taglineLine2: string;
  serviceLabel: string;
  showQRCode: boolean;
  roundMileage: boolean;
  usePredictiveDate: boolean;
  defaultSize: string;
  appointmentUrl: string;
  useKilometers: boolean;
  intervals: IntervalsConfig;
  defaultOilType: keyof IntervalsConfig;
  designerLayout?: StickerLayout;
}

const STICKER_SIZES = [
  { value: "1.5x2.25", label: "1.5\" x 2.25\" (Mono)" },
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

const DEFAULT_CONFIG: StickerDataConfig = {
  enabled: true,
  logo: "",
  phone: "",
  tagline: "",
  taglineLine2: "",
  serviceLabel: "Next Oil Service",
  showQRCode: true,
  roundMileage: true,
  usePredictiveDate: false,
  defaultSize: DEFAULT_STICKER_SIZE,
  appointmentUrl: "",
  useKilometers: false,
  intervals: DEFAULT_INTERVALS,
  defaultOilType: "synthetic",
};

export default function StickerSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [regeneratingQr, setRegeneratingQr] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const [config, setConfig] = useState<StickerDataConfig>(DEFAULT_CONFIG);
  const [designerLayout, setDesignerLayout] = useState<StickerLayout>(() => createDefaultLayout(DEFAULT_STICKER_SIZE));
  const [currentSize, setCurrentSize] = useState(DEFAULT_STICKER_SIZE);
  
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'unsaved'>('saved');
  const autoSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasInitializedRef = useRef(false);
  
  const [expandedSections, setExpandedSections] = useState({
    content: true,
    intervals: true,
    options: false,
  });

  const toggleSection = (section: keyof typeof expandedSections) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  useEffect(() => {
    fetchSettings();
  }, []);

  useEffect(() => {
    if (!loading) {
      refreshQrPreview();
    }
  }, [config.showQRCode, loading]);

  // Auto-save effect - saves 1.5 seconds after user stops making changes
  useEffect(() => {
    // Skip until initial load is complete
    if (loading || !hasInitializedRef.current) {
      if (!loading) {
        hasInitializedRef.current = true;
      }
      return;
    }

    // Clear any existing timeout
    if (autoSaveTimeoutRef.current) {
      clearTimeout(autoSaveTimeoutRef.current);
    }

    setSaveStatus('unsaved');

    // Set new timeout for auto-save
    autoSaveTimeoutRef.current = setTimeout(async () => {
      setSaveStatus('saving');
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
            defaultSize: currentSize,
            appointmentUrl: config.appointmentUrl,
            useKilometers: config.useKilometers,
            intervals: config.intervals,
            defaultOilType: config.defaultOilType,
            designerLayout: designerLayout,
          }),
        });
        
        if (res.ok) {
          setSaveStatus('saved');
        } else {
          console.error('Auto-save failed');
          setSaveStatus('unsaved');
        }
      } catch (error) {
        console.error('Auto-save failed:', error);
        setSaveStatus('unsaved');
      }
    }, 1500);

    return () => {
      if (autoSaveTimeoutRef.current) {
        clearTimeout(autoSaveTimeoutRef.current);
      }
    };
  }, [config, designerLayout, currentSize, loading]);

  async function fetchSettings() {
    try {
      const res = await fetch("/api/sticker/settings");
      if (res.ok) {
        const data = await res.json();
        if (data.config) {
          const fetchedConfig = {
            enabled: data.config.enabled ?? DEFAULT_CONFIG.enabled,
            logo: data.config.logo ?? DEFAULT_CONFIG.logo,
            phone: data.config.phone ?? DEFAULT_CONFIG.phone,
            tagline: data.config.tagline ?? DEFAULT_CONFIG.tagline,
            taglineLine2: data.config.taglineLine2 ?? DEFAULT_CONFIG.taglineLine2,
            serviceLabel: data.config.serviceLabel ?? DEFAULT_CONFIG.serviceLabel,
            showQRCode: data.config.showQRCode ?? DEFAULT_CONFIG.showQRCode,
            roundMileage: data.config.roundMileage ?? DEFAULT_CONFIG.roundMileage,
            usePredictiveDate: data.config.usePredictiveDate ?? DEFAULT_CONFIG.usePredictiveDate,
            defaultSize: data.config.defaultSize ?? DEFAULT_CONFIG.defaultSize,
            appointmentUrl: data.config.appointmentUrl ?? DEFAULT_CONFIG.appointmentUrl,
            useKilometers: data.config.useKilometers ?? DEFAULT_CONFIG.useKilometers,
            intervals: {
              diesel: data.config.intervals?.diesel ?? DEFAULT_INTERVALS.diesel,
              euro: data.config.intervals?.euro ?? DEFAULT_INTERVALS.euro,
              synthetic: data.config.intervals?.synthetic ?? DEFAULT_INTERVALS.synthetic,
              conventional: data.config.intervals?.conventional ?? DEFAULT_INTERVALS.conventional,
            },
            defaultOilType: data.config.defaultOilType ?? DEFAULT_CONFIG.defaultOilType,
          };
          setConfig(fetchedConfig);
          setCurrentSize(fetchedConfig.defaultSize);
          
          if (data.config.designerLayout) {
            setDesignerLayout(data.config.designerLayout);
          } else {
            setDesignerLayout(createDefaultLayout(fetchedConfig.defaultSize));
          }
        }
      }
    } catch (err) {
      console.error("Failed to fetch sticker settings:", err);
    } finally {
      setLoading(false);
    }
  }

  async function refreshQrPreview() {
    if (!config.showQRCode) {
      setQrUrl(null);
      return;
    }
    try {
      // Use cached QR endpoint
      const res = await fetch(`/api/sticker/qr-cache`);
      if (res.ok) {
        const blob = await res.blob();
        setQrUrl(URL.createObjectURL(blob));
      }
    } catch (err) {
      console.error("Failed to load QR preview:", err);
    }
  }

  async function regenerateQrCode() {
    setRegeneratingQr(true);
    setMessage(null);
    try {
      // Use cached QR endpoint to regenerate
      const res = await fetch("/api/sticker/qr-cache", {
        method: "POST",
      });
      if (res.ok) {
        setMessage({ type: "success", text: "QR code regenerated and cached" });
        refreshQrPreview();
      } else {
        const data = await res.json();
        setMessage({ type: "error", text: data.error || "Failed to regenerate QR code" });
      }
    } catch (err) {
      console.error("Failed to regenerate QR code:", err);
      setMessage({ type: "error", text: "Failed to regenerate QR code" });
    } finally {
      setRegeneratingQr(false);
    }
  }

  const handleDesignerChange = useCallback((layout: StickerLayout, size: string) => {
    setDesignerLayout(layout);
    setCurrentSize(size);
    setConfig(prev => ({ ...prev, defaultSize: size }));
  }, []);

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
          defaultSize: currentSize,
          appointmentUrl: config.appointmentUrl,
          useKilometers: config.useKilometers,
          intervals: config.intervals,
          designerLayout: designerLayout,
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
    
    // Debug: log QR code position from current layout
    const qrElement = designerLayout.elements.find(e => e.type === 'qrCode');
    console.log('[Download] QR Code position:', qrElement ? { x: qrElement.x, y: qrElement.y } : 'not found');
    console.log('[Download] Canvas height:', designerLayout.canvasHeight);
    
    try {
      const res = await fetch("/api/sticker/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          size: currentSize,
          includeQR: config.showQRCode,
          designerLayout: designerLayout,
          dataConfig: {
            logo: config.logo,
            phone: config.phone,
            tagline: config.tagline,
            taglineLine2: config.taglineLine2,
            serviceLabel: config.serviceLabel,
            useKilometers: config.useKilometers,
            roundMileage: config.roundMileage,
          },
          nextServiceMileage: config.roundMileage ? 165000 : 165123,
          nextServiceDate: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
        }),
      });
      
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `oil-sticker-${currentSize}.png`;
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

    if (file.size > 500 * 1024) {
      setMessage({ type: "error", text: "File size must be under 500KB" });
      return;
    }

    setUploading(true);
    setMessage(null);

    try {
      // Convert file to base64
      const base64Data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          const base64 = result.split(",")[1];
          resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      const res = await fetch("/api/sticker/upload-logo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contentType: file.type,
          base64Data,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to upload logo");
      }

      const { logoUrl } = await res.json();
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
    <main className="p-6 max-w-7xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Oil Change Sticker Designer</h1>
        <p className="text-gray-600 mt-1">
          Design your custom oil change stickers with drag-and-drop positioning.
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

      <div className="space-y-6">
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <div 
            className="flex items-center justify-between cursor-pointer"
            onClick={() => toggleSection("content")}
          >
            <h2 className="font-semibold text-gray-900">Sticker Content</h2>
            {expandedSections.content ? <ChevronDown size={20} /> : <ChevronRight size={20} />}
          </div>
          
          {expandedSections.content && (
            <div className="mt-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Shop Logo</label>
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
                <label className="block text-sm font-medium text-gray-700 mb-1">Shop Phone</label>
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
                  placeholder="Your Trusted Auto Care"
                  maxLength={30}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Tagline Line 2</label>
                <input
                  type="text"
                  value={config.taglineLine2}
                  onChange={(e) => setConfig({ ...config, taglineLine2: e.target.value })}
                  placeholder="Since 1985"
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
                <label className="block text-sm font-medium text-gray-700 mb-1">Appointment URL</label>
                <input
                  type="url"
                  value={config.appointmentUrl}
                  onChange={(e) => setConfig({ ...config, appointmentUrl: e.target.value })}
                  placeholder="https://booking.yourshop.com"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            </div>
          )}
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="font-semibold text-gray-900 mb-4">Sticker Designer</h2>
          <StickerDesigner
            initialLayout={designerLayout}
            initialSize={currentSize}
            logoUrl={config.logo || undefined}
            qrUrl={config.showQRCode ? qrUrl || undefined : undefined}
            contentData={{
              phone: config.phone || undefined,
              tagline: config.tagline || undefined,
              taglineLine2: config.taglineLine2 || undefined,
              serviceLabel: config.serviceLabel || undefined,
            }}
            onChange={handleDesignerChange}
          />
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <div 
            className="flex items-center justify-between cursor-pointer"
            onClick={() => toggleSection("options")}
          >
            <div className="flex items-center gap-2">
              <Settings2 className="w-5 h-5 text-blue-600" />
              <h2 className="font-semibold text-gray-900">Sticker Options</h2>
            </div>
            {expandedSections.options ? <ChevronDown size={20} /> : <ChevronRight size={20} />}
          </div>
          
          {expandedSections.options && (
            <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3 p-3 bg-gray-50 rounded-lg">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={config.showQRCode}
                  onChange={(e) => setConfig({ ...config, showQRCode: e.target.checked })}
                  className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700">Show QR code</span>
              </label>
              {config.showQRCode && (
                <button
                  type="button"
                  onClick={regenerateQrCode}
                  disabled={regeneratingQr}
                  className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800 disabled:text-gray-400"
                  title="Refresh the cached QR code image"
                >
                  <RefreshCw size={14} className={regeneratingQr ? "animate-spin" : ""} />
                  {regeneratingQr ? "Regenerating..." : "Refresh QR"}
                </button>
              )}
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
          )}
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <div 
            className="flex items-center justify-between cursor-pointer"
            onClick={() => toggleSection("intervals")}
          >
            <div className="flex items-center gap-2">
              <Calendar className="w-5 h-5 text-blue-600" />
              <h2 className="font-semibold text-gray-900">Service Intervals</h2>
            </div>
            {expandedSections.intervals ? <ChevronDown size={20} /> : <ChevronRight size={20} />}
          </div>

          {expandedSections.intervals && (
            <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3">
              {OIL_TYPES.map((oilType) => {
                const interval = config.intervals?.[oilType.key] ?? DEFAULT_INTERVALS[oilType.key];
                const isDefault = config.defaultOilType === oilType.key;
                return (
                  <div key={oilType.key} className={`p-3 rounded-lg border-2 transition-colors ${isDefault ? "bg-blue-50 border-blue-300" : "bg-gray-50 border-transparent"}`}>
                    <div className="flex items-center justify-between mb-2">
                      <div className="font-medium text-gray-900 text-sm">{oilType.label}</div>
                      {isDefault && (
                        <span className="text-xs bg-blue-600 text-white px-1.5 py-0.5 rounded">Default</span>
                      )}
                    </div>
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
                      <label className="flex items-center gap-2 pt-1 cursor-pointer">
                        <input
                          type="radio"
                          name="defaultOilType"
                          checked={isDefault}
                          onChange={() => setConfig(prev => ({ ...prev, defaultOilType: oilType.key }))}
                          className="w-4 h-4 text-blue-600 focus:ring-blue-500"
                        />
                        <span className="text-xs text-gray-600">Set as default</span>
                      </label>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex gap-4 items-center">
          <div className="flex items-center gap-2">
            {saveStatus === 'saving' && (
              <span className="text-sm text-gray-500 flex items-center gap-1">
                <Loader2 className="w-4 h-4 animate-spin" />
                Saving...
              </span>
            )}
            {saveStatus === 'saved' && (
              <span className="text-sm text-green-600 flex items-center gap-1">
                <Check className="w-4 h-4" />
                Auto-saved
              </span>
            )}
            {saveStatus === 'unsaved' && (
              <span className="text-sm text-amber-600">Unsaved changes</span>
            )}
          </div>
          <button
            onClick={saveSettings}
            disabled={saving || saveStatus === 'saving'}
            className="flex-1 px-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2 font-medium"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Save Settings
          </button>
          
          <button
            onClick={downloadSticker}
            disabled={downloading}
            className="px-6 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            Download Sample
          </button>
        </div>
      </div>
    </main>
  );
}
