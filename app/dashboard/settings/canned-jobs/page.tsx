"use client";

import { useState, useEffect } from "react";
import {
  Package,
  Loader2,
  RefreshCw,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Save,
  Plus,
  X,
  Edit3,
} from "lucide-react";

const SERVICE_KEYS = [
  { key: "oil", name: "Oil & Filter Change" },
  { key: "tire_rotation", name: "Tire Rotation" },
  { key: "engine_air", name: "Engine Air Filter" },
  { key: "cabin_air", name: "Cabin Air Filter" },
  { key: "inspect_brakes", name: "Brake Inspection" },
  { key: "brake_fluid", name: "Brake Fluid Flush" },
  { key: "coolant", name: "Coolant Flush" },
  { key: "trans_fluid", name: "Transmission Fluid" },
  { key: "spark_plugs", name: "Spark Plugs" },
  { key: "battery", name: "Battery" },
  { key: "alignment", name: "Wheel Alignment" },
  { key: "multi_point", name: "Multi-Point Inspection" },
  { key: "steering", name: "Steering Components" },
  { key: "suspension", name: "Suspension" },
];

type CannedJob = {
  id: string;
  title: string;
  description: string;
  chapter?: string;
  code?: string;
};

type Mapping = {
  [serviceKey: string]: string[];
};

export default function CannedJobsSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cannedJobs, setCannedJobs] = useState<CannedJob[]>([]);
  const [mappings, setMappings] = useState<Mapping>({});
  const [originalMappings, setOriginalMappings] = useState<Mapping>({});
  const [protractorConfigured, setProtractorConfigured] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [expandedService, setExpandedService] = useState<string | null>(null);
  const [showManualEntry, setShowManualEntry] = useState(false);
  const [manualId, setManualId] = useState("");
  const [manualTitle, setManualTitle] = useState("");

  useEffect(() => {
    checkProtractorStatus();
  }, []);

  async function checkProtractorStatus() {
    try {
      const res = await fetch("/api/settings/protractor", { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setProtractorConfigured(data.configured);
        if (data.configured) {
          await Promise.all([fetchCannedJobs(), fetchMappings()]);
        }
      }
    } catch (err) {
      console.error("Failed to check Protractor status:", err);
    } finally {
      setLoading(false);
    }
  }

  async function fetchCannedJobs(refresh = false) {
    setSyncing(true);
    try {
      const url = refresh
        ? "/api/protractor/canned-jobs?refresh=true"
        : "/api/protractor/canned-jobs";
      const res = await fetch(url, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setCannedJobs(data.cannedJobs || []);
        if (refresh) {
          setMessage({ type: "success", text: `Synced ${data.cannedJobs?.length || 0} canned jobs from Protractor` });
        }
      } else {
        const errorData = await res.json().catch(() => ({}));
        console.error("Failed to fetch canned jobs:", errorData);
        if (refresh) {
          setMessage({ type: "error", text: errorData.error || "Failed to sync canned jobs" });
        }
      }
    } catch (err) {
      console.error("Failed to fetch canned jobs:", err);
      if (refresh) {
        setMessage({ type: "error", text: "Failed to sync canned jobs" });
      }
    } finally {
      setSyncing(false);
    }
  }

  async function fetchMappings() {
    try {
      const res = await fetch("/api/settings/canned-job-mappings", { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        const normalized = normalizeMapping(data.mappings || {});
        setMappings(normalized);
        setOriginalMappings(normalized);
      }
    } catch (err) {
      console.error("Failed to fetch mappings:", err);
    }
  }

  function normalizeMapping(raw: Record<string, string | string[]>): Mapping {
    const result: Mapping = {};
    for (const key in raw) {
      const val = raw[key];
      if (Array.isArray(val)) {
        result[key] = val;
      } else if (typeof val === "string" && val) {
        result[key] = [val];
      }
    }
    return result;
  }

  async function handleSave() {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/settings/canned-job-mappings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ mappings }),
      });

      if (res.ok) {
        setOriginalMappings({ ...mappings });
        setMessage({ type: "success", text: "Canned job mappings saved successfully!" });
      } else {
        const data = await res.json();
        setMessage({ type: "error", text: data.error || "Failed to save mappings" });
      }
    } catch (err: any) {
      setMessage({ type: "error", text: err.message || "Failed to save mappings" });
    } finally {
      setSaving(false);
    }
  }

  function addCannedJobToService(serviceKey: string, cannedJobId: string) {
    if (!cannedJobId) return;
    setMappings((prev) => {
      const existing = prev[serviceKey] || [];
      if (existing.includes(cannedJobId)) return prev;
      return {
        ...prev,
        [serviceKey]: [...existing, cannedJobId],
      };
    });
  }

  function removeCannedJobFromService(serviceKey: string, cannedJobId: string) {
    setMappings((prev) => {
      const existing = prev[serviceKey] || [];
      const filtered = existing.filter((id) => id !== cannedJobId);
      if (filtered.length === 0) {
        const { [serviceKey]: _, ...rest } = prev;
        return rest;
      }
      return {
        ...prev,
        [serviceKey]: filtered,
      };
    });
  }

  function handleAddManualCannedJob() {
    if (!manualId.trim()) return;
    const newJob: CannedJob = {
      id: manualId.trim(),
      title: manualTitle.trim() || `Job ${manualId.trim()}`,
      description: "Manually added",
    };
    setCannedJobs((prev) => {
      if (prev.some((j) => j.id === newJob.id)) return prev;
      return [...prev, newJob];
    });
    setManualId("");
    setManualTitle("");
    setMessage({ type: "success", text: `Added canned job "${newJob.title}"` });
  }

  const hasChanges = JSON.stringify(mappings) !== JSON.stringify(originalMappings);
  const mappedCount = Object.keys(mappings).filter((k) => mappings[k]?.length > 0).length;
  const totalMappedJobs = Object.values(mappings).reduce((sum, arr) => sum + (arr?.length || 0), 0);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (!protractorConfigured) {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Package className="w-6 h-6" />
            Canned Job Mappings
          </h1>
          <p className="mt-2 text-gray-600">
            Map your maintenance recommendations to Protractor canned jobs for one-click RO additions.
          </p>
        </div>

        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-yellow-600 mt-0.5" />
            <div>
              <h3 className="font-medium text-yellow-900">Protractor Not Connected</h3>
              <p className="text-sm text-yellow-800 mt-1">
                You need to connect to Protractor first before you can configure canned job mappings.
                Go to Settings &gt; Protractor to set up your connection.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-6">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <Package className="w-6 h-6" />
          Canned Job Mappings
        </h1>
        <p className="mt-2 text-gray-600">
          Map maintenance recommendations to Protractor canned jobs. You can assign multiple canned jobs
          to each service - advisors will choose which one to apply when adding to the RO.
        </p>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
        <div className="p-4 border-b border-gray-200">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-sm text-gray-600">
                {cannedJobs.length} canned jobs available
              </span>
              {mappedCount > 0 && (
                <span className="px-2 py-1 bg-green-100 text-green-800 text-xs font-medium rounded-full">
                  {mappedCount} services mapped ({totalMappedJobs} jobs)
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowManualEntry(!showManualEntry)}
                className="px-3 py-1.5 text-sm bg-blue-50 text-blue-700 rounded-lg border border-blue-200 hover:bg-blue-100 transition-colors flex items-center gap-2"
              >
                <Edit3 className="w-4 h-4" />
                Add Manually
              </button>
              <button
                onClick={() => fetchCannedJobs(true)}
                disabled={syncing}
                className="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded-lg border border-gray-300 hover:bg-gray-200 transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                {syncing ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Syncing...
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-4 h-4" />
                    Sync Jobs
                  </>
                )}
              </button>
            </div>
          </div>

          {showManualEntry && (
            <div className="mt-4 p-4 bg-gray-50 rounded-lg border border-gray-200">
              <h4 className="text-sm font-medium text-gray-900 mb-3">Add Service Package Manually</h4>
              <p className="text-xs text-gray-600 mb-3">
                Enter the Service Package <strong>Code</strong> from Protractor (Setup &gt; Work Order Setup &gt; Services).
                The Code is a text identifier used to search and add packages to work orders.
              </p>
              <div className="flex gap-3">
                <input
                  type="text"
                  value={manualId}
                  onChange={(e) => setManualId(e.target.value)}
                  placeholder="Service Package Code (required)"
                  className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <input
                  type="text"
                  value={manualTitle}
                  onChange={(e) => setManualTitle(e.target.value)}
                  placeholder="Title (optional, for display)"
                  className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                  onClick={handleAddManualCannedJob}
                  disabled={!manualId.trim()}
                  className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  <Plus className="w-4 h-4" />
                  Add
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="divide-y divide-gray-100">
          {SERVICE_KEYS.map(({ key, name }) => {
            const selectedJobIds = mappings[key] || [];
            const selectedJobs = selectedJobIds
              .map((id) => cannedJobs.find((j) => j.id === id))
              .filter(Boolean) as CannedJob[];
            const isExpanded = expandedService === key;
            const availableJobs = cannedJobs.filter(
              (job) => !selectedJobIds.includes(job.id)
            );

            return (
              <div key={key} className="p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="font-medium text-gray-900 w-44">{name}</span>
                    {selectedJobs.length > 0 && (
                      <span className="px-2 py-0.5 bg-purple-100 text-purple-700 text-xs font-medium rounded-full">
                        {selectedJobs.length} option{selectedJobs.length !== 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {selectedJobs.length > 0 ? (
                      <CheckCircle2 className="w-5 h-5 text-green-600" />
                    ) : (
                      <XCircle className="w-5 h-5 text-gray-300" />
                    )}
                    <button
                      onClick={() => setExpandedService(isExpanded ? null : key)}
                      className="px-2 py-1 text-xs text-blue-600 hover:bg-blue-50 rounded"
                    >
                      {isExpanded ? "Hide" : "Edit"}
                    </button>
                  </div>
                </div>

                {selectedJobs.length > 0 && !isExpanded && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {selectedJobs.map((job) => (
                      <span
                        key={job.id}
                        className="inline-flex items-center px-2 py-1 bg-gray-100 text-gray-700 text-xs rounded"
                      >
                        {job.title}
                        {job.code ? ` (${job.code})` : ""}
                      </span>
                    ))}
                  </div>
                )}

                {isExpanded && (
                  <div className="mt-3 space-y-3">
                    {selectedJobs.length > 0 && (
                      <div className="space-y-2">
                        <span className="text-xs text-gray-500 uppercase tracking-wide">
                          Mapped Canned Jobs
                        </span>
                        {selectedJobs.map((job) => (
                          <div
                            key={job.id}
                            className="flex items-center justify-between p-2 bg-green-50 border border-green-200 rounded-lg"
                          >
                            <div>
                              <span className="text-sm font-medium text-gray-900">
                                {job.title}
                              </span>
                              {job.code && (
                                <span className="ml-2 text-xs text-gray-500">
                                  ({job.code})
                                </span>
                              )}
                            </div>
                            <button
                              onClick={() => removeCannedJobFromService(key, job.id)}
                              className="p-1 text-red-600 hover:bg-red-100 rounded"
                            >
                              <X className="w-4 h-4" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="flex items-center gap-2">
                      <select
                        className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
                        value=""
                        onChange={(e) => addCannedJobToService(key, e.target.value)}
                      >
                        <option value="">+ Add a canned job...</option>
                        {availableJobs.map((job) => (
                          <option key={job.id} value={job.id}>
                            {job.title}
                            {job.code ? ` (${job.code})` : ""}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {message && (
          <div
            className={`m-4 p-4 rounded-lg ${
              message.type === "success"
                ? "bg-green-50 text-green-800 border border-green-200"
                : "bg-red-50 text-red-800 border border-red-200"
            }`}
          >
            {message.text}
          </div>
        )}

        <div className="p-4 border-t border-gray-200 flex justify-end">
          <button
            onClick={handleSave}
            disabled={saving || !hasChanges}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {saving ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save className="w-4 h-4" />
                Save Mappings
              </>
            )}
          </button>
        </div>
      </div>

      <div className="mt-6 bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h3 className="font-medium text-blue-900 mb-2">How it works</h3>
        <ul className="text-sm text-blue-800 space-y-1 list-disc list-inside">
          <li>Click &quot;Edit&quot; to add multiple canned jobs to each service type</li>
          <li>When multiple options exist, advisors will see a dropdown to choose which canned job applies</li>
          <li>If only one canned job is mapped, it will be used automatically</li>
          <li>Clicking &quot;Add to RO&quot; on the Plan page adds the selected canned job to the vehicle&apos;s open work order</li>
        </ul>
      </div>
    </div>
  );
}
