"use client";

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
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
  Search,
  ChevronDown,
  ChevronRight,
  ArrowUpDown,
  Link2,
  EyeOff,
  Eye,
} from "lucide-react";
import CopyFromLocationDropdown from "@/components/ui/CopyFromLocationDropdown";

// Service keys aligned with CARFAX categories
const SERVICE_KEYS = [
  { key: "oil", name: "Oil Change / Engine Oil Filter" },
  { key: "tire_rotation", name: "Tire Rotation" },
  { key: "cabin_air", name: "Cabin Air Filter Replacement" },
  { key: "engine_air", name: "Air Filter Replacement" },
  { key: "coolant", name: "Coolant Service" },
  { key: "brake_fluid", name: "Brake Fluid Service" },
  { key: "trans_auto", name: "Automatic Transmission Fluid" },
  { key: "trans_manual", name: "Manual Transmission Fluid" },
  { key: "transfer_case", name: "Transfer Case Fluid" },
  { key: "front_differential", name: "Front Differential Fluid" },
  { key: "rear_differential", name: "Rear Differential Fluid" },
  { key: "power_steering", name: "Power Steering Fluid" },
  { key: "fuel_filter", name: "Fuel Filter Replacement" },
  { key: "spark_plugs", name: "Spark Plugs Replacement" },
  { key: "serpentine_belt", name: "Serpentine Belt Replacement" },
  { key: "timing_belt", name: "Timing Belt Replacement" },
  { key: "fuel_system", name: "Fuel System Cleaning" },
  { key: "brake_pads", name: "Brake Linings/Pads Replacement" },
  { key: "front_shocks", name: "Front Shocks / Struts" },
  { key: "rear_shocks", name: "Rear Shocks / Struts" },
  { key: "wheel_alignment", name: "Wheel Alignment" },
  { key: "battery", name: "Battery Replacement" },
  { key: "wiper_blades", name: "Wiper Blades" },
  { key: "ac_refrigerant", name: "A/C Service" },
  { key: "emissions", name: "Emissions Test" },
];

type CannedJobLine = {
  id?: string;
  lineType?: string;
  description?: string;
  quantity?: number;
  unitPrice?: number;
  extendedPrice?: number;
  partNumber?: string;
  manufacturer?: string;
};

type CannedJob = {
  id: string;
  title: string;
  description: string;
  chapter?: string;
  code?: string;
  laborHours?: number;
  laborRate?: number;
  fixedPrice?: number;
  lineCount?: number;
  lines?: CannedJobLine[];
};

type Mapping = {
  [serviceKey: string]: string[];
};

type IntegrationType = "protractor" | "tekmetric" | null;

export default function CannedJobsSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [deepSyncing, setDeepSyncing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cannedJobs, setCannedJobs] = useState<CannedJob[]>([]);
  const [manualJobs, setManualJobs] = useState<CannedJob[]>([]);
  const [mappings, setMappings] = useState<Mapping>({});
  const [originalMappings, setOriginalMappings] = useState<Mapping>({});
  const [originalManualJobs, setOriginalManualJobs] = useState<CannedJob[]>([]);
  const [activeIntegration, setActiveIntegration] = useState<IntegrationType>(null);
  const [integrationName, setIntegrationName] = useState<string>("");
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [showManualEntry, setShowManualEntry] = useState(false);
  const [manualId, setManualId] = useState("");
  const [manualTitle, setManualTitle] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<"code" | "title">("code");
  const [showDeferredSection, setShowDeferredSection] = useState(false);
  const [assigningJobId, setAssigningJobId] = useState<string | null>(null);
  const [hiddenJobIds, setHiddenJobIds] = useState<string[]>([]);
  const [originalHiddenJobIds, setOriginalHiddenJobIds] = useState<string[]>([]);
  const [showHiddenJobs, setShowHiddenJobs] = useState(false);
  const [autoSaving, setAutoSaving] = useState(false);
  const [lastAutoSaved, setLastAutoSaved] = useState<Date | null>(null);
  const autoSaveTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isInitialLoadRef = useRef(true);

  useEffect(() => {
    checkIntegrationStatus();
  }, []);

  async function checkIntegrationStatus() {
    try {
      // Check the shop's saved SMS provider from the integrations settings
      const integrationsRes = await fetch("/api/settings/integrations", { credentials: "include" });
      const integrationsData = integrationsRes.ok ? await integrationsRes.json() : {};
      
      const { smsProvider, protractor, tekmetric } = integrationsData;
      
      // Use saved smsProvider preference if available and configured
      if (smsProvider === "tekmetric" && tekmetric?.configured) {
        setActiveIntegration("tekmetric");
        setIntegrationName("Tekmetric");
        await Promise.all([fetchCannedJobs("tekmetric"), fetchMappings()]);
      } else if (smsProvider === "protractor" && protractor?.configured) {
        setActiveIntegration("protractor");
        setIntegrationName("Protractor");
        await Promise.all([fetchCannedJobs("protractor"), fetchMappings()]);
      } else if (tekmetric?.configured) {
        // Fallback if no preference saved but integration is configured
        setActiveIntegration("tekmetric");
        setIntegrationName("Tekmetric");
        await Promise.all([fetchCannedJobs("tekmetric"), fetchMappings()]);
      } else if (protractor?.configured) {
        setActiveIntegration("protractor");
        setIntegrationName("Protractor");
        await Promise.all([fetchCannedJobs("protractor"), fetchMappings()]);
      }
      // If smsProvider is "standalone" or nothing configured, activeIntegration remains null
    } catch (err) {
      console.error("Failed to check integration status:", err);
    } finally {
      setLoading(false);
    }
  }

  async function fetchCannedJobs(integrationOrRefresh: IntegrationType | boolean = false) {
    const isRefresh = typeof integrationOrRefresh === "boolean" ? integrationOrRefresh : false;
    const integration = typeof integrationOrRefresh === "string" ? integrationOrRefresh : activeIntegration;
    
    if (!integration) return;
    
    setSyncing(true);
    try {
      const baseUrl = integration === "tekmetric" 
        ? "/api/tekmetric/canned-jobs" 
        : "/api/protractor/canned-jobs";
      const url = isRefresh ? `${baseUrl}?refresh=true` : baseUrl;
      const res = await fetch(url, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        const jobs = data.cannedJobs || [];
        setCannedJobs(jobs);
        if (isRefresh) {
          const codes = jobs.map((j: CannedJob) => j.code || j.id).filter(Boolean).slice(0, 20);
          const moreCount = jobs.length > 20 ? ` (+${jobs.length - 20} more)` : "";
          console.log("[CannedJobs] Synced codes:", jobs.map((j: CannedJob) => j.code || j.id).filter(Boolean).join(", "));
          setMessage({ 
            type: "success", 
            text: `Synced ${jobs.length} canned jobs: ${codes.join(", ")}${moreCount}` 
          });
        }
      } else {
        const errorData = await res.json().catch(() => ({}));
        console.error("Failed to fetch canned jobs:", errorData);
        if (isRefresh) {
          setMessage({ type: "error", text: errorData.error || "Failed to sync canned jobs" });
        }
      }
    } catch (err) {
      console.error("Failed to fetch canned jobs:", err);
      if (isRefresh) {
        setMessage({ type: "error", text: "Failed to sync canned jobs" });
      }
    } finally {
      setSyncing(false);
    }
  }

  async function deepSyncCannedJobs() {
    setDeepSyncing(true);
    setMessage({ type: "success", text: "Deep sync started - scanning all service packages. This may take 10-15 minutes..." });
    try {
      const res = await fetch("/api/protractor/canned-jobs/enrich", { 
        method: "POST",
        credentials: "include" 
      });
      if (res.ok) {
        const data = await res.json();
        setMessage({ 
          type: "success", 
          text: `Deep sync complete: Scanned ${data.totalScanned} items, found ${data.usefulJobs} with titles/content` 
        });
        await fetchCannedJobs();
      } else {
        const errorData = await res.json().catch(() => ({}));
        console.error("Deep sync failed:", errorData);
        setMessage({ type: "error", text: errorData.error || "Deep sync failed" });
      }
    } catch (err) {
      console.error("Deep sync failed:", err);
      setMessage({ type: "error", text: "Deep sync failed - check console for details" });
    } finally {
      setDeepSyncing(false);
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
        
        const savedManualJobs = (data.manualJobs || []).map((j: any) => ({
          id: j.id,
          title: j.title || `Job ${j.id}`,
          description: j.description || "Manually added",
        }));
        setManualJobs(savedManualJobs);
        setOriginalManualJobs(savedManualJobs);
        setCannedJobs((prev) => {
          const existingIds = new Set(prev.map((p) => p.id));
          const newJobs = savedManualJobs.filter((j: CannedJob) => !existingIds.has(j.id));
          return [...prev, ...newJobs];
        });
        
        const hidden = data.hiddenJobIds || [];
        setHiddenJobIds(hidden);
        setOriginalHiddenJobIds(hidden);
      }
      isInitialLoadRef.current = false;
    } catch (err) {
      console.error("Failed to fetch mappings:", err);
      isInitialLoadRef.current = false;
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
        body: JSON.stringify({ mappings, manualJobs, hiddenJobIds }),
      });

      if (res.ok) {
        setOriginalMappings({ ...mappings });
        setOriginalManualJobs([...manualJobs]);
        setOriginalHiddenJobIds([...hiddenJobIds]);
        setMessage({ type: "success", text: "Service package mappings saved successfully!" });
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

  const performAutoSave = useCallback(async () => {
    setAutoSaving(true);
    try {
      const res = await fetch("/api/settings/canned-job-mappings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ mappings, manualJobs, hiddenJobIds }),
      });

      if (res.ok) {
        setOriginalMappings({ ...mappings });
        setOriginalManualJobs([...manualJobs]);
        setOriginalHiddenJobIds([...hiddenJobIds]);
        setLastAutoSaved(new Date());
      }
    } catch (err) {
      console.error("Autosave failed:", err);
    } finally {
      setAutoSaving(false);
    }
  }, [mappings, manualJobs, hiddenJobIds]);

  useEffect(() => {
    if (isInitialLoadRef.current || loading) return;
    
    const hasChanges = 
      JSON.stringify(mappings) !== JSON.stringify(originalMappings) ||
      JSON.stringify(manualJobs) !== JSON.stringify(originalManualJobs) ||
      JSON.stringify(hiddenJobIds.sort()) !== JSON.stringify(originalHiddenJobIds.sort());
    
    if (!hasChanges) return;

    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
    }

    autoSaveTimerRef.current = setTimeout(() => {
      performAutoSave();
    }, 1000);

    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
      }
    };
  }, [mappings, manualJobs, hiddenJobIds, originalMappings, originalManualJobs, originalHiddenJobIds, loading, performAutoSave]);

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
    setManualJobs((prev) => {
      if (prev.some((j) => j.id === newJob.id)) return prev;
      return [...prev, newJob];
    });
    setManualId("");
    setManualTitle("");
    setMessage({ type: "success", text: `Added "${newJob.title}" - changes will save automatically` });
  }

  const hasChanges = 
    JSON.stringify(mappings) !== JSON.stringify(originalMappings) ||
    JSON.stringify(manualJobs) !== JSON.stringify(originalManualJobs) ||
    JSON.stringify(hiddenJobIds.sort()) !== JSON.stringify(originalHiddenJobIds.sort());
  const mappedCount = Object.keys(mappings).filter((k) => mappings[k]?.length > 0).length;
  const totalMappedJobs = Object.values(mappings).reduce((sum, arr) => sum + (arr?.length || 0), 0);

  function toggleHideJob(jobId: string) {
    setHiddenJobIds(prev => 
      prev.includes(jobId) 
        ? prev.filter(id => id !== jobId) 
        : [...prev, jobId]
    );
  }

  function getJobMappedServices(jobId: string): string[] {
    const services: string[] = [];
    for (const [serviceKey, jobIds] of Object.entries(mappings)) {
      if (jobIds?.includes(jobId)) {
        const service = SERVICE_KEYS.find(s => s.key === serviceKey);
        if (service) services.push(service.name);
      }
    }
    return services;
  }

  const { serviceJobs, deferredJobs } = useMemo(() => {
    const service = cannedJobs.filter(j => 
      j.chapter !== 'DeferredService' && j.chapter !== 'DeferredInspection'
    );
    const deferred = cannedJobs.filter(j => 
      j.chapter === 'DeferredService' || j.chapter === 'DeferredInspection'
    );
    return { serviceJobs: service, deferredJobs: deferred };
  }, [cannedJobs]);

  const filteredAndSortedJobs = useMemo(() => {
    let jobs = [...serviceJobs];
    
    // Filter hidden jobs unless showing them
    if (!showHiddenJobs) {
      jobs = jobs.filter(j => !hiddenJobIds.includes(j.id));
    }
    
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      jobs = jobs.filter(j => 
        (j.title || "").toLowerCase().includes(q) ||
        (j.code || "").toLowerCase().includes(q) ||
        (j.description || "").toLowerCase().includes(q)
      );
    }
    
    jobs.sort((a, b) => {
      if (sortBy === "code") {
        return (a.code || "").localeCompare(b.code || "");
      } else {
        return (a.title || "").localeCompare(b.title || "");
      }
    });
    
    return jobs;
  }, [serviceJobs, searchQuery, sortBy, hiddenJobIds, showHiddenJobs]);
  
  const hiddenCount = serviceJobs.filter(j => hiddenJobIds.includes(j.id)).length;

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (!activeIntegration) {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Package className="w-6 h-6" />
            Canned Job Mappings
          </h1>
          <p className="mt-2 text-gray-600">
            Map your maintenance recommendations to canned jobs for one-click RO additions.
          </p>
        </div>

        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-yellow-600 mt-0.5" />
            <div>
              <h3 className="font-medium text-yellow-900">No Shop Management System Connected</h3>
              <p className="text-sm text-yellow-800 mt-1">
                You need to connect to Protractor or Tekmetric first before you can configure canned job mappings.
                Go to Settings &gt; Integrations to set up your connection.
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
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Package className="w-6 h-6" />
            Canned Job Mappings
            <span className="ml-2 px-2 py-0.5 text-xs font-medium bg-blue-100 text-blue-700 rounded-full">
              {integrationName}
            </span>
          </h1>
          <CopyFromLocationDropdown
            settingType="cannedJobs"
            onCopyComplete={fetchMappings}
            disabled={saving}
          />
        </div>
        <p className="mt-2 text-gray-600">
          Map maintenance recommendations to {integrationName} canned jobs. You can assign multiple canned jobs
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
                disabled={syncing || deepSyncing}
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
                    Sync
                  </>
                )}
              </button>
              {activeIntegration === "protractor" && (
                <button
                  onClick={deepSyncCannedJobs}
                  disabled={syncing || deepSyncing}
                  className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 flex items-center gap-2"
                  title="Scan all service packages and fetch details - takes 10-15 min"
                >
                  {deepSyncing ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Deep Syncing...
                    </>
                  ) : (
                    <>
                      <RefreshCw className="w-4 h-4" />
                      Deep Sync
                    </>
                  )}
                </button>
              )}
            </div>
          </div>

          {showManualEntry && (
            <div className="mt-4 p-4 bg-gray-50 rounded-lg border border-gray-200">
              <h4 className="text-sm font-medium text-gray-900 mb-3">Add Canned Job Manually</h4>
              <p className="text-xs text-gray-600 mb-3">
                {activeIntegration === "protractor" 
                  ? "Enter the Service Package Code from Protractor (Setup > Work Order Setup > Services)."
                  : "Enter the Canned Job ID from Tekmetric."}
                {" "}The ID is used to add jobs to work orders.
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
                  </div>
                </div>

                {selectedJobs.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {selectedJobs.map((job) => (
                      <span
                        key={job.id}
                        className="inline-flex items-center gap-1 px-2 py-1 bg-gray-100 text-gray-700 text-xs rounded group"
                      >
                        {job.title}
                        {job.code ? ` (${job.code})` : ""}
                        <button
                          onClick={() => removeCannedJobFromService(key, job.id)}
                          className="ml-1 p-0.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded opacity-0 group-hover:opacity-100 transition-opacity"
                          title="Remove mapping"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
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

        <div className="p-4 border-t border-gray-200 flex items-center justify-between">
          <div className="text-sm text-gray-500 flex items-center gap-2">
            {autoSaving ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
                <span>Saving changes...</span>
              </>
            ) : lastAutoSaved ? (
              <>
                <CheckCircle2 className="w-4 h-4 text-green-500" />
                <span>Saved {lastAutoSaved.toLocaleTimeString()}</span>
              </>
            ) : hasChanges ? (
              <>
                <AlertCircle className="w-4 h-4 text-amber-500" />
                <span>Unsaved changes</span>
              </>
            ) : (
              <span className="text-gray-400">All changes saved</span>
            )}
          </div>
          <button
            onClick={handleSave}
            disabled={saving || autoSaving || !hasChanges}
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
                Save Now
              </>
            )}
          </button>
        </div>
      </div>

      <div className="mt-6 bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h3 className="font-medium text-blue-900 mb-2">How it works</h3>
        <ul className="text-sm text-blue-800 space-y-1 list-disc list-inside">
          <li>Click a canned job card below to assign it to a service type</li>
          <li>Hover over a mapped job above and click X to remove it</li>
          <li>When multiple options exist, advisors will see a dropdown to choose which canned job applies</li>
          <li>If only one canned job is mapped, it will be used automatically</li>
        </ul>
      </div>

      {/* Canned Job Library Cards */}
      <div className="mt-8">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Canned Job Library</h2>
        <p className="text-sm text-gray-600 mb-4">
          Browse and assign service packages. Click a card to map it to a service type.
        </p>
        
        {/* Search and Sort Controls */}
        <div className="flex flex-col sm:flex-row gap-3 mb-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              placeholder="Search by code, title, or description..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
            />
          </div>
          <button
            onClick={() => setSortBy(sortBy === "code" ? "title" : "code")}
            className="flex items-center gap-2 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-sm text-gray-700"
          >
            <ArrowUpDown className="w-4 h-4" />
            Sort by {sortBy === "code" ? "Code" : "Title"}
          </button>
          {hiddenCount > 0 && (
            <button
              onClick={() => setShowHiddenJobs(!showHiddenJobs)}
              className={`flex items-center gap-2 px-4 py-2 border rounded-lg text-sm transition-colors ${
                showHiddenJobs 
                  ? "border-amber-300 bg-amber-50 text-amber-700" 
                  : "border-gray-300 hover:bg-gray-50 text-gray-700"
              }`}
            >
              {showHiddenJobs ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
              {showHiddenJobs ? "Showing Hidden" : `${hiddenCount} Hidden`}
            </button>
          )}
        </div>
        
        <p className="text-xs text-gray-500 mb-3">
          Showing {filteredAndSortedJobs.length} of {serviceJobs.length - hiddenCount} visible service packages
          {hiddenCount > 0 && !showHiddenJobs && ` (${hiddenCount} hidden)`}
        </p>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filteredAndSortedJobs.map((job) => {
            const mappedServices = getJobMappedServices(job.id);
            const isAssigning = assigningJobId === job.id;
            
            return (
              <div key={job.id} className="relative">
                <CannedJobCard 
                  job={job} 
                  mappedServices={mappedServices}
                  onClick={() => setAssigningJobId(isAssigning ? null : job.id)}
                  isSelected={isAssigning}
                  isHidden={hiddenJobIds.includes(job.id)}
                />
                
                {isAssigning && (
                  <div className="fixed inset-0 z-40" onClick={() => setAssigningJobId(null)} />
                )}
                {isAssigning && (
                  <div className="absolute bottom-full left-0 right-0 z-50 mb-1 bg-white border border-gray-200 rounded-lg shadow-lg p-3">
                    <div className="text-xs font-medium text-gray-500 mb-2">Assign to service:</div>
                    <div className="grid grid-cols-2 gap-1 max-h-48 overflow-y-auto">
                      {SERVICE_KEYS.map(({ key, name }) => {
                        const isLinked = mappings[key]?.includes(job.id);
                        return (
                          <button
                            key={key}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (isLinked) {
                                removeCannedJobFromService(key, job.id);
                              } else {
                                addCannedJobToService(key, job.id);
                              }
                            }}
                            className={`text-left px-2 py-1.5 rounded text-xs transition-colors ${
                              isLinked 
                                ? "bg-green-100 text-green-800 hover:bg-green-200" 
                                : "hover:bg-gray-100 text-gray-700"
                            }`}
                          >
                            {isLinked && <span className="mr-1">✓</span>}
                            {name}
                          </button>
                        );
                      })}
                    </div>
                    <div className="mt-2 pt-2 border-t border-gray-100 flex gap-2">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleHideJob(job.id);
                          setAssigningJobId(null);
                        }}
                        className={`flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded text-xs transition-colors ${
                          hiddenJobIds.includes(job.id)
                            ? "bg-amber-100 text-amber-700 hover:bg-amber-200"
                            : "hover:bg-gray-100 text-gray-600"
                        }`}
                      >
                        {hiddenJobIds.includes(job.id) ? (
                          <>
                            <Eye className="w-3 h-3" />
                            Unhide
                          </>
                        ) : (
                          <>
                            <EyeOff className="w-3 h-3" />
                            Hide from list
                          </>
                        )}
                      </button>
                      <button
                        onClick={() => setAssigningJobId(null)}
                        className="flex-1 text-xs text-gray-500 hover:text-gray-700 py-1.5"
                      >
                        Close
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        
        {filteredAndSortedJobs.length === 0 && searchQuery && (
          <div className="text-center py-8 text-gray-500">
            No canned jobs match &quot;{searchQuery}&quot;
          </div>
        )}
        
        {cannedJobs.length === 0 && (
          <div className="text-center py-8 text-gray-500">
            No canned jobs available. Click &quot;Sync Jobs&quot; to fetch from Protractor.
          </div>
        )}
        
        {/* Deferred Services Section (Collapsed) */}
        {deferredJobs.length > 0 && (
          <div className="mt-6 border border-gray-200 rounded-lg">
            <button
              onClick={() => setShowDeferredSection(!showDeferredSection)}
              className="w-full flex items-center justify-between p-4 text-left hover:bg-gray-50"
            >
              <div className="flex items-center gap-2">
                {showDeferredSection ? (
                  <ChevronDown className="w-4 h-4 text-gray-500" />
                ) : (
                  <ChevronRight className="w-4 h-4 text-gray-500" />
                )}
                <span className="text-sm font-medium text-gray-700">
                  Deferred Service References ({deferredJobs.length})
                </span>
              </div>
              <span className="text-xs text-gray-500">
                Auto-generated from declined work
              </span>
            </button>
            
            {showDeferredSection && (
              <div className="p-4 pt-0 border-t border-gray-100">
                <p className="text-xs text-gray-500 mb-3">
                  These are reference codes from declined services. They don&apos;t have full template details.
                </p>
                <div className="flex flex-wrap gap-2">
                  {deferredJobs.map((job) => (
                    <span
                      key={job.id}
                      className="px-2 py-1 bg-gray-100 text-gray-600 text-xs rounded font-mono"
                    >
                      {job.code || job.id}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function CannedJobCard({ 
  job, 
  mappedServices = [], 
  onClick,
  isSelected = false,
  isHidden = false
}: { 
  job: CannedJob; 
  mappedServices?: string[];
  onClick?: () => void;
  isSelected?: boolean;
  isHidden?: boolean;
}) {
  const estimatedTotal = job.fixedPrice ?? (job.laborHours && job.laborRate ? job.laborHours * job.laborRate : null);
  
  return (
    <div 
      className={`rounded-lg border shadow-sm overflow-hidden transition-all cursor-pointer ${
        isHidden
          ? "bg-gray-50 opacity-60"
          : "bg-white"
      } ${
        isSelected 
          ? "border-blue-500 ring-2 ring-blue-200 shadow-md" 
          : "border-gray-200 hover:shadow-md hover:border-gray-300"
      }`}
      onClick={onClick}
    >
      {/* Header */}
      <div className={`px-4 py-3 border-b border-gray-200 ${isHidden ? "bg-gray-100" : "bg-gray-50"}`}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {isHidden && (
                <span className="px-2 py-0.5 bg-amber-100 text-amber-700 text-xs font-medium rounded flex items-center gap-1">
                  <EyeOff className="w-3 h-3" />
                  Hidden
                </span>
              )}
              {job.code && (
                <span className="px-2 py-0.5 bg-blue-100 text-blue-700 text-xs font-mono font-medium rounded">
                  {job.code}
                </span>
              )}
              {job.chapter && (
                <span className="px-2 py-0.5 bg-gray-100 text-gray-600 text-xs rounded">
                  {job.chapter}
                </span>
              )}
            </div>
            <h3 className="mt-1 font-medium text-gray-900 text-sm leading-tight">
              {job.title}
            </h3>
          </div>
          {estimatedTotal != null && (
            <div className="text-right flex-shrink-0">
              <div className="text-lg font-semibold text-green-600">
                ${estimatedTotal.toFixed(2)}
              </div>
              {job.fixedPrice != null && (
                <div className="text-xs text-gray-500">fixed price</div>
              )}
            </div>
          )}
        </div>
      </div>
      
      {/* Body */}
      <div className="px-4 py-3 space-y-3">
        {/* Description */}
        {job.description && (
          <p className="text-sm text-gray-600 line-clamp-2">
            {job.description}
          </p>
        )}
        
        {/* Labor info */}
        {(job.laborHours != null || job.laborRate != null) && (
          <div className="flex items-center gap-4 text-sm">
            {job.laborHours != null && (
              <div className="flex items-center gap-1.5">
                <span className="text-gray-500">Labor:</span>
                <span className="font-medium text-gray-900">{job.laborHours} hrs</span>
              </div>
            )}
            {job.laborRate != null && (
              <div className="flex items-center gap-1.5">
                <span className="text-gray-500">Rate:</span>
                <span className="font-medium text-gray-900">${job.laborRate}/hr</span>
              </div>
            )}
          </div>
        )}
        
        {/* Line items preview */}
        {job.lines && job.lines.length > 0 ? (
          <div className="space-y-1.5">
            <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">
              Included Items
            </div>
            <div className="space-y-1">
              {job.lines.slice(0, 4).map((line, idx) => (
                <div key={line.id || idx} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                      line.lineType?.toLowerCase() === 'labor' ? 'bg-blue-400' : 'bg-amber-400'
                    }`} />
                    <span className="text-gray-700 truncate">
                      {line.description || line.partNumber || 'Item'}
                    </span>
                    {line.partNumber && line.description && (
                      <span className="text-xs text-gray-400">({line.partNumber})</span>
                    )}
                  </div>
                  {line.extendedPrice != null && (
                    <span className="text-gray-600 font-medium flex-shrink-0 ml-2">
                      ${line.extendedPrice.toFixed(2)}
                    </span>
                  )}
                </div>
              ))}
              {job.lines.length > 4 && (
                <div className="text-xs text-gray-500 italic">
                  +{job.lines.length - 4} more items...
                </div>
              )}
            </div>
          </div>
        ) : job.lineCount && job.lineCount > 0 ? (
          <div className="text-sm text-gray-500 italic">
            {job.lineCount} line items (details not loaded)
          </div>
        ) : null}
        
        {/* Mapped Services Indicator */}
        {mappedServices.length > 0 && (
          <div className="pt-2 border-t border-gray-100 mt-2">
            <div className="flex items-center gap-1.5 flex-wrap">
              <Link2 className="w-3.5 h-3.5 text-green-600" />
              <span className="text-xs text-green-700 font-medium">Mapped to:</span>
              {mappedServices.slice(0, 2).map((service, idx) => (
                <span key={idx} className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded">
                  {service}
                </span>
              ))}
              {mappedServices.length > 2 && (
                <span className="text-xs text-green-600">+{mappedServices.length - 2} more</span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
