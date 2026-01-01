"use client";

import { useState, useEffect, useRef } from "react";
import { Upload, Trash2, Loader2, Check, Image as ImageIcon } from "lucide-react";
import CopyFromLocationDropdown from "@/components/ui/CopyFromLocationDropdown";

export default function BrandingPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingLocation, setSavingLocation] = useState(false);
  const [logo, setLogo] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [locationIdentifier, setLocationIdentifier] = useState("");
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchBranding();
  }, []);

  async function fetchBranding() {
    try {
      const res = await fetch("/api/settings/branding");
      if (res.ok) {
        const data = await res.json();
        setLogo(data.logo || null);
        setDisplayName(data.shopName || "");
        setLocationIdentifier(data.locationIdentifier || "");
      }
    } catch (err) {
      console.error("Failed to fetch branding:", err);
    } finally {
      setLoading(false);
    }
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      setMessage({ type: "error", text: "Please upload an image file (PNG, JPG, etc.)" });
      return;
    }

    if (file.size > 500 * 1024) {
      setMessage({ type: "error", text: "Image must be under 500KB. Try compressing the image." });
      return;
    }

    const reader = new FileReader();
    reader.onload = async (event) => {
      const base64 = event.target?.result as string;
      setLogo(base64);
      await saveLogo(base64);
    };
    reader.readAsDataURL(file);
  }

  async function saveLogo(logoData: string) {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/settings/branding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ logo: logoData }),
      });
      
      if (res.ok) {
        setMessage({ type: "success", text: "Logo saved successfully!" });
      } else {
        const data = await res.json();
        setMessage({ type: "error", text: data.error || "Failed to save logo" });
      }
    } catch (err) {
      setMessage({ type: "error", text: "Failed to save logo" });
    } finally {
      setSaving(false);
    }
  }

  async function saveLocationIdentifier() {
    setSavingLocation(true);
    setMessage(null);
    try {
      const res = await fetch("/api/settings/branding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locationIdentifier }),
      });
      
      if (res.ok) {
        setMessage({ type: "success", text: "Location identifier saved!" });
      } else {
        const data = await res.json();
        setMessage({ type: "error", text: data.error || "Failed to save location identifier" });
      }
    } catch (err) {
      setMessage({ type: "error", text: "Failed to save location identifier" });
    } finally {
      setSavingLocation(false);
    }
  }

  async function handleRemoveLogo() {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/settings/branding", { method: "DELETE" });
      if (res.ok) {
        setLogo(null);
        setMessage({ type: "success", text: "Logo removed" });
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    } catch (err) {
      setMessage({ type: "error", text: "Failed to remove logo" });
    } finally {
      setSaving(false);
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
    <main className="p-6 max-w-2xl">
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-2xl font-bold text-gray-900">Shop Branding</h1>
        <CopyFromLocationDropdown
          settingType="branding"
          onCopyComplete={fetchBranding}
          disabled={saving}
        />
      </div>
      <p className="text-gray-600 mb-6">
        Upload your shop logo to display on service history records performed at your shop.
      </p>

      {message && (
        <div className={`mb-4 p-3 rounded-lg flex items-center gap-2 ${
          message.type === "success" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
        }`}>
          {message.type === "success" ? <Check className="w-4 h-4" /> : null}
          {message.text}
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <h2 className="font-semibold text-gray-900 mb-4">Shop Logo</h2>
        <p className="text-sm text-gray-500 mb-4">
          This logo will appear next to service history entries performed at your shop.
          For best results, use a square or horizontal logo under 500KB.
        </p>

        <div className="flex items-start gap-6">
          <div className="flex-shrink-0">
            {logo ? (
              <div className="relative group">
                <div className="w-24 h-24 border-2 border-gray-200 rounded-lg flex items-center justify-center bg-gray-50 overflow-hidden">
                  <img 
                    src={logo} 
                    alt="Shop logo" 
                    className="max-w-full max-h-full object-contain"
                  />
                </div>
                <button
                  onClick={handleRemoveLogo}
                  disabled={saving}
                  className="absolute -top-2 -right-2 p-1 bg-red-500 text-white rounded-full hover:bg-red-600 transition-colors disabled:opacity-50"
                  title="Remove logo"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <div className="w-24 h-24 border-2 border-dashed border-gray-300 rounded-lg flex items-center justify-center bg-gray-50">
                <ImageIcon className="w-8 h-8 text-gray-400" />
              </div>
            )}
          </div>

          <div className="flex-1">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleFileChange}
              className="hidden"
              id="logo-upload"
            />
            <label
              htmlFor="logo-upload"
              className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors cursor-pointer"
            >
              {saving ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Upload className="w-4 h-4" />
              )}
              {logo ? "Change Logo" : "Upload Logo"}
            </label>
            <p className="text-xs text-gray-500 mt-2">
              PNG, JPG, or SVG • Max 500KB
            </p>
          </div>
        </div>

        <div className="mt-6 p-4 bg-gray-50 rounded-lg">
          <h3 className="text-sm font-medium text-gray-700 mb-2">Preview</h3>
          <div className="text-xs text-gray-600 flex items-center gap-1.5">
            <span>Last done at 45,000 mi on 3/15/2024</span>
            {logo ? (
              <img src={logo} alt="Shop" className="h-4" />
            ) : (
              <img src="/badges/protractor.png" alt="Protractor" className="h-4" />
            )}
          </div>
          <p className="text-xs text-gray-500 mt-2">
            {logo 
              ? "Your shop logo will appear next to services performed here." 
              : "Upload a logo to replace the default Protractor badge."}
          </p>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-6 mt-6">
        <h2 className="font-semibold text-gray-900 mb-2">Location Identifier</h2>
        <p className="text-sm text-gray-500 mb-4">
          Add a location identifier to help distinguish this shop location in the sidebar.
          Examples: &quot;Main Street&quot;, &quot;Downtown&quot;, &quot;Store #123&quot;
        </p>

        <div className="flex gap-3">
          <input
            type="text"
            value={locationIdentifier}
            onChange={(e) => setLocationIdentifier(e.target.value)}
            placeholder="e.g., Main Street Location"
            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            maxLength={50}
          />
          <button
            onClick={saveLocationIdentifier}
            disabled={savingLocation}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {savingLocation ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Check className="w-4 h-4" />
            )}
            Save
          </button>
        </div>
        <p className="text-xs text-gray-500 mt-2">
          This will appear below your shop name in the sidebar menu.
        </p>
      </div>
    </main>
  );
}
