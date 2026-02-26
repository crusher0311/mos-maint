"use client";

import { useState, useEffect } from "react";
import { Settings, Loader2, Check, Globe, List, Eye, Car, Tag, Building2 } from "lucide-react";

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
type EnterpriseShop = { shopId: number; name: string; locationIdentifier: string | null };

export default function PreferencesPage() {
  const [distanceUnit, setDistanceUnit] = useState("miles");
  const [workflowStages, setWorkflowStages] = useState<string[]>(DEFAULT_STAGES);
  const [showInspectItems, setShowInspectItems] = useState(true);
  const [showOnlyWithMileage, setShowOnlyWithMileage] = useState(true);
  const [showRecalls, setShowRecalls] = useState(true);
  const [recallsExpanded, setRecallsExpanded] = useState(true);
  const [shopwareAddMode, setShopwareAddMode] = useState("finding-published");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [hasProtractor, setHasProtractor] = useState(false);
  const [hasTekmetric, setHasTekmetric] = useState(false);
  const [hasShopware, setHasShopware] = useState(false);
  const [tekmetricLabels, setTekmetricLabels] = useState<TekmetricLabel[]>([]);
  const [selectedTekmetricLabels, setSelectedTekmetricLabels] = useState<string[]>([]);
  const [enterpriseShops, setEnterpriseShops] = useState<EnterpriseShop[]>([]);
  const [jobHistoryShopIds, setJobHistoryShopIds] = useState<number[] | null>(null);

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
        setShowRecalls(data.showRecalls !== false);
        setRecallsExpanded(data.recallsExpanded !== false);
        setSelectedTekmetricLabels(data.tekmetricLabels || []);
        setEnterpriseShops(data.enterpriseShops || []);
        setJobHistoryShopIds(data.jobHistoryShopIds || null);
        setShopwareAddMode(data.shopwareAddMode || "finding-published");
      }
      
      if (integrationsRes.ok) {
        const integrations = await integrationsRes.json();
        setHasProtractor(!!integrations.protractor?.configured);
        setHasTekmetric(!!integrations.tekmetric?.configured);
        setHasShopware(!!integrations.shopware?.configured);
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

  function toggleJobHistoryShop(shopIdToToggle: number) {
    setJobHistoryShopIds(prev => {
      if (prev === null) {
        // First selection - enable only selected shops (excluding this one means include all others)
        return enterpriseShops
          .map(s => s.shopId)
          .filter(id => id !== shopIdToToggle);
      }
      if (prev.includes(shopIdToToggle)) {
        const newList = prev.filter(id => id !== shopIdToToggle);
        // If removing last one, set to null (show all)
        return newList.length === 0 ? null : newList;
      }
      return [...prev, shopIdToToggle];
    });
  }

  function selectAllEnterpriseShops() {
    setJobHistoryShopIds(null); // null means all
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
          showRecalls,
          recallsExpanded,
          tekmetricLabels: selectedTekmetricLabels,
          jobHistoryShopIds,
          shopwareAddMode
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

        {hasShopware && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
            <div className="flex items-center gap-3 mb-6">
              <Car className="w-5 h-5 text-gray-500" />
              <h2 className="text-lg font-semibold text-gray-900">Shop-Ware Extension Settings</h2>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Default Add-to-RO Mode
                </label>
                <p className="text-sm text-gray-500 mb-3">
                  Set the shop-wide default for how recommendations are added to Shop-Ware work orders. Individual users can override this in the extension settings.
                </p>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <label className={`flex items-start gap-3 p-4 border rounded-lg cursor-pointer hover:bg-gray-50 transition-colors ${shopwareAddMode === 'finding-published' ? 'border-blue-500 bg-blue-50' : ''}`}>
                    <input
                      type="radio"
                      name="shopwareAddMode"
                      value="finding-published"
                      checked={shopwareAddMode === "finding-published"}
                      onChange={(e) => setShopwareAddMode(e.target.value)}
                      className="w-4 h-4 text-blue-600 mt-0.5"
                    />
                    <div>
                      <p className="font-medium text-gray-900">Add Finding (Published)</p>
                      <p className="text-xs text-gray-500 mt-1">Adds as a published finding on the right panel, visible to the customer</p>
                    </div>
                  </label>
                  <label className={`flex items-start gap-3 p-4 border rounded-lg cursor-pointer hover:bg-gray-50 transition-colors ${shopwareAddMode === 'finding-draft' ? 'border-blue-500 bg-blue-50' : ''}`}>
                    <input
                      type="radio"
                      name="shopwareAddMode"
                      value="finding-draft"
                      checked={shopwareAddMode === "finding-draft"}
                      onChange={(e) => setShopwareAddMode(e.target.value)}
                      className="w-4 h-4 text-blue-600 mt-0.5"
                    />
                    <div>
                      <p className="font-medium text-gray-900">Add Finding (Draft)</p>
                      <p className="text-xs text-gray-500 mt-1">Adds as a draft finding on the right panel, internal only until published</p>
                    </div>
                  </label>
                  <label className={`flex items-start gap-3 p-4 border rounded-lg cursor-pointer hover:bg-gray-50 transition-colors ${shopwareAddMode === 'add-service' ? 'border-blue-500 bg-blue-50' : ''}`}>
                    <input
                      type="radio"
                      name="shopwareAddMode"
                      value="add-service"
                      checked={shopwareAddMode === "add-service"}
                      onChange={(e) => setShopwareAddMode(e.target.value)}
                      className="w-4 h-4 text-blue-600 mt-0.5"
                    />
                    <div>
                      <p className="font-medium text-gray-900">Add Service (Direct)</p>
                      <p className="text-xs text-gray-500 mt-1">Adds the canned job directly as a service line item on the RO</p>
                    </div>
                  </label>
                </div>
              </div>
            </div>
          </div>
        )}

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

        {enterpriseShops.length > 1 && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
            <div className="flex items-center gap-3 mb-6">
              <Building2 className="w-5 h-5 text-gray-500" />
              <h2 className="text-lg font-semibold text-gray-900">Job History Locations</h2>
            </div>

            <div className="space-y-4">
              <p className="text-sm text-gray-500">
                Select which locations in your organization you want to see job history from when searching.
                This affects job search results across your enterprise.
              </p>

              <div className="flex items-center gap-2 mb-4">
                <button
                  type="button"
                  onClick={selectAllEnterpriseShops}
                  className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
                    jobHistoryShopIds === null
                      ? "bg-blue-600 text-white"
                      : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                  }`}
                >
                  All Locations
                </button>
                <span className="text-sm text-gray-500">or select specific locations:</span>
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {enterpriseShops.map((shop) => {
                  const isSelected = jobHistoryShopIds === null || jobHistoryShopIds.includes(shop.shopId);
                  return (
                    <label
                      key={shop.shopId}
                      className={`flex items-start gap-3 p-4 border rounded-lg cursor-pointer transition-colors ${
                        isSelected
                          ? "border-blue-500 bg-blue-50"
                          : "border-gray-200 hover:bg-gray-50"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleJobHistoryShop(shop.shopId)}
                        className="w-4 h-4 text-blue-600 mt-0.5"
                      />
                      <div>
                        <p className="font-medium text-gray-900">
                          {shop.name}
                          {shop.locationIdentifier && (
                            <span className="ml-2 text-sm font-normal text-gray-500">
                              ({shop.locationIdentifier})
                            </span>
                          )}
                        </p>
                      </div>
                    </label>
                  );
                })}
              </div>

              {jobHistoryShopIds !== null && (
                <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
                  <p className="text-sm text-blue-800">
                    {jobHistoryShopIds.length} location{jobHistoryShopIds.length !== 1 ? 's' : ''} selected. 
                    Job search will only include history from these locations.
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

            <label
              className={`flex items-start gap-3 p-4 border rounded-lg cursor-pointer transition-colors ${
                showRecalls
                  ? "border-blue-500 bg-blue-50"
                  : "border-gray-200 hover:bg-gray-50"
              }`}
            >
              <input
                type="checkbox"
                checked={showRecalls}
                onChange={(e) => setShowRecalls(e.target.checked)}
                className="w-4 h-4 text-blue-600 mt-0.5"
              />
              <div>
                <p className="font-medium text-gray-900">Show NHTSA Recalls</p>
                <p className="text-sm text-gray-500">
                  Display NHTSA safety recalls at the top of the Vehicle Health Indicator page.
                  When off, the recalls section is hidden from the maintenance plan.
                </p>
              </div>
            </label>

            {showRecalls && (
              <label
                className={`flex items-start gap-3 p-4 border rounded-lg cursor-pointer transition-colors ml-6 ${
                  recallsExpanded
                    ? "border-blue-500 bg-blue-50"
                    : "border-gray-200 hover:bg-gray-50"
                }`}
              >
                <input
                  type="checkbox"
                  checked={recallsExpanded}
                  onChange={(e) => setRecallsExpanded(e.target.checked)}
                  className="w-4 h-4 text-blue-600 mt-0.5"
                />
                <div>
                  <p className="font-medium text-gray-900">Recalls Expanded by Default</p>
                  <p className="text-sm text-gray-500">
                    When on, recalls are shown expanded. When off, recalls are collapsed and can be expanded by clicking.
                  </p>
                </div>
              </label>
            )}
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
