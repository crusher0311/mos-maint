"use client";

import { useState, useEffect } from "react";
import { Palette, Eye, Loader2, Save } from "lucide-react";

interface BrandingEditorProps {
  entityType: string;
  entityId: string;
  entityName: string;
  logo?: string | null;
  favicon?: string | null;
  primaryColor?: string | null;
  secondaryColor?: string | null;
  accentColor?: string | null;
  headerColor?: string | null;
  buttonColor?: string | null;
  buttonTextColor?: string | null;
  onSaved?: (data: Record<string, string>) => void;
}

export default function BrandingEditor({
  entityType,
  entityId,
  entityName,
  logo: initialLogo,
  favicon: initialFavicon,
  primaryColor: initialPrimary,
  secondaryColor: initialSecondary,
  accentColor: initialAccent,
  headerColor: initialHeader,
  buttonColor: initialButton,
  buttonTextColor: initialButtonText,
  onSaved,
}: BrandingEditorProps) {
  const [form, setForm] = useState({
    logo: initialLogo || "",
    favicon: initialFavicon || "",
    primaryColor: initialPrimary || "#3c81c3",
    secondaryColor: initialSecondary || "#1e5a8a",
    accentColor: initialAccent || "#7ab3e0",
    headerColor: initialHeader || "#ffffff",
    buttonColor: initialButton || "#3c81c3",
    buttonTextColor: initialButtonText || "#ffffff",
  });
  const [saving, setSaving] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setForm({
      logo: initialLogo || "",
      favicon: initialFavicon || "",
      primaryColor: initialPrimary || "#3c81c3",
      secondaryColor: initialSecondary || "#1e5a8a",
      accentColor: initialAccent || "#7ab3e0",
      headerColor: initialHeader || "#ffffff",
      buttonColor: initialButton || "#3c81c3",
      buttonTextColor: initialButtonText || "#ffffff",
    });
  }, [entityId, initialLogo, initialFavicon, initialPrimary, initialSecondary, initialAccent, initialHeader, initialButton, initialButtonText]);

  const apiPath = `/api/platform-admin/crm/${entityType === "parent_org" ? "parent-orgs" : entityType + "s"}/${entityId}`;

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch(apiPath, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (data.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
        onSaved?.(form);
      }
    } catch (err) {
      console.error("Error saving branding:", err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Palette className="w-5 h-5 text-[#3c81c3]" />
          <h3 className="text-lg font-semibold text-gray-900">Branding Customization</h3>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowPreview(!showPreview)} className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">
            <Eye className="w-4 h-4" /> {showPreview ? "Hide Preview" : "Preview"}
          </button>
          <button onClick={handleSave} disabled={saving} className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-[#3c81c3] text-white rounded-lg hover:bg-[#2d6aa3] disabled:opacity-50">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {saved ? "Saved!" : "Save Branding"}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="space-y-4">
          <h4 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Logo & Favicon</h4>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Logo URL</label>
            <input value={form.logo} onChange={(e) => setForm({ ...form, logo: e.target.value })} placeholder="https://example.com/logo.png" className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] focus:border-transparent text-sm" />
            {form.logo && (
              <div className="mt-2 p-2 bg-gray-50 rounded border border-gray-200">
                <img src={form.logo} alt="Logo preview" className="max-h-12 object-contain" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
              </div>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Favicon URL</label>
            <input value={form.favicon} onChange={(e) => setForm({ ...form, favicon: e.target.value })} placeholder="https://example.com/favicon.ico" className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] focus:border-transparent text-sm" />
          </div>
        </div>

        <div className="space-y-4">
          <h4 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Brand Colors</h4>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Primary</label>
              <div className="flex items-center gap-2">
                <input type="color" value={form.primaryColor} onChange={(e) => setForm({ ...form, primaryColor: e.target.value })} className="w-10 h-10 rounded cursor-pointer border border-gray-300" />
                <input value={form.primaryColor} onChange={(e) => setForm({ ...form, primaryColor: e.target.value })} className="flex-1 px-2 py-1.5 border border-gray-300 rounded text-xs font-mono" />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Secondary</label>
              <div className="flex items-center gap-2">
                <input type="color" value={form.secondaryColor} onChange={(e) => setForm({ ...form, secondaryColor: e.target.value })} className="w-10 h-10 rounded cursor-pointer border border-gray-300" />
                <input value={form.secondaryColor} onChange={(e) => setForm({ ...form, secondaryColor: e.target.value })} className="flex-1 px-2 py-1.5 border border-gray-300 rounded text-xs font-mono" />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Accent</label>
              <div className="flex items-center gap-2">
                <input type="color" value={form.accentColor} onChange={(e) => setForm({ ...form, accentColor: e.target.value })} className="w-10 h-10 rounded cursor-pointer border border-gray-300" />
                <input value={form.accentColor} onChange={(e) => setForm({ ...form, accentColor: e.target.value })} className="flex-1 px-2 py-1.5 border border-gray-300 rounded text-xs font-mono" />
              </div>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Header</label>
              <div className="flex items-center gap-2">
                <input type="color" value={form.headerColor} onChange={(e) => setForm({ ...form, headerColor: e.target.value })} className="w-10 h-10 rounded cursor-pointer border border-gray-300" />
                <input value={form.headerColor} onChange={(e) => setForm({ ...form, headerColor: e.target.value })} className="flex-1 px-2 py-1.5 border border-gray-300 rounded text-xs font-mono" />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Button</label>
              <div className="flex items-center gap-2">
                <input type="color" value={form.buttonColor} onChange={(e) => setForm({ ...form, buttonColor: e.target.value })} className="w-10 h-10 rounded cursor-pointer border border-gray-300" />
                <input value={form.buttonColor} onChange={(e) => setForm({ ...form, buttonColor: e.target.value })} className="flex-1 px-2 py-1.5 border border-gray-300 rounded text-xs font-mono" />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Btn Text</label>
              <div className="flex items-center gap-2">
                <input type="color" value={form.buttonTextColor} onChange={(e) => setForm({ ...form, buttonTextColor: e.target.value })} className="w-10 h-10 rounded cursor-pointer border border-gray-300" />
                <input value={form.buttonTextColor} onChange={(e) => setForm({ ...form, buttonTextColor: e.target.value })} className="flex-1 px-2 py-1.5 border border-gray-300 rounded text-xs font-mono" />
              </div>
            </div>
          </div>
        </div>
      </div>

      {showPreview && (
        <div className="border border-gray-200 rounded-xl overflow-hidden">
          <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 text-xs font-medium text-gray-500">BRANDING PREVIEW</div>
          <div className="p-6">
            <div className="rounded-lg overflow-hidden border border-gray-200">
              <div className="h-12 flex items-center px-4 gap-3" style={{ backgroundColor: form.headerColor || form.primaryColor }}>
                {form.logo ? (
                  <img src={form.logo} alt="Logo" className="h-8 object-contain" />
                ) : (
                  <div className="font-bold text-sm" style={{ color: form.primaryColor }}>{entityName}</div>
                )}
                <div className="flex-1" />
                <div className="px-3 py-1 rounded text-xs" style={{ backgroundColor: form.buttonColor, color: form.buttonTextColor }}>Action</div>
              </div>
              <div className="p-4 bg-white">
                <div className="text-lg font-bold mb-2" style={{ color: form.secondaryColor }}>Dashboard</div>
                <div className="flex gap-2 mb-3">
                  <div className="h-20 flex-1 rounded" style={{ backgroundColor: form.primaryColor + "15" }} />
                  <div className="h-20 flex-1 rounded" style={{ backgroundColor: form.secondaryColor + "15" }} />
                  <div className="h-20 flex-1 rounded" style={{ backgroundColor: form.accentColor + "15" }} />
                </div>
                <div className="flex gap-2">
                  <div className="px-3 py-1.5 rounded text-white text-xs" style={{ backgroundColor: form.primaryColor }}>Primary</div>
                  <div className="px-3 py-1.5 rounded text-white text-xs" style={{ backgroundColor: form.secondaryColor }}>Secondary</div>
                  <div className="px-3 py-1.5 rounded text-white text-xs" style={{ backgroundColor: form.accentColor }}>Accent</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
