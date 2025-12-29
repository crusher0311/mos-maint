"use client";

import { useState, useEffect } from "react";
import { Settings, Save, Loader2 } from "lucide-react";

interface PlatformSettings {
  trial: {
    vinLimit: number;
  };
}

export default function PlatformSettingsPage() {
  const [settings, setSettings] = useState<PlatformSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [vinLimit, setVinLimit] = useState("");
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const res = await fetch("/api/platform-admin/settings");
      const data = await res.json();
      if (data.ok) {
        setSettings(data.settings);
        setVinLimit(String(data.settings.trial.vinLimit));
      }
    } catch (err) {
      console.error("Error loading settings:", err);
    } finally {
      setLoading(false);
    }
  };

  const saveTrialSettings = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/platform-admin/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "trial",
          settings: { vinLimit: Number(vinLimit) },
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setMessage({ type: "success", text: data.message });
        loadSettings();
      } else {
        setMessage({ type: "error", text: data.error || "Failed to save" });
      }
    } catch (err) {
      setMessage({ type: "error", text: "Failed to save settings" });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="p-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-1/4"></div>
          <div className="h-64 bg-gray-200 rounded-lg"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Platform Settings</h1>
        <p className="text-gray-600">Configure platform-wide defaults</p>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 space-y-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-purple-100 rounded-lg">
            <Settings className="w-5 h-5 text-purple-600" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Trial Settings</h2>
            <p className="text-sm text-gray-500">Configure default trial limits for new shops</p>
          </div>
        </div>

        <div className="grid gap-4 max-w-md">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Default Trial VIN Limit
            </label>
            <p className="text-xs text-gray-500 mb-2">
              Number of unique VINs a shop can view during their free trial. 
              Can be overridden per-shop from the Shops page.
            </p>
            <div className="flex gap-2">
              <input
                type="number"
                min="1"
                value={vinLimit}
                onChange={(e) => setVinLimit(e.target.value)}
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
              />
              <button
                onClick={saveTrialSettings}
                disabled={saving || !vinLimit || Number(vinLimit) < 1}
                className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {saving ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Save className="w-4 h-4" />
                )}
                Save
              </button>
            </div>
          </div>

          {message && (
            <div className={`px-4 py-2 rounded-lg text-sm ${
              message.type === "success" 
                ? "bg-green-50 text-green-700 border border-green-200" 
                : "bg-red-50 text-red-700 border border-red-200"
            }`}>
              {message.text}
            </div>
          )}
        </div>

        <div className="pt-4 border-t border-gray-100">
          <p className="text-sm text-gray-500">
            Current default: <span className="font-medium text-gray-900">{settings?.trial.vinLimit} VINs</span>
          </p>
        </div>
      </div>
    </div>
  );
}
