"use client";

import { useState, useEffect } from "react";
import { Settings, Loader2, Check, Globe, List, Eye, Car, Tag } from "lucide-react";

const WORKFLOW_STAGES = [
  { key: "Unassigned", label: "Unassigned", description: "New work orders not yet assigned" },
  { key: "InspectionInProgress", label: "Inspection In Progress", description: "Vehicle inspection underway" },
  { key: "WorkAuthorized", label: "Work Authorized", description: "Customer has approved the work" },
  { key: "EstimateCompleted", label: "Estimate Completed", description: "Estimate has been finalized" },
  { key: "ScheduledWork", label: "Scheduled Work", description: "Future appointments (off by default)" },
  { key: "WorkCompleted", label: "Work Completed", description: "Job finished, pending invoice (off by default)" },
];

const DEFAULT_STAGES = ["InspectionInProgress", "Unassigned", "WorkAuthorized", "EstimateCompleted"];

type TekmetricLabel = { name: string; color: string };

export default function PreferencesPage() {
  const [distanceUnit, setDistanceUnit] = useState("miles");
  const [workflowStages, setWorkflowStages] = useState<string[]>(DEFAULT_STAGES);
  const [showInspectItems, setShowInspectItems] = useState(true);
  const [showOnlyWithMileage, setShowOnlyWithMileage] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [hasProtractor, setHasProtractor] = useState(false);
  const [hasTekmetric, setHasTekmetric] = useState(false);
  const [tekmetricLabels, setTekmetricLabels] = useState<TekmetricLabel[]>([]);
  const [selectedTekmetricLabels, setSelectedTekmetricLabels] = useState<string[]>([]);

  useEffect(() => {
    fetchPreferences();
  }, []);

  async function fetchPreferences() {
    try {
      const [prefsRes, integrationsRes, labelsRes] = await Promise.all([
        fetch("/api/settings/preferences"),
        fetch("/api/settings/integrations"),
        fetch("/api/tekmetric/labels")
      ]);
      
      if (prefsRes.ok) {
        const data = await prefsRes.json();
        setDistanceUnit(data.distanceUnit || "miles");
        setWorkflowStages(data.workflowStages || DEFAULT_STAGES);
        setShowInspectItems(data.showInspectItems !== false);
        setShowOnlyWithMileage(data.showOnlyWithMileage !== false);
        setSelectedTekmetricLabels(data.tekmetricLabels || []);
      }
      
      if (integrationsRes.ok) {
        const integrations = await integrationsRes.json();
        setHasProtractor(!!integrations.protractor?.configured);
        setHasTekmetric(!!integrations.tekmetric?.configured);
      }
      
      if (labelsRes.ok) {
        const labelsData = await labelsRes.json();
        setTekmetricLabels(labelsData.labels || []);
      }
    } catch (err) {
      console.error("Failed to fetch preferences:", err);
    } finally {
      setLoading(false);
    }
  }

  function toggleWorkflowStage(stage: string) {
    setWorkflowStages(prev => 
      prev.includes(stage) 
        ? prev.filter(s => s !== stage)
        : [...prev, stage]
    );
  }

  function toggleTekmetricLabel(label: string) {
    setSelectedTekmetricLabels(prev => 
      prev.includes(label) 
        ? prev.filter(l => l !== label)
        : [...prev, label]
    );
  }

  async function savePreferences() {
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch("/api/settings/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          distanceUnit, 
          workflowStages, 
          showInspectItems, 
          showOnlyWithMileage,
          tekmetricLabels: selectedTekmetricLabels
        }),
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
        </div>

        {hasProtractor && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
            <div className="flex items-center gap-3 mb-6">
              <List className="w-5 h-5 text-gray-500" />
              <h2 className="text-lg font-semibold text-gray-900">Dashboard Workflow Stages</h2>
            </div>

            <div className="space-y-4">
              <p className="text-sm text-gray-500">
                Select which Protractor workflow stages should appear on your dashboard. 
                Only work orders matching selected stages will be shown.
              </p>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {WORKFLOW_STAGES.map((stage) => (
                  <label
                    key={stage.key}
                    className={`flex items-start gap-3 p-4 border rounded-lg cursor-pointer transition-colors ${
                      workflowStages.includes(stage.key)
                        ? "border-blue-500 bg-blue-50"
                        : "border-gray-200 hover:bg-gray-50"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={workflowStages.includes(stage.key)}
                      onChange={() => toggleWorkflowStage(stage.key)}
                      className="w-4 h-4 text-blue-600 mt-0.5"
                    />
                    <div>
                      <p className="font-medium text-gray-900">{stage.label}</p>
                      <p className="text-sm text-gray-500">{stage.description}</p>
                    </div>
                  </label>
                ))}
              </div>

              {workflowStages.length === 0 && (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
                  <p className="text-sm text-amber-800">
                    No stages selected. Your dashboard will show no Protractor vehicles.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {hasTekmetric && tekmetricLabels.length > 0 && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
            <div className="flex items-center gap-3 mb-6">
              <Tag className="w-5 h-5 text-gray-500" />
              <h2 className="text-lg font-semibold text-gray-900">Dashboard Labels</h2>
            </div>

            <div className="space-y-4">
              <p className="text-sm text-gray-500">
                Select which Tekmetric custom labels should appear on your dashboard. 
                Only repair orders with selected labels will be shown. Leave all unchecked to show all active repair orders.
              </p>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {tekmetricLabels.map((label) => (
                  <label
                    key={label.name}
                    className={`flex items-start gap-3 p-4 border rounded-lg cursor-pointer transition-colors ${
                      selectedTekmetricLabels.includes(label.name)
                        ? "border-blue-500 bg-blue-50"
                        : "border-gray-200 hover:bg-gray-50"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedTekmetricLabels.includes(label.name)}
                      onChange={() => toggleTekmetricLabel(label.name)}
                      className="w-4 h-4 text-blue-600 mt-0.5"
                    />
                    <div className="flex items-center gap-2">
                      {label.color && (
                        <span 
                          className="w-3 h-3 rounded-full flex-shrink-0"
                          style={{ backgroundColor: label.color }}
                        />
                      )}
                      <p className="font-medium text-gray-900">{label.name}</p>
                    </div>
                  </label>
                ))}
              </div>

              {selectedTekmetricLabels.length > 0 && (
                <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
                  <p className="text-sm text-blue-800">
                    {selectedTekmetricLabels.length} label{selectedTekmetricLabels.length > 1 ? 's' : ''} selected. 
                    Dashboard will only show repair orders with these labels.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <div className="flex items-center gap-3 mb-6">
            <Car className="w-5 h-5 text-gray-500" />
            <h2 className="text-lg font-semibold text-gray-900">Dashboard Display</h2>
          </div>

          <div className="space-y-4">
            <label
              className={`flex items-start gap-3 p-4 border rounded-lg cursor-pointer transition-colors ${
                showOnlyWithMileage
                  ? "border-blue-500 bg-blue-50"
                  : "border-gray-200 hover:bg-gray-50"
              }`}
            >
              <input
                type="checkbox"
                checked={showOnlyWithMileage}
                onChange={(e) => setShowOnlyWithMileage(e.target.checked)}
                className="w-4 h-4 text-blue-600 mt-0.5"
              />
              <div>
                <p className="font-medium text-gray-900">Show Only Vehicles With Mileage</p>
                <p className="text-sm text-gray-500">
                  Only display vehicles that have mileage entered. This helps advisors know to enter mileage 
                  before the vehicle appears on the dashboard. Turn off to see all vehicles.
                </p>
              </div>
            </label>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <div className="flex items-center gap-3 mb-6">
            <Eye className="w-5 h-5 text-gray-500" />
            <h2 className="text-lg font-semibold text-gray-900">Maintenance Plan Display</h2>
          </div>

          <div className="space-y-4">
            <label
              className={`flex items-start gap-3 p-4 border rounded-lg cursor-pointer transition-colors ${
                showInspectItems
                  ? "border-blue-500 bg-blue-50"
                  : "border-gray-200 hover:bg-gray-50"
              }`}
            >
              <input
                type="checkbox"
                checked={showInspectItems}
                onChange={(e) => setShowInspectItems(e.target.checked)}
                className="w-4 h-4 text-blue-600 mt-0.5"
              />
              <div>
                <p className="font-medium text-gray-900">Show "Inspect" Items</p>
                <p className="text-sm text-gray-500">
                  Display maintenance items that only require inspection (e.g., "Inspect brakes", "Inspect belts"). 
                  When off, these items are hidden from the maintenance plan to focus on actionable services.
                </p>
              </div>
            </label>
          </div>
        </div>

        <div className="flex justify-end">
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

        <div className="bg-blue-50 rounded-xl p-4 border border-blue-100">
          <p className="text-sm text-blue-800">
            These settings apply to your shop and affect what appears on the dashboard and vehicle pages.
          </p>
        </div>
      </div>
    </div>
  );
}
