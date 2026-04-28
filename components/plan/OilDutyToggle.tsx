"use client";

import { useEffect, useState } from "react";
import { Loader2, Gauge } from "lucide-react";

/**
 * Per-vehicle Normal vs Severe duty toggle for the engine-oil interval
 * (Task #166). Defaults to Severe (the safer assumption); flipping it
 * busts the cached plan so the next reload uses the chosen schedule.
 */
export default function OilDutyToggle({
  vin,
  initialPreference,
}: {
  vin: string;
  initialPreference?: "normal" | "severe";
}) {
  const [pref, setPref] = useState<"normal" | "severe">(initialPreference ?? "severe");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initialPreference) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/vehicles/${vin}/oil-duty`);
        const data = await res.json();
        if (!cancelled && data?.ok) {
          setPref(data.oilDutyPreference === "normal" ? "normal" : "severe");
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vin, initialPreference]);

  async function update(next: "normal" | "severe") {
    if (next === pref) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/vehicles/${vin}/oil-duty`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oilDutyPreference: next }),
      });
      const data = await res.json();
      if (data?.ok) {
        setPref(next);
        // Force the page to rebuild against the new preference. The PATCH
        // endpoint already busted the cached plan.
        if (typeof window !== "undefined") window.location.reload();
      } else {
        setError(data?.error ?? "Failed to update preference");
      }
    } catch (err: any) {
      setError(err?.message ?? "Failed to update preference");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700">
      <Gauge className="w-3.5 h-3.5 text-slate-500" />
      <span className="text-slate-600">Oil duty:</span>
      <button
        type="button"
        onClick={() => update("severe")}
        disabled={saving}
        className={`px-2 py-0.5 rounded-full ${
          pref === "severe"
            ? "bg-amber-100 text-amber-800 font-semibold"
            : "text-slate-500 hover:text-slate-700"
        }`}
        title="Use OEM Severe-duty interval (recommended default)."
      >
        Severe
      </button>
      <button
        type="button"
        onClick={() => update("normal")}
        disabled={saving}
        className={`px-2 py-0.5 rounded-full ${
          pref === "normal"
            ? "bg-emerald-100 text-emerald-800 font-semibold"
            : "text-slate-500 hover:text-slate-700"
        }`}
        title="Use OEM Normal-duty interval."
      >
        Normal
      </button>
      {saving && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400" />}
      {error && <span className="text-red-600 ml-1">{error}</span>}
    </div>
  );
}
