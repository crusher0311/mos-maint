"use client";

import { Plus, Save, Trash2, X, ArrowUp, ArrowDown } from "lucide-react";

export type LaborRateCondition = {
  type: "make" | "fuelType" | "jobCategory" | "customer" | "customerType" | "tag" | "roField";
  field?: string | null;
  label: string | null;
  values: string[];
};

export type LaborRateRule = {
  id: string;
  name: string;
  rate: number;
  priority: number;
  conditions: LaborRateCondition[];
  matchMode: "all" | "any";
  overrideCategoryRates?: boolean;
  createdAt?: string;
  updatedAt?: string;
};

const conditionTypes: Array<{ value: LaborRateCondition["type"]; label: string }> = [
  { value: "make", label: "Vehicle Make" },
  { value: "fuelType", label: "Fuel Type" },
  { value: "jobCategory", label: "Job Category" },
  { value: "customer", label: "Customer Name / Phone" },
  { value: "customerType", label: "Customer Type" },
  { value: "tag", label: "Customer Tags" },
  { value: "roField", label: "RO Data Field" },
];

export function EnterpriseLaborRateEditor({
  rules,
  onChange,
}: {
  rules: LaborRateRule[];
  onChange: (rules: LaborRateRule[]) => void;
}) {
  const update = (index: number, rule: LaborRateRule) => {
    const next = [...rules];
    next[index] = rule;
    onChange(next);
  };

  const move = (index: number, direction: -1 | 1) => {
    const destination = index + direction;
    if (destination < 0 || destination >= rules.length) return;
    const next = [...rules];
    [next[index], next[destination]] = [next[destination], next[index]];
    onChange(next.map((rule, position) => ({ ...rule, priority: next.length - position })));
  };

  const addRule = () => {
    onChange([
      ...rules,
      {
        id: `local-${Date.now()}`,
        name: "",
        rate: 0,
        priority: 0,
        conditions: [],
        matchMode: "all",
      },
    ]);
  };

  return (
    <div className="space-y-4">
      {rules.length === 0 && (
        <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-8 text-center">
          <p className="font-medium text-gray-700">No labor rate rules</p>
          <p className="mt-1 text-sm text-gray-500">An empty rule set is valid and can be applied to every location.</p>
        </div>
      )}
      {rules.map((rule, index) => (
        <div key={rule.id || index} className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm space-y-4">
          <div className="flex items-center gap-2">
            <div className="grid flex-1 grid-cols-1 gap-3 md:grid-cols-3">
              <input
                aria-label="Rule name"
                value={rule.name}
                onChange={(event) => update(index, { ...rule, name: event.target.value })}
                placeholder="Rule name"
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
              <input
                aria-label="Hourly rate"
                type="number"
                min="0"
                step="0.01"
                value={rule.rate || ""}
                onChange={(event) => update(index, { ...rule, rate: Number(event.target.value) })}
                placeholder="Rate ($/hr)"
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
              <select
                value={rule.matchMode}
                onChange={(event) => update(index, { ...rule, matchMode: event.target.value as "all" | "any" })}
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
              >
                <option value="all">Match all conditions</option>
                <option value="any">Match any condition</option>
              </select>
            </div>
            <button onClick={() => move(index, -1)} disabled={index === 0} className="p-2 text-gray-500 disabled:opacity-25" title="Move up">
              <ArrowUp className="h-4 w-4" />
            </button>
            <button onClick={() => move(index, 1)} disabled={index === rules.length - 1} className="p-2 text-gray-500 disabled:opacity-25" title="Move down">
              <ArrowDown className="h-4 w-4" />
            </button>
            <button onClick={() => onChange(rules.filter((_, position) => position !== index))} className="p-2 text-red-500" title="Delete rule">
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={!!rule.overrideCategoryRates}
              onChange={(event) => update(index, { ...rule, overrideCategoryRates: event.target.checked })}
            />
            Override per-job category rates
          </label>
          <div className="space-y-2">
            {rule.conditions.map((condition, conditionIndex) => (
              <div key={conditionIndex} className="flex flex-wrap items-center gap-2 rounded-lg bg-gray-50 p-3">
                <select
                  value={condition.type}
                  onChange={(event) => {
                    const conditions = [...rule.conditions];
                    conditions[conditionIndex] = { ...condition, type: event.target.value as LaborRateCondition["type"] };
                    update(index, { ...rule, conditions });
                  }}
                  className="rounded border border-gray-300 px-2 py-1.5 text-sm"
                >
                  {conditionTypes.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
                </select>
                {condition.type === "roField" && (
                  <input
                    value={condition.field || ""}
                    onChange={(event) => {
                      const conditions = [...rule.conditions];
                      conditions[conditionIndex] = { ...condition, field: event.target.value, label: event.target.value };
                      update(index, { ...rule, conditions });
                    }}
                    placeholder="RO field (e.g. vehicle.model)"
                    className="min-w-48 flex-1 rounded border border-gray-300 px-2 py-1.5 text-sm"
                  />
                )}
                <input
                  value={condition.values.join(", ")}
                  onChange={(event) => {
                    const conditions = [...rule.conditions];
                    conditions[conditionIndex] = {
                      ...condition,
                      values: event.target.value.split(",").map((value) => value.trim()).filter(Boolean),
                    };
                    update(index, { ...rule, conditions });
                  }}
                  placeholder="Values, separated by commas"
                  className="min-w-56 flex-[2] rounded border border-gray-300 px-2 py-1.5 text-sm"
                />
                <button
                  onClick={() => update(index, { ...rule, conditions: rule.conditions.filter((_, position) => position !== conditionIndex) })}
                  className="p-1 text-gray-400 hover:text-red-500"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ))}
            <button
              onClick={() => update(index, {
                ...rule,
                conditions: [...rule.conditions, { type: "make", field: null, label: null, values: [] }],
              })}
              className="inline-flex items-center gap-1 text-sm font-medium text-blue-600"
            >
              <Plus className="h-4 w-4" /> Add condition
            </button>
          </div>
        </div>
      ))}
      <button onClick={addRule} className="inline-flex items-center gap-2 rounded-lg border border-blue-300 px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50">
        <Plus className="h-4 w-4" /> New rule
      </button>
    </div>
  );
}

export function ApplyRulesButton({ saving, locationCount, onApply }: { saving: boolean; locationCount: number; onApply: () => void }) {
  return (
    <button
      onClick={onApply}
      disabled={saving}
      className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
    >
      <Save className="h-4 w-4" />
      {saving ? "Applying…" : `Apply to all ${locationCount} locations`}
    </button>
  );
}