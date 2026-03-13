"use client";

import { useState, Fragment } from "react";
import { Wrench, Save, Check } from "lucide-react";
import type { ShopInterval } from "./page";

type Props = {
  intervals: ShopInterval[];
  distanceUnit: "miles" | "kilometers";
  saveAction: (formData: FormData) => Promise<void>;
};

const MILES_TO_KM = 1.60934;

function convertMilesToKm(miles: number | null): number | null {
  if (miles === null) return null;
  return Math.round(miles * MILES_TO_KM);
}

export default function IntervalsForm({ intervals, distanceUnit, saveAction }: Props) {
  const [saving, setSaving] = useState(false);
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

  const distanceLabel = distanceUnit === "kilometers" ? "KM" : "Miles";
  const distanceAbbr = distanceUnit === "kilometers" ? "km" : "mi";

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <input type="hidden" name="distanceUnit" value={distanceUnit} />
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="font-semibold text-gray-900 flex items-center gap-2">
            <Wrench className="w-5 h-5 text-gray-500" />
            Service Intervals
          </h2>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Service
                </th>
                <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider w-20">
                  Use Shop
                </th>
                <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider w-20">
                  Exclude
                </th>
                <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider w-32">
                  {distanceLabel}
                </th>
                <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider w-28">
                  Months
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {(() => {
                let lastCategory = "";
                return intervals.map((svc) => {
                  const showHeader = svc.category !== lastCategory;
                  lastCategory = svc.category;
                  return (
                    <Fragment key={svc.key}>
                      {showHeader && (
                        <tr className="bg-gray-50">
                          <td colSpan={5} className="px-4 py-2">
                            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">{svc.category}</span>
                          </td>
                        </tr>
                      )}
                      <IntervalRow interval={svc} distanceUnit={distanceUnit} distanceAbbr={distanceAbbr} />
                    </Fragment>
                  );
                });
              })()}
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

function IntervalRow({ interval, distanceUnit, distanceAbbr }: { interval: ShopInterval; distanceUnit: "miles" | "kilometers"; distanceAbbr: string }) {
  const [useShop, setUseShop] = useState(interval.useShop);
  const [excluded, setExcluded] = useState(interval.excluded);

  // Convert stored miles to display units
  const displayDistance = distanceUnit === "kilometers" 
    ? convertMilesToKm(interval.miles) 
    : interval.miles;
  
  const displayDefaultDistance = distanceUnit === "kilometers"
    ? convertMilesToKm(interval.defaultMiles)
    : interval.defaultMiles;

  const isDisabled = excluded || !useShop;
  const rowClass = excluded ? "bg-red-50" : useShop ? "bg-green-50" : "";

  return (
    <tr className={rowClass}>
      <td className="px-4 py-3">
        <span className={`font-medium ${excluded ? "text-gray-400 line-through" : "text-gray-900"}`}>
          {interval.name}
        </span>
      </td>
      <td className="px-4 py-3 text-center">
        <input
          type="checkbox"
          name={`${interval.key}_useShop`}
          checked={useShop}
          onChange={(e) => setUseShop(e.target.checked)}
          disabled={excluded}
          className="w-5 h-5 rounded border-gray-300 text-green-600 focus:ring-green-500 disabled:opacity-50"
        />
      </td>
      <td className="px-4 py-3 text-center">
        <input
          type="checkbox"
          name={`${interval.key}_excluded`}
          checked={excluded}
          onChange={(e) => {
            setExcluded(e.target.checked);
            if (e.target.checked) setUseShop(false);
          }}
          className="w-5 h-5 rounded border-gray-300 text-red-600 focus:ring-red-500"
        />
      </td>
      <td className="px-4 py-3">
        <input
          type="number"
          name={`${interval.key}_distance`}
          defaultValue={displayDistance ?? ""}
          placeholder={displayDefaultDistance?.toLocaleString() ?? "—"}
          disabled={isDisabled}
          min={0}
          step={10}
          className={`w-full px-3 py-1.5 border rounded-lg text-center text-sm ${
            isDisabled
              ? "border-gray-200 bg-gray-100 text-gray-400 cursor-not-allowed"
              : "border-gray-300 bg-white focus:ring-2 focus:ring-green-500 focus:border-green-500"
          }`}
        />
      </td>
      <td className="px-4 py-3">
        <input
          type="number"
          name={`${interval.key}_months`}
          defaultValue={interval.months ?? ""}
          placeholder={interval.defaultMonths?.toString() ?? "—"}
          disabled={isDisabled}
          min={0}
          className={`w-full px-3 py-1.5 border rounded-lg text-center text-sm ${
            isDisabled
              ? "border-gray-200 bg-gray-100 text-gray-400 cursor-not-allowed"
              : "border-gray-300 bg-white focus:ring-2 focus:ring-green-500 focus:border-green-500"
          }`}
        />
      </td>
    </tr>
  );
}
