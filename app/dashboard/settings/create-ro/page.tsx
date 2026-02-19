"use client";

import { useState, useEffect } from "react";
import {
  Settings,
  Loader2,
  Save,
  CheckCircle2,
  User,
  Car,
  Eye,
  AlertCircle,
  Plus,
  X,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

type FieldVisibility = "required" | "optional" | "hidden";

type FieldConfig = {
  key: string;
  label: string;
  locked?: boolean;
};

const CUSTOMER_FIELDS: FieldConfig[] = [
  { key: "firstName", label: "First Name", locked: true },
  { key: "lastName", label: "Last Name", locked: true },
  { key: "phone1", label: "Primary Phone" },
  { key: "phone2", label: "Secondary Phone" },
  { key: "email", label: "Email" },
  { key: "company", label: "Company" },
  { key: "street", label: "Street Address" },
  { key: "city", label: "City" },
  { key: "province", label: "Province / State" },
  { key: "postalCode", label: "Postal Code / ZIP" },
  { key: "country", label: "Country" },
  { key: "marketingSource", label: "Marketing Source" },
  { key: "note", label: "Contact Note" },
];

const VEHICLE_FIELDS: FieldConfig[] = [
  { key: "vin", label: "VIN" },
  { key: "year", label: "Year" },
  { key: "make", label: "Make" },
  { key: "model", label: "Model" },
  { key: "submodel", label: "Submodel / Trim" },
  { key: "color", label: "Color" },
  { key: "engine", label: "Engine" },
  { key: "transmission", label: "Transmission" },
  { key: "odometer", label: "Odometer" },
  { key: "licensePlate", label: "License Plate" },
];

const VIS_OPTIONS: { value: FieldVisibility; label: string; color: string; bgColor: string }[] = [
  { value: "required", label: "Required", color: "text-red-700", bgColor: "bg-red-50 border-red-200" },
  { value: "optional", label: "Optional", color: "text-blue-700", bgColor: "bg-blue-50 border-blue-200" },
  { value: "hidden", label: "Hidden", color: "text-gray-500", bgColor: "bg-gray-50 border-gray-200" },
];

export default function CreateROSettingsPage() {
  const [customerFields, setCustomerFields] = useState<Record<string, FieldVisibility>>({});
  const [vehicleFields, setVehicleFields] = useState<Record<string, FieldVisibility>>({});
  const [marketingSources, setMarketingSources] = useState<string[]>([]);
  const [newSource, setNewSource] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [customerExpanded, setCustomerExpanded] = useState(true);
  const [vehicleExpanded, setVehicleExpanded] = useState(true);
  const [sourcesExpanded, setSourcesExpanded] = useState(true);

  useEffect(() => {
    fetchSettings();
  }, []);

  async function fetchSettings() {
    try {
      const res = await fetch("/api/settings/create-ro");
      if (res.ok) {
        const data = await res.json();
        setCustomerFields(data.customerFields || {});
        setVehicleFields(data.vehicleFields || {});
        setMarketingSources(data.marketingSources || []);
      }
    } catch (err) {
      console.error("Failed to load settings:", err);
    } finally {
      setLoading(false);
    }
  }

  async function saveSettings() {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const res = await fetch("/api/settings/create-ro", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerFields, vehicleFields, marketingSources }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to save");
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  function setFieldVisibility(section: "customer" | "vehicle", key: string, vis: FieldVisibility) {
    if (section === "customer") {
      setCustomerFields(prev => ({ ...prev, [key]: vis }));
    } else {
      setVehicleFields(prev => ({ ...prev, [key]: vis }));
    }
  }

  function addMarketingSource() {
    const trimmed = newSource.trim();
    if (trimmed && !marketingSources.includes(trimmed)) {
      setMarketingSources(prev => [...prev, trimmed]);
      setNewSource("");
    }
  }

  function removeMarketingSource(source: string) {
    setMarketingSources(prev => prev.filter(s => s !== source));
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto py-8 px-4">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Settings className="w-6 h-6 text-blue-600" />
            Create RO Settings
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Configure which fields are shown and required when creating new customers and vehicles.
          </p>
        </div>
        <button
          onClick={saveSettings}
          disabled={saving}
          className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <CheckCircle2 className="w-4 h-4" /> : <Save className="w-4 h-4" />}
          {saved ? "Saved" : "Save Changes"}
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 text-sm text-red-700">
          <AlertCircle className="w-4 h-4" /> {error}
        </div>
      )}

      <div className="space-y-4">
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <button
            onClick={() => setCustomerExpanded(!customerExpanded)}
            className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-50 transition-colors"
          >
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-blue-100 flex items-center justify-center">
                <User className="w-5 h-5 text-blue-600" />
              </div>
              <div className="text-left">
                <div className="font-semibold text-gray-900 text-sm">Customer Fields</div>
                <div className="text-xs text-gray-500">Configure visibility for customer creation form</div>
              </div>
            </div>
            {customerExpanded ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}
          </button>
          {customerExpanded && (
            <div className="border-t border-gray-100 px-5 py-3">
              <div className="space-y-2">
                {CUSTOMER_FIELDS.map(field => {
                  const vis = customerFields[field.key] || "optional";
                  return (
                    <div key={field.key} className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-gray-50">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-gray-800">{field.label}</span>
                        {field.locked && <span className="text-[10px] bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded">Always Required</span>}
                      </div>
                      {field.locked ? (
                        <span className="text-xs font-medium text-red-600">Required</span>
                      ) : (
                        <div className="flex gap-1">
                          {VIS_OPTIONS.map(opt => (
                            <button
                              key={opt.value}
                              onClick={() => setFieldVisibility("customer", field.key, opt.value)}
                              className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors ${
                                vis === opt.value ? `${opt.bgColor} ${opt.color}` : "border-transparent text-gray-400 hover:text-gray-600"
                              }`}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <button
            onClick={() => setVehicleExpanded(!vehicleExpanded)}
            className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-50 transition-colors"
          >
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-green-100 flex items-center justify-center">
                <Car className="w-5 h-5 text-green-600" />
              </div>
              <div className="text-left">
                <div className="font-semibold text-gray-900 text-sm">Vehicle Fields</div>
                <div className="text-xs text-gray-500">Configure visibility for vehicle creation form</div>
              </div>
            </div>
            {vehicleExpanded ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}
          </button>
          {vehicleExpanded && (
            <div className="border-t border-gray-100 px-5 py-3">
              <div className="space-y-2">
                {VEHICLE_FIELDS.map(field => {
                  const vis = vehicleFields[field.key] || "optional";
                  return (
                    <div key={field.key} className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-gray-50">
                      <span className="text-sm text-gray-800">{field.label}</span>
                      <div className="flex gap-1">
                        {VIS_OPTIONS.map(opt => (
                          <button
                            key={opt.value}
                            onClick={() => setFieldVisibility("vehicle", field.key, opt.value)}
                            className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors ${
                              vis === opt.value ? `${opt.bgColor} ${opt.color}` : "border-transparent text-gray-400 hover:text-gray-600"
                            }`}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <button
            onClick={() => setSourcesExpanded(!sourcesExpanded)}
            className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-50 transition-colors"
          >
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-purple-100 flex items-center justify-center">
                <Eye className="w-5 h-5 text-purple-600" />
              </div>
              <div className="text-left">
                <div className="font-semibold text-gray-900 text-sm">Marketing Sources</div>
                <div className="text-xs text-gray-500">Predefined options for the Marketing Source dropdown</div>
              </div>
            </div>
            {sourcesExpanded ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}
          </button>
          {sourcesExpanded && (
            <div className="border-t border-gray-100 px-5 py-4">
              <div className="flex gap-2 mb-3">
                <input
                  type="text"
                  value={newSource}
                  onChange={e => setNewSource(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && addMarketingSource()}
                  placeholder="e.g. Google, Referral, Walk-in..."
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
                <button
                  onClick={addMarketingSource}
                  disabled={!newSource.trim()}
                  className="px-3 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1"
                >
                  <Plus className="w-4 h-4" /> Add
                </button>
              </div>
              {marketingSources.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-3">No marketing sources defined. Users will type freely.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {marketingSources.map(source => (
                    <span key={source} className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-purple-50 border border-purple-200 rounded-full text-sm text-purple-700">
                      {source}
                      <button onClick={() => removeMarketingSource(source)} className="text-purple-400 hover:text-purple-600">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
