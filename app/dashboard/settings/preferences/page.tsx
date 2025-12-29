"use client";

import { useState, useEffect } from "react";
import { Settings, Loader2, Check, Globe } from "lucide-react";

export default function PreferencesPage() {
  const [distanceUnit, setDistanceUnit] = useState("miles");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetchPreferences();
  }, []);

  async function fetchPreferences() {
    try {
      const res = await fetch("/api/settings/preferences");
      if (res.ok) {
        const data = await res.json();
        setDistanceUnit(data.distanceUnit || "miles");
      }
    } catch (err) {
      console.error("Failed to fetch preferences:", err);
    } finally {
      setLoading(false);
    }
  }

  async function savePreferences() {
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch("/api/settings/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ distanceUnit }),
      });
      if (res.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } catch (err) {
      console.error("Failed to save preferences:", err);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex-1 p-8">
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 p-8 overflow-auto">
      <div className="max-w-3xl mx-auto space-y-8">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-blue-100 rounded-lg">
            <Settings className="w-6 h-6 text-blue-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Preferences</h1>
            <p className="text-sm text-gray-500">Customize how information is displayed</p>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <div className="flex items-center gap-3 mb-6">
            <Globe className="w-5 h-5 text-gray-500" />
            <h2 className="text-lg font-semibold text-gray-900">Regional Settings</h2>
          </div>

          <div className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Distance Unit
              </label>
              <p className="text-sm text-gray-500 mb-3">
                Choose how mileage and distances are displayed throughout the app
              </p>
              <div className="flex gap-4">
                <label className="flex items-center gap-3 p-4 border rounded-lg cursor-pointer hover:bg-gray-50 transition-colors flex-1">
                  <input
                    type="radio"
                    name="distanceUnit"
                    value="miles"
                    checked={distanceUnit === "miles"}
                    onChange={(e) => setDistanceUnit(e.target.value)}
                    className="w-4 h-4 text-blue-600"
                  />
                  <div>
                    <p className="font-medium text-gray-900">Miles</p>
                    <p className="text-sm text-gray-500">Used in USA, UK, and others</p>
                  </div>
                </label>
                <label className="flex items-center gap-3 p-4 border rounded-lg cursor-pointer hover:bg-gray-50 transition-colors flex-1">
                  <input
                    type="radio"
                    name="distanceUnit"
                    value="kilometers"
                    checked={distanceUnit === "kilometers"}
                    onChange={(e) => setDistanceUnit(e.target.value)}
                    className="w-4 h-4 text-blue-600"
                  />
                  <div>
                    <p className="font-medium text-gray-900">Kilometers</p>
                    <p className="text-sm text-gray-500">Used in Canada, Europe, and most countries</p>
                  </div>
                </label>
              </div>
            </div>
          </div>

          <div className="mt-8 pt-6 border-t flex justify-end">
            <button
              onClick={savePreferences}
              disabled={saving}
              className="flex items-center gap-2 px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : saved ? (
                <Check className="w-4 h-4" />
              ) : null}
              {saved ? "Saved!" : saving ? "Saving..." : "Save Preferences"}
            </button>
          </div>
        </div>

        <div className="bg-blue-50 rounded-xl p-4 border border-blue-100">
          <p className="text-sm text-blue-800">
            Distance settings will apply to all vehicle maintenance recommendations and mileage displays.
          </p>
        </div>
      </div>
    </div>
  );
}
