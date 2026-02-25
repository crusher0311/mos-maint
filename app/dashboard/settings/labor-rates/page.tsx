"use client";

import { useState, useEffect, useCallback } from "react";
import {
  DollarSign,
  Loader2,
  Plus,
  Trash2,
  Save,
  X,
  AlertCircle,
  CheckCircle2,
  GripVertical,
  ChevronDown,
  ChevronRight,
  Settings,
  Tag,
  Car,
  Fuel,
  Wrench,
  User,
  Database,
} from "lucide-react";

type ConditionType = "make" | "fuelType" | "jobCategory" | "customer" | "customerType" | "tag" | "roField";

type RuleCondition = {
  type: ConditionType;
  field?: string | null;
  label: string | null;
  values: string[];
};

type LaborRateRule = {
  id: string;
  name: string;
  rate: number;
  priority: number;
  conditions: RuleCondition[];
  matchMode: "all" | "any";
  overrideCategoryRates?: boolean;
  createdAt?: string;
  updatedAt?: string;
};

const CONDITION_TYPES: { value: ConditionType; label: string; icon: any; description: string }[] = [
  { value: "make", label: "Vehicle Make", icon: Car, description: "Match specific vehicle manufacturers" },
  { value: "fuelType", label: "Fuel Type", icon: Fuel, description: "Match by fuel type (Gas, Diesel, Electric, Hybrid)" },
  { value: "jobCategory", label: "Job Category", icon: Wrench, description: "Match by Tekmetric job category" },
  { value: "customer", label: "Customer Name / Phone", icon: User, description: "Match by customer name or phone number on the repair order" },
  { value: "customerType", label: "Customer Type", icon: User, description: "Match by Tekmetric customer type (Individual, Business, Fleet)" },
  { value: "tag", label: "Customer Tags", icon: Tag, description: "Match by Tekmetric customer tags" },
  { value: "roField", label: "RO Data Field", icon: Database, description: "Match any field from the repair order (engine, drive type, etc.)" },
];

const RO_FIELD_OPTIONS: { value: string; label: string; description: string }[] = [
  { value: "vehicle.engineSize", label: "Engine Size", description: "e.g., 2.0L, 3.5L, 5.7L" },
  { value: "vehicle.driveType", label: "Drive Type", description: "e.g., FWD, RWD, AWD, 4WD" },
  { value: "vehicle.bodyType", label: "Body Type", description: "e.g., Sedan, SUV, Truck, Van" },
  { value: "vehicle.transmission", label: "Transmission", description: "e.g., Automatic, Manual, CVT" },
  { value: "vehicle.subModel", label: "Sub-Model / Trim", description: "e.g., Sport, Limited, EX-L" },
  { value: "vehicle.engineType", label: "Engine Type", description: "e.g., V6, V8, I4, Turbo" },
  { value: "vehicle.year", label: "Year", description: "Match specific model years" },
  { value: "vehicle.model", label: "Model", description: "e.g., Camry, F-150, Civic" },
  { value: "customer.type", label: "Customer Type", description: "e.g., Fleet, Individual, Business" },
];

const COMMON_MAKES = [
  "Acura", "Audi", "BMW", "Buick", "Cadillac", "Chevrolet", "Chrysler",
  "Dodge", "Ford", "Genesis", "GMC", "Honda", "Hyundai", "Infiniti",
  "Jaguar", "Jeep", "Kia", "Land Rover", "Lexus", "Lincoln", "Mazda",
  "Mercedes-Benz", "Mini", "Mitsubishi", "Nissan", "Porsche", "Ram",
  "Subaru", "Tesla", "Toyota", "Volkswagen", "Volvo",
];

const FUEL_TYPES = ["Gasoline", "Diesel", "Electric", "Hybrid", "Plug-in Hybrid", "Flex Fuel"];

function getConditionIcon(type: ConditionType) {
  const ct = CONDITION_TYPES.find(c => c.value === type);
  return ct ? ct.icon : Tag;
}

function getConditionLabel(type: ConditionType) {
  const ct = CONDITION_TYPES.find(c => c.value === type);
  return ct ? ct.label : type;
}

export default function LaborRatesPage() {
  const [rules, setRules] = useState<LaborRateRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [editingRule, setEditingRule] = useState<LaborRateRule | null>(null);
  const [isNewRule, setIsNewRule] = useState(false);
  const [expandedRules, setExpandedRules] = useState<Set<string>>(new Set());
  const [jobCategories, setJobCategories] = useState<string[]>([]);

  const fetchRules = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/settings/labor-rates");
      const data = await res.json();
      if (data.rules) {
        setRules(data.rules.sort((a: LaborRateRule, b: LaborRateRule) => b.priority - a.priority));
      }
    } catch (err) {
      setError("Failed to load labor rate rules");
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchJobCategories = useCallback(async () => {
    try {
      const res = await fetch("/api/tekmetric/job-categories");
      const data = await res.json();
      if (data.categories) setJobCategories(data.categories);
    } catch {}
  }, []);

  useEffect(() => {
    fetchRules();
    fetchJobCategories();
  }, [fetchRules, fetchJobCategories]);

  const handleSaveRule = async () => {
    if (!editingRule) return;
    if (!editingRule.name.trim()) {
      setError("Rule name is required");
      return;
    }
    if (editingRule.rate <= 0) {
      setError("Rate must be greater than 0");
      return;
    }

    try {
      setSaving(true);
      setError(null);
      const method = isNewRule ? "POST" : "PUT";
      const res = await fetch("/api/settings/labor-rates", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editingRule),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to save rule");
      }

      setSuccess(isNewRule ? "Rule created successfully" : "Rule updated successfully");
      setEditingRule(null);
      setIsNewRule(false);
      await fetchRules();
      setTimeout(() => setSuccess(null), 3000);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteRule = async (id: string) => {
    if (!confirm("Are you sure you want to delete this rule?")) return;
    try {
      const res = await fetch(`/api/settings/labor-rates?id=${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete rule");
      setSuccess("Rule deleted");
      await fetchRules();
      setTimeout(() => setSuccess(null), 3000);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const startNewRule = () => {
    setEditingRule({
      id: "",
      name: "",
      rate: 0,
      priority: rules.length,
      conditions: [],
      matchMode: "all",
    });
    setIsNewRule(true);
  };

  const addCondition = (type: ConditionType, field?: string) => {
    if (!editingRule) return;
    const fieldOption = field ? RO_FIELD_OPTIONS.find(f => f.value === field) : null;
    setEditingRule({
      ...editingRule,
      conditions: [
        ...editingRule.conditions,
        { type, field: field || null, label: fieldOption?.label || null, values: [] },
      ],
    });
  };

  const removeCondition = (index: number) => {
    if (!editingRule) return;
    const updated = [...editingRule.conditions];
    updated.splice(index, 1);
    setEditingRule({ ...editingRule, conditions: updated });
  };

  const updateConditionValues = (index: number, values: string[]) => {
    if (!editingRule) return;
    const updated = [...editingRule.conditions];
    updated[index] = { ...updated[index], values };
    setEditingRule({ ...editingRule, conditions: updated });
  };

  const toggleExpanded = (id: string) => {
    const next = new Set(expandedRules);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpandedRules(next);
  };

  const getValueOptions = (type: ConditionType): string[] => {
    switch (type) {
      case "make": return COMMON_MAKES;
      case "fuelType": return FUEL_TYPES;
      case "jobCategory": return jobCategories;
      case "customerType": return ["Individual", "Business", "Fleet"];
      case "customer": return [];
      case "tag": return [];
      case "roField": return [];
      default: return [];
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <DollarSign className="w-6 h-6 text-blue-600" />
            Labor Rate Rules
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Create rules to automatically apply labor rates based on vehicle and job characteristics.
            Higher priority rules are evaluated first.
          </p>
        </div>
        <button
          onClick={startNewRule}
          className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium"
        >
          <Plus className="w-4 h-4" />
          New Rule
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-center gap-2 text-red-700 text-sm">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
          <button onClick={() => setError(null)} className="ml-auto"><X className="w-4 h-4" /></button>
        </div>
      )}

      {success && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-3 flex items-center gap-2 text-green-700 text-sm">
          <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
          {success}
        </div>
      )}

      {editingRule && (
        <RuleEditor
          rule={editingRule}
          isNew={isNewRule}
          saving={saving}
          jobCategories={jobCategories}
          onSave={handleSaveRule}
          onCancel={() => { setEditingRule(null); setIsNewRule(false); }}
          onChange={setEditingRule}
          onAddCondition={addCondition}
          onRemoveCondition={removeCondition}
          onUpdateConditionValues={updateConditionValues}
          getValueOptions={getValueOptions}
        />
      )}

      <div className="space-y-3">
        {rules.length === 0 && !editingRule ? (
          <div className="text-center py-12 bg-gray-50 rounded-lg border border-dashed border-gray-300">
            <Settings className="w-12 h-12 text-gray-400 mx-auto mb-3" />
            <h3 className="text-lg font-medium text-gray-600">No labor rate rules yet</h3>
            <p className="text-sm text-gray-500 mt-1">
              Create rules to automatically apply different rates based on vehicle make, fuel type, job category, customer type, tags, or custom fields.
            </p>
            <button
              onClick={startNewRule}
              className="mt-4 text-blue-600 hover:text-blue-700 text-sm font-medium"
            >
              Create your first rule
            </button>
          </div>
        ) : (
          rules.map((rule) => (
            <div
              key={rule.id}
              className="bg-white rounded-lg border border-gray-200 shadow-sm hover:shadow-md transition-shadow"
            >
              <div
                className="flex items-center gap-3 p-4 cursor-pointer"
                onClick={() => toggleExpanded(rule.id)}
              >
                <GripVertical className="w-4 h-4 text-gray-400" />
                {expandedRules.has(rule.id) ? (
                  <ChevronDown className="w-4 h-4 text-gray-500" />
                ) : (
                  <ChevronRight className="w-4 h-4 text-gray-500" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3">
                    <span className="font-medium text-gray-900">{rule.name}</span>
                    <span className="bg-blue-100 text-blue-700 text-xs font-semibold px-2 py-0.5 rounded-full">
                      ${rule.rate.toFixed(2)}/hr
                    </span>
                    <span className="bg-gray-100 text-gray-600 text-xs px-2 py-0.5 rounded-full">
                      Priority: {rule.priority}
                    </span>
                    <span className="text-xs text-gray-400">
                      {rule.conditions.length} condition{rule.conditions.length !== 1 ? "s" : ""} • Match {rule.matchMode}
                    </span>
                    {rule.overrideCategoryRates && (
                      <span className="bg-orange-100 text-orange-700 text-xs font-medium px-2 py-0.5 rounded-full">
                        Overrides categories
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                  <button
                    onClick={() => { setEditingRule({ ...rule }); setIsNewRule(false); }}
                    className="text-gray-500 hover:text-blue-600 p-1"
                    title="Edit"
                  >
                    <Settings className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleDeleteRule(rule.id)}
                    className="text-gray-500 hover:text-red-600 p-1"
                    title="Delete"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {expandedRules.has(rule.id) && (
                <div className="border-t border-gray-100 p-4 bg-gray-50">
                  {rule.conditions.length === 0 ? (
                    <p className="text-sm text-gray-500 italic">No conditions — this rule applies to all jobs</p>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Conditions ({rule.matchMode === "all" ? "ALL must match" : "ANY can match"})
                      </p>
                      {rule.conditions.map((cond, i) => {
                        const Icon = getConditionIcon(cond.type);
                        const fieldLabel = cond.type === "roField" && cond.field
                          ? RO_FIELD_OPTIONS.find(f => f.value === cond.field)?.label || cond.field
                          : null;
                        return (
                          <div key={i} className="flex items-center gap-2 text-sm">
                            <Icon className="w-4 h-4 text-gray-500" />
                            <span className="font-medium text-gray-700">
                              {getConditionLabel(cond.type)}{fieldLabel ? ` (${fieldLabel})` : ''}:
                            </span>
                            <div className="flex flex-wrap gap-1">
                              {cond.values.map((v, vi) => (
                                <span key={vi} className="bg-white border border-gray-200 px-2 py-0.5 rounded text-xs text-gray-700">
                                  {v}
                                </span>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-800">
        <h4 className="font-medium mb-1">How Labor Rate Rules Work</h4>
        <ul className="list-disc list-inside space-y-1 text-blue-700">
          <li>Rules are evaluated by priority (highest first) when a repair order is opened</li>
          <li>The first matching rule sets the labor rate for the job</li>
          <li>Rates are stored in dollars — your SMS handles any conversion automatically</li>
          <li>Rules with no conditions act as a default rate (use lowest priority)</li>
          <li>The Chrome extension auto-applies rates when viewing repair orders</li>
        </ul>
      </div>
    </div>
  );
}

function RuleEditor({
  rule,
  isNew,
  saving,
  jobCategories,
  onSave,
  onCancel,
  onChange,
  onAddCondition,
  onRemoveCondition,
  onUpdateConditionValues,
  getValueOptions,
}: {
  rule: LaborRateRule;
  isNew: boolean;
  saving: boolean;
  jobCategories: string[];
  onSave: () => void;
  onCancel: () => void;
  onChange: (rule: LaborRateRule) => void;
  onAddCondition: (type: ConditionType, field?: string) => void;
  onRemoveCondition: (index: number) => void;
  onUpdateConditionValues: (index: number, values: string[]) => void;
  getValueOptions: (type: ConditionType) => string[];
}) {
  const [showAddCondition, setShowAddCondition] = useState(false);
  const [showFieldPicker, setShowFieldPicker] = useState(false);
  const [customTagInput, setCustomTagInput] = useState("");
  const [customerInput, setCustomerInput] = useState("");

  return (
    <div className="bg-white rounded-lg border-2 border-blue-300 shadow-lg p-6 space-y-5">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-gray-900">
          {isNew ? "Create New Rule" : "Edit Rule"}
        </h3>
        <button onClick={onCancel} className="text-gray-400 hover:text-gray-600">
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="sm:col-span-1">
          <label className="block text-sm font-medium text-gray-700 mb-1">Rule Name</label>
          <input
            type="text"
            value={rule.name}
            onChange={(e) => onChange({ ...rule, name: e.target.value })}
            placeholder="e.g., European Vehicles"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Rate ($/hr)</label>
          <div className="relative">
            <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="number"
              step="0.01"
              min="0"
              value={rule.rate || ""}
              onChange={(e) => onChange({ ...rule, rate: parseFloat(e.target.value) || 0 })}
              placeholder="0.00"
              className="w-full border border-gray-300 rounded-lg pl-8 pr-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Priority</label>
          <input
            type="number"
            min="0"
            value={rule.priority}
            onChange={(e) => onChange({ ...rule, priority: parseInt(e.target.value) || 0 })}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
          <p className="text-xs text-gray-500 mt-1">Higher = evaluated first</p>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Match Mode</label>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="radio"
              checked={rule.matchMode === "all"}
              onChange={() => onChange({ ...rule, matchMode: "all" })}
              className="text-blue-600"
            />
            <span>ALL conditions must match</span>
          </label>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="radio"
              checked={rule.matchMode === "any"}
              onChange={() => onChange({ ...rule, matchMode: "any" })}
              className="text-blue-600"
            />
            <span>ANY condition can match</span>
          </label>
        </div>
      </div>

      <div className="border border-gray-200 rounded-lg p-4 bg-gray-50">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={!!rule.overrideCategoryRates}
            onChange={(e) => onChange({ ...rule, overrideCategoryRates: e.target.checked })}
            className="mt-0.5 text-blue-600 rounded"
          />
          <div>
            <span className="text-sm font-medium text-gray-800">Override per-job category rates</span>
            <p className="text-xs text-gray-500 mt-0.5">
              When enabled, this rule's rate applies to all jobs — including those that would normally be handled by a category-specific rule (e.g., Diag or Maint). Use this for fleet or wholesale accounts that get a flat rate regardless of job type.
            </p>
          </div>
        </label>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <label className="block text-sm font-medium text-gray-700">Conditions</label>
          <button
            onClick={() => setShowAddCondition(!showAddCondition)}
            className="text-blue-600 hover:text-blue-700 text-sm font-medium flex items-center gap-1"
          >
            <Plus className="w-3 h-3" />
            Add Condition
          </button>
        </div>

        {showAddCondition && !showFieldPicker && (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 p-3 bg-gray-50 rounded-lg border border-gray-200">
            {CONDITION_TYPES.map((ct) => {
              const Icon = ct.icon;
              return (
                <button
                  key={ct.value}
                  onClick={() => {
                    if (ct.value === "roField") {
                      setShowFieldPicker(true);
                    } else {
                      onAddCondition(ct.value);
                      setShowAddCondition(false);
                    }
                  }}
                  className="flex flex-col items-center gap-1 p-3 rounded-lg border border-gray-200 bg-white hover:border-blue-300 hover:bg-blue-50 transition-colors text-center"
                >
                  <Icon className="w-5 h-5 text-gray-600" />
                  <span className="text-xs font-medium text-gray-700">{ct.label}</span>
                  <span className="text-[10px] text-gray-400">{ct.description}</span>
                </button>
              );
            })}
          </div>
        )}

        {showFieldPicker && (
          <div className="p-3 bg-gray-50 rounded-lg border border-gray-200 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-gray-700">Choose an RO field to match:</span>
              <button onClick={() => { setShowFieldPicker(false); setShowAddCondition(false); }} className="text-gray-400 hover:text-gray-600">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {RO_FIELD_OPTIONS.map((fo) => (
                <button
                  key={fo.value}
                  onClick={() => {
                    onAddCondition("roField", fo.value);
                    setShowFieldPicker(false);
                    setShowAddCondition(false);
                  }}
                  className="flex flex-col items-start p-2 rounded-lg border border-gray-200 bg-white hover:border-blue-300 hover:bg-blue-50 transition-colors text-left"
                >
                  <span className="text-sm font-medium text-gray-700">{fo.label}</span>
                  <span className="text-xs text-gray-400">{fo.description}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {rule.conditions.length === 0 ? (
          <p className="text-sm text-gray-500 italic bg-gray-50 p-3 rounded-lg">
            No conditions — this rule will match all vehicles and jobs (use as a default rate)
          </p>
        ) : (
          rule.conditions.map((cond, index) => {
            const Icon = getConditionIcon(cond.type);
            const options = getValueOptions(cond.type);
            const needsFreeText = cond.type === "customer" || cond.type === "tag" || cond.type === "roField";
            const fieldLabel = cond.type === "roField" && cond.field
              ? RO_FIELD_OPTIONS.find(f => f.value === cond.field)?.label || cond.field
              : null;

            return (
              <div key={index} className="border border-gray-200 rounded-lg p-3 bg-gray-50">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Icon className="w-4 h-4 text-gray-600" />
                    <span className="text-sm font-medium text-gray-700">
                      {getConditionLabel(cond.type)}
                      {fieldLabel && <span className="text-blue-600 ml-1">({fieldLabel})</span>}
                    </span>
                  </div>
                  <button
                    onClick={() => onRemoveCondition(index)}
                    className="text-gray-400 hover:text-red-500"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <div className="flex flex-wrap gap-1.5 mb-2">
                  {cond.values.map((v, vi) => (
                    <span
                      key={vi}
                      className="inline-flex items-center gap-1 bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full text-xs font-medium"
                    >
                      {v}
                      <button
                        onClick={() => {
                          const updated = cond.values.filter((_, i) => i !== vi);
                          onUpdateConditionValues(index, updated);
                        }}
                        className="hover:text-red-600"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>

                {needsFreeText ? (
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={cond.type === "customer" ? customerInput : customTagInput}
                      onChange={(e) => {
                        if (cond.type === "customer") setCustomerInput(e.target.value);
                        else setCustomTagInput(e.target.value);
                      }}
                      onKeyDown={(e) => {
                        const inputVal = cond.type === "customer" ? customerInput : customTagInput;
                        if (e.key === "Enter" && inputVal.trim()) {
                          if (!cond.values.includes(inputVal.trim())) {
                            onUpdateConditionValues(index, [...cond.values, inputVal.trim()]);
                          }
                          if (cond.type === "customer") setCustomerInput("");
                          else setCustomTagInput("");
                        }
                      }}
                      placeholder={
                        cond.type === "customer"
                          ? "Type customer name or phone and press Enter"
                          : cond.type === "tag"
                            ? "Type a customer tag and press Enter"
                            : fieldLabel
                              ? `Type ${fieldLabel.toLowerCase()} value and press Enter`
                              : "Type a value and press Enter"
                      }
                      className="flex-1 border border-gray-300 rounded px-2 py-1 text-sm"
                    />
                    <button
                      onClick={() => {
                        const inputVal = cond.type === "customer" ? customerInput : customTagInput;
                        if (inputVal.trim() && !cond.values.includes(inputVal.trim())) {
                          onUpdateConditionValues(index, [...cond.values, inputVal.trim()]);
                        }
                        if (cond.type === "customer") setCustomerInput("");
                        else setCustomTagInput("");
                      }}
                      className="bg-blue-600 text-white px-2 py-1 rounded text-sm hover:bg-blue-700"
                    >
                      Add
                    </button>
                  </div>
                ) : (
                  <select
                    value=""
                    onChange={(e) => {
                      if (e.target.value && !cond.values.includes(e.target.value)) {
                        onUpdateConditionValues(index, [...cond.values, e.target.value]);
                      }
                    }}
                    className="w-full border border-gray-300 rounded px-2 py-1 text-sm bg-white"
                  >
                    <option value="">Add a value...</option>
                    {options
                      .filter((o) => !cond.values.includes(o))
                      .map((o) => (
                        <option key={o} value={o}>{o}</option>
                      ))}
                  </select>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="flex items-center gap-3 pt-2 border-t border-gray-200">
        <button
          onClick={onSave}
          disabled={saving}
          className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {isNew ? "Create Rule" : "Save Changes"}
        </button>
        <button
          onClick={onCancel}
          className="text-gray-600 hover:text-gray-800 text-sm px-4 py-2"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
