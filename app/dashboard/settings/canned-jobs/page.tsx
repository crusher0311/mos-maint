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
  [serviceKey: string]: string;
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
        setMappings(data.mappings || {});
        setOriginalMappings(data.mappings || {});
      }
    } catch (err) {
      console.error("Failed to fetch mappings:", err);
    }
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

  function handleMappingChange(serviceKey: string, cannedJobId: string) {
    setMappings((prev) => {
      const updated = { ...prev };
      if (cannedJobId) {
        updated[serviceKey] = cannedJobId;
      } else {
        delete updated[serviceKey];
      }
      return updated;
    });
  }

  const hasChanges = JSON.stringify(mappings) !== JSON.stringify(originalMappings);
  const mappedCount = Object.keys(mappings).length;

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
          Map maintenance recommendations to Protractor canned jobs. When a recommendation appears
          on the Plan page, advisors can add the mapped canned job to the RO with one click.
        </p>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
        <div className="p-4 border-b border-gray-200 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-600">
              {cannedJobs.length} canned jobs available
            </span>
            {mappedCount > 0 && (
              <span className="px-2 py-1 bg-green-100 text-green-800 text-xs font-medium rounded-full">
                {mappedCount} mapped
              </span>
            )}
          </div>
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

        <div className="divide-y divide-gray-100">
          {SERVICE_KEYS.map(({ key, name }) => {
            const selectedJobId = mappings[key];
            const selectedJob = cannedJobs.find((j) => j.id === selectedJobId);

            return (
              <div key={key} className="p-4 flex items-center gap-4">
                <div className="w-48 flex-shrink-0">
                  <span className="font-medium text-gray-900">{name}</span>
                </div>
                <div className="flex-1">
                  <select
                    value={selectedJobId || ""}
                    onChange={(e) => handleMappingChange(key, e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
                  >
                    <option value="">-- No canned job --</option>
                    {cannedJobs.map((job) => (
                      <option key={job.id} value={job.id}>
                        {job.title}
                        {job.code ? ` (${job.code})` : ""}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="w-6">
                  {selectedJob ? (
                    <CheckCircle2 className="w-5 h-5 text-green-600" />
                  ) : (
                    <XCircle className="w-5 h-5 text-gray-300" />
                  )}
                </div>
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
          <li>Select a canned job for each maintenance service type</li>
          <li>When viewing a vehicle&apos;s Plan page, recommendations with mapped canned jobs will show an &quot;Add to RO&quot; button</li>
          <li>Clicking &quot;Add to RO&quot; will add the canned job to the vehicle&apos;s open work order in Protractor</li>
        </ul>
      </div>
    </div>
  );
}
