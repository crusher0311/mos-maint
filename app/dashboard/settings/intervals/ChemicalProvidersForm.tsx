"use client";

import { useState, Fragment } from "react";
import { FlaskConical, Save, Check, Plus, Trash2, ChevronDown, ChevronRight } from "lucide-react";
import { COMMON_SERVICES } from "@/lib/interval-common-services";
import {
  providerIdFromName,
  type ChemicalProvider,
} from "@/lib/plan-build/chemical-providers";
import {
  PROVIDER_TEMPLATES,
  BG_LPP_MAX_VEHICLE_AGE_YEARS,
  BG_LPP_PLAN1_MAX_MILES,
  BG_LPP_PLAN2_MAX_MILES,
  BG_LPP_PLAN2_GAS_MAX_MILES,
  type ProviderTemplate,
} from "@/lib/plan-build/provider-templates";

type ProviderDraft = {
  id: string;
  name: string;
  enabled: boolean;
  templateId: string | null;
  /** serviceKey -> { distance, months } in the shop's DISPLAY unit. */
  intervals: Record<string, { distance: number | null; months: number | null }>;
};

type Props = {
  providers: ChemicalProvider[];
  distanceUnit: "miles" | "kilometers";
  saveAction: (formData: FormData) => Promise<void>;
};

const MILES_TO_KM = 1.60934;

function toDraft(p: ChemicalProvider, distanceUnit: "miles" | "kilometers"): ProviderDraft {
  const intervals: ProviderDraft["intervals"] = {};
  for (const [key, iv] of Object.entries(p.intervals)) {
    intervals[key] = {
      distance:
        iv.miles != null
          ? distanceUnit === "kilometers"
            ? Math.round(iv.miles * MILES_TO_KM)
            : iv.miles
          : null,
      months: iv.months ?? null,
    };
  }
  return { id: p.id, name: p.name, enabled: p.enabled, templateId: p.templateId ?? null, intervals };
}

export default function ChemicalProvidersForm({ providers, distanceUnit, saveAction }: Props) {
  const [drafts, setDrafts] = useState<ProviderDraft[]>(() =>
    providers.map((p) => toDraft(p, distanceUnit))
  );
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [newName, setNewName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const distanceLabel = distanceUnit === "kilometers" ? "KM" : "Miles";

  const updateDraft = (id: string, patch: Partial<ProviderDraft>) => {
    setDrafts((ds) => ds.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  };

  const updateInterval = (
    id: string,
    key: string,
    field: "distance" | "months",
    value: number | null
  ) => {
    setDrafts((ds) =>
      ds.map((d) => {
        if (d.id !== id) return d;
        const cur = d.intervals[key] ?? { distance: null, months: null };
        return { ...d, intervals: { ...d.intervals, [key]: { ...cur, [field]: value } } };
      })
    );
  };

  const dedupeId = (base: string) => {
    let id = base;
    if (drafts.some((d) => d.id === id)) {
      let n = 2;
      while (drafts.some((d) => d.id === `${id}-${n}`)) n++;
      id = `${id}-${n}`;
    }
    return id;
  };

  const addProvider = () => {
    const name = newName.trim();
    if (!name) return;
    const base = providerIdFromName(name);
    if (!base) return;
    const id = dedupeId(base);
    setDrafts((ds) => [...ds, { id, name, enabled: true, templateId: null, intervals: {} }]);
    setExpanded((e) => ({ ...e, [id]: true }));
    setNewName("");
  };

  // Quick-add from a built-in template (e.g. BG Lifetime Protection Plan):
  // prefills the required service intervals, converted to the shop's
  // display unit. Values remain fully editable before saving.
  const addFromTemplate = (tpl: ProviderTemplate) => {
    const id = dedupeId(providerIdFromName(tpl.name) || tpl.templateId);
    const intervals: ProviderDraft["intervals"] = {};
    for (const [key, iv] of Object.entries(tpl.intervals)) {
      intervals[key] = {
        distance:
          iv.miles != null
            ? distanceUnit === "kilometers"
              ? Math.round(iv.miles * MILES_TO_KM)
              : iv.miles
            : null,
        months: iv.months ?? null,
      };
    }
    setDrafts((ds) => [
      ...ds,
      { id, name: tpl.name, enabled: true, templateId: tpl.templateId, intervals },
    ]);
    setExpanded((e) => ({ ...e, [id]: true }));
  };

  const removeProvider = (id: string) => {
    setDrafts((ds) => ds.filter((d) => d.id !== id));
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    const formData = new FormData();
    formData.set("distanceUnit", distanceUnit);
    formData.set("providersJson", JSON.stringify(drafts));
    await saveAction(formData);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="font-semibold text-gray-900 flex items-center gap-2">
            <FlaskConical className="w-5 h-5 text-gray-500" />
            Provider Schedules
          </h2>
        </div>

        {drafts.length === 0 && (
          <div className="px-6 py-6 text-sm text-gray-500">
            No provider schedules yet. Add one below (for example, "BG").
          </div>
        )}

        {drafts.map((d) => {
          const isOpen = expanded[d.id] ?? false;
          const definedCount = Object.values(d.intervals).filter(
            (iv) => (iv.distance != null && iv.distance > 0) || (iv.months != null && iv.months > 0)
          ).length;
          return (
            <div key={d.id} className="border-b border-gray-100 last:border-b-0">
              <div className="px-6 py-3 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setExpanded((e) => ({ ...e, [d.id]: !isOpen }))}
                  className="text-gray-400 hover:text-gray-600"
                  aria-label={isOpen ? `Collapse ${d.name}` : `Expand ${d.name}`}
                >
                  {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                </button>
                <span className="font-medium text-gray-900">{d.name}</span>
                <span className="text-xs text-gray-400">
                  {definedCount} service{definedCount === 1 ? "" : "s"}
                </span>
                <label className="ml-auto flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={d.enabled}
                    onChange={(e) => updateDraft(d.id, { enabled: e.target.checked })}
                    className="w-4 h-4 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                  />
                  Enabled
                </label>
                <button
                  type="button"
                  onClick={() => removeProvider(d.id)}
                  className="text-gray-400 hover:text-red-600"
                  title={`Remove ${d.name}`}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>

              {isOpen && d.templateId === "bg-lpp" && (
                <div className="mx-6 mb-3 px-4 py-3 bg-purple-50 border border-purple-200 rounded-lg text-xs text-purple-800 space-y-1">
                  <p className="font-semibold">BG Lifetime Protection Plan — entry eligibility</p>
                  <p>
                    Vehicle must be no more than {BG_LPP_MAX_VEHICLE_AGE_YEARS} years old at the
                    initial BG service. Plan 1: 0–{BG_LPP_PLAN1_MAX_MILES.toLocaleString()} miles ·
                    Plan 2: {(BG_LPP_PLAN1_MAX_MILES + 1).toLocaleString()}–{BG_LPP_PLAN2_MAX_MILES.toLocaleString()} miles ·
                    Plan 2 (gasoline only): {(BG_LPP_PLAN2_MAX_MILES + 1).toLocaleString()}–{BG_LPP_PLAN2_GAS_MAX_MILES.toLocaleString()} miles.
                  </p>
                  <p>
                    Each vehicle&apos;s eligibility shows automatically on its BG plan tab. Engine
                    interval is prefilled at 10,000 miles (gasoline) — BG&apos;s diesel cadence is
                    7,500 miles; adjust if needed.
                  </p>
                </div>
              )}

              {isOpen && (
                <div className="overflow-x-auto border-t border-gray-100">
                  <table className="w-full">
                    <thead className="bg-gray-50 border-b border-gray-200">
                      <tr>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Service
                        </th>
                        <th className="px-4 py-2 text-center text-xs font-medium text-gray-500 uppercase tracking-wider w-32">
                          {distanceLabel}
                        </th>
                        <th className="px-4 py-2 text-center text-xs font-medium text-gray-500 uppercase tracking-wider w-28">
                          Months
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {(() => {
                        let lastCategory = "";
                        return COMMON_SERVICES.map((svc) => {
                          const showHeader = svc.category !== lastCategory;
                          lastCategory = svc.category;
                          const iv = d.intervals[svc.key] ?? { distance: null, months: null };
                          const hasValue =
                            (iv.distance != null && iv.distance > 0) ||
                            (iv.months != null && iv.months > 0);
                          return (
                            <Fragment key={svc.key}>
                              {showHeader && (
                                <tr className="bg-gray-50">
                                  <td colSpan={3} className="px-4 py-1.5">
                                    <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                                      {svc.category}
                                    </span>
                                  </td>
                                </tr>
                              )}
                              <tr className={hasValue ? "bg-purple-50/50" : ""}>
                                <td className="px-4 py-2">
                                  <span className="text-sm text-gray-900">{svc.name}</span>
                                </td>
                                <td className="px-4 py-2">
                                  <input
                                    type="number"
                                    value={iv.distance ?? ""}
                                    onChange={(e) =>
                                      updateInterval(
                                        d.id,
                                        svc.key,
                                        "distance",
                                        e.target.value ? parseInt(e.target.value, 10) : null
                                      )
                                    }
                                    placeholder="—"
                                    min={0}
                                    step={10}
                                    className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-center text-sm bg-white focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
                                  />
                                </td>
                                <td className="px-4 py-2">
                                  <input
                                    type="number"
                                    value={iv.months ?? ""}
                                    onChange={(e) =>
                                      updateInterval(
                                        d.id,
                                        svc.key,
                                        "months",
                                        e.target.value ? parseInt(e.target.value, 10) : null
                                      )
                                    }
                                    placeholder="—"
                                    min={0}
                                    className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-center text-sm bg-white focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
                                  />
                                </td>
                              </tr>
                            </Fragment>
                          );
                        });
                      })()}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}

        <div className="px-6 py-4 bg-gray-50 flex items-center gap-3">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addProvider();
              }
            }}
            placeholder="Provider name (e.g. BG)"
            className="flex-1 max-w-xs px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
          />
          <button
            type="button"
            onClick={addProvider}
            disabled={!newName.trim()}
            className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors text-sm font-medium flex items-center gap-1.5 disabled:opacity-50"
          >
            <Plus className="w-4 h-4" />
            Add Provider
          </button>
          <span className="text-xs text-gray-400">or</span>
          {PROVIDER_TEMPLATES.map((tpl) => (
            <button
              key={tpl.templateId}
              type="button"
              onClick={() => addFromTemplate(tpl)}
              disabled={drafts.some((d) => d.templateId === tpl.templateId)}
              title={tpl.description}
              className="px-4 py-2 border border-purple-300 text-purple-700 bg-white rounded-lg hover:bg-purple-50 transition-colors text-sm font-medium flex items-center gap-1.5 disabled:opacity-50"
            >
              <FlaskConical className="w-4 h-4" />
              Quick add: {tpl.name}
            </button>
          ))}
        </div>
      </div>

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={saving}
          className="px-6 py-2.5 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors font-medium flex items-center gap-2 disabled:opacity-50"
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
              Save Providers
            </>
          )}
        </button>
      </div>
    </form>
  );
}
