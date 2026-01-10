"use client";

import { useState } from "react";
import { Save, RotateCcw } from "lucide-react";

type Props = {
  initial: {
    dueSoonMiles: number;
    dueSoonDays: number;
  };
  action: (formData: FormData) => Promise<void>;
  distanceUnit: "miles" | "kilometers";
};

const MILES_TO_KM = 1.60934;
const KM_TO_MILES = 0.621371;

const PRESETS_MILES = [
  { label: "Conservative", miles: 1000, days: 30, description: "Alert at 1,000 miles / 30 days" },
  { label: "Standard", miles: 3000, days: 90, description: "Alert at 3,000 miles / 90 days" },
  { label: "Extended", miles: 5000, days: 180, description: "Alert at 5,000 miles / 6 months" },
];

const PRESETS_KM = [
  { label: "Conservative", miles: 1000, km: 1600, days: 30, description: "Alert at 1,600 km / 30 days" },
  { label: "Standard", miles: 3000, km: 4800, days: 90, description: "Alert at 4,800 km / 90 days" },
  { label: "Extended", miles: 5000, km: 8000, days: 180, description: "Alert at 8,000 km / 6 months" },
];

export default function MaintenanceForm({ initial, action, distanceUnit }: Props) {
  const isKm = distanceUnit === "kilometers";
  const PRESETS = isKm ? PRESETS_KM : PRESETS_MILES;
  
  const [miles, setMiles] = useState(initial.dueSoonMiles);
  const [days, setDays] = useState(initial.dueSoonDays);
  
  const displayDistance = isKm ? Math.round(miles * MILES_TO_KM) : miles;
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const hasChanges = miles !== initial.dueSoonMiles || days !== initial.dueSoonDays;

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);

    const formData = new FormData();
    formData.set("dueSoonMiles", String(miles));
    formData.set("dueSoonDays", String(days));

    try {
      await action(formData);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } finally {
      setSaving(false);
    }
  }

  function applyPreset(preset: typeof PRESETS[0]) {
    setMiles(preset.miles);
    setDays(preset.days);
  }

  function reset() {
    setMiles(initial.dueSoonMiles);
    setDays(initial.dueSoonDays);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">Quick Presets</label>
        <div className="grid grid-cols-3 gap-3">
          {PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              onClick={() => applyPreset(preset)}
              className={`p-3 rounded-lg border text-left transition-all ${
                miles === preset.miles && days === preset.days
                  ? "border-blue-500 bg-blue-50 ring-2 ring-blue-200"
                  : "border-gray-200 hover:border-gray-300 hover:bg-gray-50"
              }`}
            >
              <div className="font-medium text-sm text-gray-900">{preset.label}</div>
              <div className="text-xs text-gray-500 mt-0.5">{preset.description}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="dueSoonMiles" className="block text-sm font-medium text-gray-700 mb-1">
            {isKm ? "Kilometers" : "Miles"} Before Due
          </label>
          <div className="relative">
            <input
              type="number"
              id="dueSoonMiles"
              name="dueSoonMiles"
              min="0"
              max={isKm ? 80000 : 50000}
              step="100"
              value={displayDistance}
              onChange={(e) => {
                const val = Math.max(0, parseInt(e.target.value) || 0);
                setMiles(isKm ? Math.round(val * KM_TO_MILES) : val);
              }}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">{isKm ? "km" : "mi"}</span>
          </div>
          <p className="text-xs text-gray-500 mt-1">
            Items will show as "Due Soon" when within this many {isKm ? "kilometers" : "miles"}
          </p>
        </div>

        <div>
          <label htmlFor="dueSoonDays" className="block text-sm font-medium text-gray-700 mb-1">
            Days Before Due
          </label>
          <div className="relative">
            <input
              type="number"
              id="dueSoonDays"
              name="dueSoonDays"
              min="0"
              max="365"
              step="1"
              value={days}
              onChange={(e) => setDays(Math.max(0, parseInt(e.target.value) || 0))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">days</span>
          </div>
          <p className="text-xs text-gray-500 mt-1">
            Items will show as "Due Soon" when within this many days
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between pt-4 border-t border-gray-200">
        <button
          type="button"
          onClick={reset}
          disabled={!hasChanges || saving}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 hover:text-gray-900 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <RotateCcw className="w-4 h-4" />
          Reset
        </button>

        <div className="flex items-center gap-3">
          {saved && (
            <span className="text-sm text-green-600 font-medium">Settings saved!</span>
          )}
          <button
            type="submit"
            disabled={!hasChanges || saving}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Save className="w-4 h-4" />
            {saving ? "Saving..." : "Save Changes"}
          </button>
        </div>
      </div>
    </form>
  );
}
