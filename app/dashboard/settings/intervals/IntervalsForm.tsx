"use client";

import { useState } from "react";
import { Wrench, RotateCcw, Save, Check } from "lucide-react";
import type { ShopInterval } from "./page";

type Props = {
  intervals: ShopInterval[];
  saveAction: (formData: FormData) => Promise<void>;
  resetAction: () => Promise<void>;
};

export default function IntervalsForm({ intervals, saveAction, resetAction }: Props) {
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    const formData = new FormData(e.currentTarget);
    await saveAction(formData);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleReset = async () => {
    if (!confirm("Reset all intervals to OEM defaults? This will clear all your custom settings.")) return;
    setResetting(true);
    await resetAction();
    setResetting(false);
    window.location.reload();
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="font-semibold text-gray-900 flex items-center gap-2">
            <Wrench className="w-5 h-5 text-gray-500" />
            Service Intervals
          </h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleReset}
              disabled={resetting}
              className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded-lg transition-colors flex items-center gap-1.5"
            >
              <RotateCcw className={`w-4 h-4 ${resetting ? "animate-spin" : ""}`} />
              Reset to OEM
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Service
                </th>
                <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider w-24">
                  Use Shop
                </th>
                <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider w-32">
                  Miles
                </th>
                <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider w-32">
                  Months
                </th>
                <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider w-40">
                  OEM Default
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {intervals.map((svc) => (
                <IntervalRow key={svc.key} interval={svc} />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={saving}
          className="px-6 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium flex items-center gap-2 disabled:opacity-50"
        >
          {saved ? (
            <>
              <Check className="w-5 h-5" />
              Saved!
            </>
          ) : saving ? (
            <>
              <span className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
              Saving...
            </>
          ) : (
            <>
              <Save className="w-5 h-5" />
              Save Intervals
            </>
          )}
        </button>
      </div>
    </form>
  );
}

function IntervalRow({ interval }: { interval: ShopInterval }) {
  const [useShop, setUseShop] = useState(interval.useShop);

  const defaultDisplay = [
    interval.defaultMiles ? `${interval.defaultMiles.toLocaleString()} mi` : null,
    interval.defaultMonths ? `${interval.defaultMonths} mo` : null,
  ].filter(Boolean).join(" / ") || "—";

  return (
    <tr className={useShop ? "bg-green-50" : ""}>
      <td className="px-4 py-3">
        <span className="font-medium text-gray-900">{interval.name}</span>
      </td>
      <td className="px-4 py-3 text-center">
        <input
          type="checkbox"
          name={`${interval.key}_useShop`}
          checked={useShop}
          onChange={(e) => setUseShop(e.target.checked)}
          className="w-5 h-5 rounded border-gray-300 text-green-600 focus:ring-green-500"
        />
      </td>
      <td className="px-4 py-3">
        <input
          type="number"
          name={`${interval.key}_miles`}
          defaultValue={interval.miles ?? ""}
          placeholder={interval.defaultMiles?.toLocaleString() ?? "—"}
          disabled={!useShop}
          min={0}
          step={1000}
          className={`w-full px-3 py-1.5 border rounded-lg text-center text-sm ${
            useShop 
              ? "border-gray-300 bg-white focus:ring-2 focus:ring-green-500 focus:border-green-500" 
              : "border-gray-200 bg-gray-100 text-gray-400 cursor-not-allowed"
          }`}
        />
      </td>
      <td className="px-4 py-3">
        <input
          type="number"
          name={`${interval.key}_months`}
          defaultValue={interval.months ?? ""}
          placeholder={interval.defaultMonths?.toString() ?? "—"}
          disabled={!useShop}
          min={0}
          className={`w-full px-3 py-1.5 border rounded-lg text-center text-sm ${
            useShop 
              ? "border-gray-300 bg-white focus:ring-2 focus:ring-green-500 focus:border-green-500" 
              : "border-gray-200 bg-gray-100 text-gray-400 cursor-not-allowed"
          }`}
        />
      </td>
      <td className="px-4 py-3 text-center text-sm text-gray-500">
        {defaultDisplay}
      </td>
    </tr>
  );
}
