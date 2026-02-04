"use client";

import { useState, useEffect } from "react";
import {
  Settings,
  CheckCircle2,
  XCircle,
  Loader2,
  Link2,
  Key,
  AlertCircle,
  RefreshCw,
  ToggleLeft,
  ToggleRight,
  Info,
} from "lucide-react";

export default function ProtractorSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [refreshingCannedJobs, setRefreshingCannedJobs] = useState(false);
  const [status, setStatus] = useState<{
    configured: boolean;
    connectionId?: string;
    connectionIdShort?: string;
    apiKey?: string;
    apiKeyShort?: string;
    hasApiKey?: boolean;
    updateWorkOrderPackage?: boolean;
    updateWorkOrderLine?: boolean;
    webhookToken?: string;
  } | null>(null);
  const [syncStats, setSyncStats] = useState<{
    vehicles: number;
    workOrders: number;
    deferredWorkItems: number;
    cannedJobs: number;
    lastSync: string | null;
  } | null>(null);
  const [cannedJobs, setCannedJobs] = useState<Array<{
    id: string;
    title: string;
    description: string;
    chapter: string;
    code: string;
  }>>([]);
  const [connectionId, setConnectionId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; locations?: any[]; error?: string } | null>(null);

  useEffect(() => {
    fetchStatus();
  }, []);

  async function fetchStatus() {
    try {
      const res = await fetch("/api/settings/protractor", { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setStatus(data);
        
        if (data.configured) {
          fetchSyncStats();
        }
      }
    } catch (err) {
      console.error("Failed to fetch Protractor status:", err);
    } finally {
      setLoading(false);
    }
  }

  async function fetchSyncStats() {
    try {
      const res = await fetch("/api/protractor/sync", { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        if (data.stats) {
          setSyncStats(data.stats);
        }
        if (data.cannedJobs) {
          setCannedJobs(data.cannedJobs);
        }
      }
    } catch (err) {
      console.error("Failed to fetch sync stats:", err);
    }
  }

  async function handleSync() {
    setSyncing(true);
    setMessage(null);

    try {
      const res = await fetch("/api/protractor/sync", {
        method: "POST",
        credentials: "include",
      });

      const data = await res.json();

      if (res.ok && data.ok) {
        setMessage({ 
          type: "success", 
          text: `Synced ${data.vehiclesSynced} vehicles from ${data.workOrdersFound} work orders` 
        });
        fetchSyncStats();
      } else {
        setMessage({ type: "error", text: data.error || "Sync failed" });
      }
    } catch (err: any) {
      setMessage({ type: "error", text: err.message || "Sync failed" });
    } finally {
      setSyncing(false);
    }
  }

  async function handleRefreshCannedJobs() {
    setRefreshingCannedJobs(true);
    setMessage(null);

    try {
      const res = await fetch("/api/protractor/canned-jobs?refresh=true", {
        credentials: "include",
      });

      const data = await res.json();

      if (res.ok && data.cannedJobs) {
        setCannedJobs(data.cannedJobs);
        setSyncStats(prev => prev ? { ...prev, cannedJobs: data.cannedJobs.length } : null);
        setMessage({ 
          type: "success", 
          text: `Refreshed ${data.cannedJobs.length} service packages from Protractor` 
        });
      } else {
        setMessage({ type: "error", text: data.error || "Failed to refresh service packages" });
      }
    } catch (err: any) {
      setMessage({ type: "error", text: err.message || "Refresh failed" });
    } finally {
      setRefreshingCannedJobs(false);
    }
  }

  async function handleTest() {
    if (!connectionId || !apiKey) {
      setMessage({ type: "error", text: "Please enter both Connection ID and API Key" });
      return;
    }

    setTesting(true);
    setMessage(null);
    setTestResult(null);

    try {
      const res = await fetch("/api/settings/protractor/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ connectionId, apiKey }),
      });

      const data = await res.json();
      setTestResult(data);

      if (data.ok) {
        setMessage({ type: "success", text: "Connection test successful!" });
      } else {
        setMessage({ type: "error", text: data.error || "Connection test failed" });
      }
    } catch (err: any) {
      setMessage({ type: "error", text: err.message || "Test failed" });
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    if (!connectionId || !apiKey) {
      setMessage({ type: "error", text: "Please enter both Connection ID and API Key" });
      return;
    }

    setSaving(true);
    setMessage(null);

    try {
      const res = await fetch("/api/settings/protractor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ connectionId, apiKey }),
      });

      const data = await res.json();

      if (res.ok && data.ok) {
        setMessage({ type: "success", text: "Protractor connected successfully!" });
        setConnectionId("");
        setApiKey("");
        fetchStatus();
      } else {
        setMessage({ type: "error", text: data.error || "Failed to save settings" });
      }
    } catch (err: any) {
      setMessage({ type: "error", text: err.message || "Save failed" });
    } finally {
      setSaving(false);
    }
  }

  async function handleDisconnect() {
    if (!confirm("Are you sure you want to disconnect Protractor?")) return;

    setSaving(true);
    setMessage(null);

    try {
      const res = await fetch("/api/settings/protractor", {
        method: "DELETE",
        credentials: "include",
      });

      const data = await res.json();

      if (res.ok && data.ok) {
        setMessage({ type: "success", text: "Protractor disconnected" });
        fetchStatus();
      } else {
        setMessage({ type: "error", text: data.error || "Failed to disconnect" });
      }
    } catch (err: any) {
      setMessage({ type: "error", text: err.message || "Disconnect failed" });
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleSetting(setting: "updateWorkOrderPackage" | "updateWorkOrderLine", value: boolean) {
    try {
      const res = await fetch("/api/settings/protractor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ [setting]: value }),
      });

      if (res.ok) {
        setStatus((prev) => prev ? { ...prev, [setting]: value } : null);
      }
    } catch (err) {
      console.error("Failed to update setting:", err);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto p-6">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <Settings className="w-6 h-6" />
          Protractor Integration
        </h1>
        <p className="mt-2 text-gray-600">
          Connect to Protractor to sync vehicles, work orders, and service history.
        </p>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
        <div className="p-6 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Connection Status</h2>
          <div className="mt-4 flex items-center gap-3">
            {status?.configured ? (
              <>
                <CheckCircle2 className="w-5 h-5 text-green-600" />
                <span className="text-green-700 font-medium">Connected</span>
              </>
            ) : (
              <>
                <XCircle className="w-5 h-5 text-gray-400" />
                <span className="text-gray-600">Not connected</span>
              </>
            )}
          </div>
          
          {status?.configured && (
            <div className="mt-4 bg-gray-50 rounded-lg p-4 space-y-3">
              <div>
                <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">Connection ID</label>
                <div className="mt-1 font-mono text-sm text-gray-800 bg-white border border-gray-200 rounded px-3 py-2 select-all">
                  {status.connectionId}
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">API Key</label>
                <div className="mt-1 font-mono text-sm text-gray-800 bg-white border border-gray-200 rounded px-3 py-2 select-all">
                  {status.apiKey}
                </div>
              </div>
              {status.webhookToken && (
                <div>
                  <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">Webhook Token</label>
                  <div className="mt-1 font-mono text-sm text-gray-800 bg-white border border-gray-200 rounded px-3 py-2 select-all">
                    {status.webhookToken}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {status?.configured ? (
          <div className="p-6 space-y-6">
            <div className="bg-gray-50 rounded-lg p-4">
              <h3 className="font-medium text-gray-900 mb-3">Sync Status</h3>
              {syncStats ? (
                <div className="grid grid-cols-4 gap-4 text-center">
                  <div>
                    <div className="text-2xl font-bold text-blue-600">{syncStats.vehicles}</div>
                    <div className="text-sm text-gray-500">Vehicles</div>
                  </div>
                  <div>
                    <div className="text-2xl font-bold text-blue-600">{syncStats.workOrders}</div>
                    <div className="text-sm text-gray-500">Work Orders</div>
                  </div>
                  <div>
                    <div className="text-2xl font-bold text-blue-600">{syncStats.deferredWorkItems}</div>
                    <div className="text-sm text-gray-500">Deferred Items</div>
                  </div>
                  <div>
                    <div className="text-2xl font-bold text-blue-600">{syncStats.cannedJobs || 0}</div>
                    <div className="text-sm text-gray-500">Service Packages</div>
                  </div>
                </div>
              ) : (
                <p className="text-gray-500 text-sm">No sync data yet</p>
              )}
              {syncStats?.lastSync && (
                <p className="text-xs text-gray-400 mt-3 text-center">
                  Last synced: {new Date(syncStats.lastSync).toLocaleString()}
                </p>
              )}
            </div>

            <div className="flex items-center justify-between">
              <div>
                <p className="text-gray-600 text-sm">
                  Click "Sync Now" to import all currently open work orders and vehicles from Protractor.
                </p>
              </div>
              <button
                onClick={handleSync}
                disabled={syncing}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                {syncing ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Syncing...
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-4 h-4" />
                    Sync Now
                  </>
                )}
              </button>
            </div>

            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
              <div className="flex items-start gap-3 mb-4">
                <AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
                <div>
                  <h3 className="font-medium text-amber-900">Required for Service Package Insertion</h3>
                  <p className="text-sm text-amber-800 mt-1">
                    These parameters must also be set in your Protractor Integration settings. 
                    Go to Protractor → Actions → Add, and add these parameters with value "Yes" (case-sensitive).
                  </p>
                </div>
              </div>
              
              <div className="space-y-3">
                <div className="flex items-center justify-between p-3 bg-white rounded border border-amber-100">
                  <div>
                    <p className="font-medium text-gray-900 text-sm">UpdateWorkOrderPackage</p>
                    <p className="text-xs text-gray-500">Enables adding service packages to work orders</p>
                  </div>
                  <button
                    onClick={() => handleToggleSetting("updateWorkOrderPackage", !status?.updateWorkOrderPackage)}
                    className="flex items-center gap-2"
                  >
                    {status?.updateWorkOrderPackage ? (
                      <ToggleRight className="w-8 h-8 text-green-600" />
                    ) : (
                      <ToggleLeft className="w-8 h-8 text-gray-400" />
                    )}
                    <span className={`text-sm font-medium ${status?.updateWorkOrderPackage ? "text-green-600" : "text-gray-500"}`}>
                      {status?.updateWorkOrderPackage ? "Enabled" : "Disabled"}
                    </span>
                  </button>
                </div>
                
                <div className="flex items-center justify-between p-3 bg-white rounded border border-amber-100">
                  <div>
                    <p className="font-medium text-gray-900 text-sm">UpdateWorkOrderLine</p>
                    <p className="text-xs text-gray-500">Enables adding line items to service packages</p>
                  </div>
                  <button
                    onClick={() => handleToggleSetting("updateWorkOrderLine", !status?.updateWorkOrderLine)}
                    className="flex items-center gap-2"
                  >
                    {status?.updateWorkOrderLine ? (
                      <ToggleRight className="w-8 h-8 text-green-600" />
                    ) : (
                      <ToggleLeft className="w-8 h-8 text-gray-400" />
                    )}
                    <span className={`text-sm font-medium ${status?.updateWorkOrderLine ? "text-green-600" : "text-gray-500"}`}>
                      {status?.updateWorkOrderLine ? "Enabled" : "Disabled"}
                    </span>
                  </button>
                </div>
              </div>

              {(!status?.updateWorkOrderPackage || !status?.updateWorkOrderLine) && (
                <div className="mt-3 p-2 bg-red-50 border border-red-200 rounded text-sm text-red-700">
                  <strong>Warning:</strong> Both parameters must be enabled to add service packages via API.
                </div>
              )}
            </div>

            <div className="bg-gray-50 rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-medium text-gray-900">Available Service Packages</h3>
                <button
                  onClick={handleRefreshCannedJobs}
                  disabled={refreshingCannedJobs}
                  className="px-3 py-1.5 bg-white text-gray-700 text-sm rounded-lg border border-gray-300 hover:bg-gray-50 transition-colors disabled:opacity-50 flex items-center gap-2"
                >
                  {refreshingCannedJobs ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Refreshing...
                    </>
                  ) : (
                    <>
                      <RefreshCw className="w-3.5 h-3.5" />
                      Refresh
                    </>
                  )}
                </button>
              </div>
              <p className="text-sm text-gray-500 mb-3">
                These service packages can be added to work orders from the vehicle plan page.
              </p>
              {cannedJobs.length > 0 ? (
                <div className="max-h-64 overflow-y-auto border border-gray-200 rounded bg-white">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-100 sticky top-0">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium text-gray-700">Code</th>
                        <th className="px-3 py-2 text-left font-medium text-gray-700">Title</th>
                        <th className="px-3 py-2 text-left font-medium text-gray-700">Chapter</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {cannedJobs.map((job) => (
                        <tr key={job.id} className="hover:bg-gray-50">
                          <td className="px-3 py-2 font-mono text-xs text-gray-600">{job.code}</td>
                          <td className="px-3 py-2 text-gray-900">{job.title}</td>
                          <td className="px-3 py-2 text-gray-500">{job.chapter}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-sm text-gray-400 italic">No service packages loaded. Click Refresh to load from Protractor.</p>
              )}
            </div>

            {message && (
              <div
                className={`p-4 rounded-lg ${
                  message.type === "success"
                    ? "bg-green-50 text-green-800 border border-green-200"
                    : "bg-red-50 text-red-800 border border-red-200"
                }`}
              >
                {message.text}
              </div>
            )}

            <div className="pt-4 border-t border-gray-200">
              <button
                onClick={handleDisconnect}
                disabled={saving}
                className="px-4 py-2 bg-red-50 text-red-700 rounded-lg border border-red-200 hover:bg-red-100 transition-colors disabled:opacity-50"
              >
                {saving ? (
                  <span className="flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Disconnecting...
                  </span>
                ) : (
                  "Disconnect Protractor"
                )}
              </button>
            </div>
          </div>
        ) : (
          <div className="p-6 space-y-6">
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <div className="flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-blue-600 mt-0.5" />
                <div>
                  <h3 className="font-medium text-blue-900">How to get your credentials</h3>
                  <p className="text-sm text-blue-800 mt-1">
                    Contact your Protractor administrator or support to obtain your
                    Connection ID and API Key. These are unique to your shop location.
                  </p>
                </div>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                <span className="flex items-center gap-2">
                  <Link2 className="w-4 h-4" />
                  Connection ID
                </span>
              </label>
              <input
                type="text"
                value={connectionId}
                onChange={(e) => setConnectionId(e.target.value)}
                placeholder="e.g., 5fecbc20-0f0e-4a7c-bf41-040e11047e56"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                <span className="flex items-center gap-2">
                  <Key className="w-4 h-4" />
                  API Key
                </span>
              </label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="e.g., 2de51c4f-d0f0-4b9f-abeb-95225e87da70"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>

            {message && (
              <div
                className={`p-4 rounded-lg ${
                  message.type === "success"
                    ? "bg-green-50 text-green-800 border border-green-200"
                    : "bg-red-50 text-red-800 border border-red-200"
                }`}
              >
                {message.text}
              </div>
            )}

            {testResult?.ok && testResult.locations && testResult.locations.length > 0 && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                <h4 className="font-medium text-green-900 mb-2">Locations Found:</h4>
                <ul className="text-sm text-green-800 space-y-1">
                  {testResult.locations.map((loc: any, i: number) => (
                    <li key={i}>
                      {loc.Name || loc.ID || `Location ${i + 1}`}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={handleTest}
                disabled={testing || saving || !connectionId || !apiKey}
                className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg border border-gray-300 hover:bg-gray-200 transition-colors disabled:opacity-50"
              >
                {testing ? (
                  <span className="flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Testing...
                  </span>
                ) : (
                  "Test Connection"
                )}
              </button>

              <button
                onClick={handleSave}
                disabled={saving || testing || !connectionId || !apiKey}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
              >
                {saving ? (
                  <span className="flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Connecting...
                  </span>
                ) : (
                  "Connect Protractor"
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
