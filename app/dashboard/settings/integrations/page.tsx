"use client";

import { useState, useEffect } from "react";
import {
  Puzzle,
  CheckCircle,
  XCircle,
  Loader2,
  Settings,
  Key,
  Link2,
  RefreshCw,
  ToggleLeft,
  ToggleRight,
  Info,
  AlertCircle,
  ExternalLink,
  Chrome,
  Hash,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

type IntegrationTab = "carfax" | "autoflow" | "protractor" | "autovitals";

interface IntegrationStatus {
  carfax: { configured: boolean; locationId?: string };
  autoflow: { configured: boolean };
  protractor: { configured: boolean; connectionId?: string };
  autovitals: { configured: boolean; shopName?: string };
}

export default function IntegrationsPage() {
  const [activeTab, setActiveTab] = useState<IntegrationTab>("carfax");
  const [loading, setLoading] = useState(true);
  const [statuses, setStatuses] = useState<IntegrationStatus>({
    carfax: { configured: false },
    autoflow: { configured: false },
    protractor: { configured: false },
    autovitals: { configured: false },
  });

  useEffect(() => {
    fetchAllStatuses();
  }, []);

  async function fetchAllStatuses() {
    try {
      const [carfaxRes, autoflowRes, protractorRes, autovitalsRes] = await Promise.all([
        fetch("/api/settings/carfax").catch(() => null),
        fetch("/api/settings/autoflow").catch(() => null),
        fetch("/api/settings/protractor").catch(() => null),
        fetch("/api/autovitals/settings").catch(() => null),
      ]);

      const carfaxData = carfaxRes?.ok ? await carfaxRes.json() : {};
      const autoflowData = autoflowRes?.ok ? await autoflowRes.json() : {};
      const protractorData = protractorRes?.ok ? await protractorRes.json() : {};
      const autovitalsData = autovitalsRes?.ok ? await autovitalsRes.json() : {};

      setStatuses({
        carfax: { 
          configured: Boolean(carfaxData.locationId), 
          locationId: carfaxData.locationId 
        },
        autoflow: { 
          configured: Boolean(autoflowData.configured || autoflowData.autoflowApiKey) 
        },
        protractor: { 
          configured: Boolean(protractorData.configured), 
          connectionId: protractorData.connectionId 
        },
        autovitals: { 
          configured: Boolean(autovitalsData.isConfigured), 
          shopName: autovitalsData.shopName 
        },
      });
    } catch (err) {
      console.error("Failed to fetch integration statuses:", err);
    } finally {
      setLoading(false);
    }
  }

  const tabs: { id: IntegrationTab; label: string; status: boolean }[] = [
    { id: "carfax", label: "CARFAX", status: statuses.carfax.configured },
    { id: "autoflow", label: "AutoFlow", status: statuses.autoflow.configured },
    { id: "protractor", label: "Protractor", status: statuses.protractor.configured },
    { id: "autovitals", label: "AutoVitals", status: statuses.autovitals.configured },
  ];

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[400px]">
        <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <main className="p-6 max-w-4xl">
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 bg-blue-100 rounded-lg">
          <Puzzle className="w-6 h-6 text-blue-600" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Integrations</h1>
          <p className="text-gray-500">Connect your shop to external services</p>
        </div>
      </div>

      <div className="border-b border-gray-200 mb-6">
        <nav className="flex gap-1">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors flex items-center gap-2 ${
                activeTab === tab.id
                  ? "border-blue-600 text-blue-600"
                  : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
              }`}
            >
              {tab.label}
              {tab.status ? (
                <CheckCircle className="w-4 h-4 text-green-500" />
              ) : (
                <XCircle className="w-4 h-4 text-gray-300" />
              )}
            </button>
          ))}
        </nav>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {activeTab === "carfax" && <CarfaxSection onUpdate={fetchAllStatuses} />}
        {activeTab === "autoflow" && <AutoflowSection onUpdate={fetchAllStatuses} />}
        {activeTab === "protractor" && <ProtractorSection onUpdate={fetchAllStatuses} />}
        {activeTab === "autovitals" && <AutovitalsSection onUpdate={fetchAllStatuses} />}
      </div>
    </main>
  );
}

function CarfaxSection({ onUpdate }: { onUpdate: () => void }) {
  const [locationId, setLocationId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [envConfigured, setEnvConfigured] = useState(false);

  useEffect(() => {
    fetchSettings();
  }, []);

  async function fetchSettings() {
    try {
      const res = await fetch("/api/settings/carfax");
      if (res.ok) {
        const data = await res.json();
        setLocationId(data.locationId || "");
        setEnvConfigured(data.envConfigured !== false);
      }
    } catch (err) {
      console.error("Failed to fetch CARFAX settings:", err);
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setMessage(null);

    try {
      const res = await fetch("/api/settings/carfax", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locationId }),
      });

      if (res.ok) {
        setMessage({ type: "success", text: "CARFAX Location ID saved successfully" });
        onUpdate();
      } else {
        const data = await res.json();
        setMessage({ type: "error", text: data.error || "Failed to save" });
      }
    } catch (err) {
      setMessage({ type: "error", text: "Failed to save settings" });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="p-6 flex justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900 mb-2">CARFAX Integration</h2>
        <p className="text-gray-600">
          Connect to CARFAX to display service history on vehicle pages. The API credentials are 
          configured globally - you just need to enter your shop's Location ID.
        </p>
      </div>

      <div className={`rounded-lg p-4 ${locationId ? 'bg-green-50 border border-green-200' : 'bg-gray-50 border border-gray-200'}`}>
        <div className="flex items-center gap-3">
          {locationId ? (
            <CheckCircle className="w-5 h-5 text-green-600" />
          ) : (
            <AlertCircle className="w-5 h-5 text-gray-400" />
          )}
          <span className={locationId ? 'text-green-800' : 'text-gray-600'}>
            {locationId ? `Connected (Location ID: ${locationId})` : 'Not configured'}
          </span>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Shop Location ID
        </label>
        <input
          type="text"
          value={locationId}
          onChange={(e) => setLocationId(e.target.value)}
          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          placeholder="Enter your CARFAX Location ID"
        />
        <p className="text-xs text-gray-500 mt-1">
          This ID is provided by CARFAX when you set up your account
        </p>
      </div>

      {message && (
        <div className={`flex items-center gap-2 p-3 rounded-lg ${
          message.type === "success" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
        }`}>
          {message.type === "success" ? <CheckCircle className="w-5 h-5" /> : <XCircle className="w-5 h-5" />}
          <span>{message.text}</span>
        </div>
      )}

      <button
        onClick={handleSave}
        disabled={saving}
        className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
      >
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
        Save Location ID
      </button>
    </div>
  );
}

function AutoflowSection({ onUpdate }: { onUpdate: () => void }) {
  const [domain, setDomain] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiPassword, setApiPassword] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    fetchSettings();
  }, []);

  async function fetchSettings() {
    try {
      const res = await fetch("/api/settings/autoflow");
      if (res.ok) {
        const data = await res.json();
        setDomain(data.autoflowDomain || "");
        setApiKey(data.autoflowApiKey || "");
        setApiPassword(data.autoflowApiPassword || "");
      }
    } catch (err) {
      console.error("Failed to fetch AutoFlow settings:", err);
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setMessage(null);

    try {
      const res = await fetch("/api/settings/autoflow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain, apiKey, apiPassword }),
      });

      if (res.ok) {
        setMessage({ type: "success", text: "AutoFlow settings saved successfully" });
        onUpdate();
      } else {
        const data = await res.json();
        setMessage({ type: "error", text: data.error || "Failed to save" });
      }
    } catch (err) {
      setMessage({ type: "error", text: "Failed to save settings" });
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setMessage(null);

    try {
      const res = await fetch("/api/settings/autoflow/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain, apiKey, apiPassword }),
      });

      const data = await res.json();
      if (data.ok) {
        setMessage({ type: "success", text: "Connection successful!" });
      } else {
        setMessage({ type: "error", text: data.error || "Connection failed" });
      }
    } catch (err) {
      setMessage({ type: "error", text: "Connection test failed" });
    } finally {
      setTesting(false);
    }
  }

  if (loading) {
    return (
      <div className="p-6 flex justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    );
  }

  const isConfigured = domain && apiKey;

  return (
    <div className="p-6 space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900 mb-2">AutoFlow Integration</h2>
        <p className="text-gray-600">
          Connect to AutoFlow to sync customer and vehicle data.
        </p>
      </div>

      <div className={`rounded-lg p-4 ${isConfigured ? 'bg-green-50 border border-green-200' : 'bg-gray-50 border border-gray-200'}`}>
        <div className="flex items-center gap-3">
          {isConfigured ? (
            <CheckCircle className="w-5 h-5 text-green-600" />
          ) : (
            <AlertCircle className="w-5 h-5 text-gray-400" />
          )}
          <span className={isConfigured ? 'text-green-800' : 'text-gray-600'}>
            {isConfigured ? 'Connected' : 'Not configured'}
          </span>
        </div>
      </div>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            AutoFlow Domain
          </label>
          <input
            type="text"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            placeholder="e.g., yourshop.autoflow.com"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            API Key
          </label>
          <input
            type="text"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            placeholder="Your AutoFlow API key"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            API Password
          </label>
          <input
            type="password"
            value={apiPassword}
            onChange={(e) => setApiPassword(e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            placeholder="Your AutoFlow API password"
          />
        </div>
      </div>

      {message && (
        <div className={`flex items-center gap-2 p-3 rounded-lg ${
          message.type === "success" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
        }`}>
          {message.type === "success" ? <CheckCircle className="w-5 h-5" /> : <XCircle className="w-5 h-5" />}
          <span>{message.text}</span>
        </div>
      )}

      <div className="flex gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          Save Settings
        </button>
        <button
          onClick={handleTest}
          disabled={testing || !domain || !apiKey}
          className="px-6 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          Test Connection
        </button>
      </div>
    </div>
  );
}

function ProtractorSection({ onUpdate }: { onUpdate: () => void }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [status, setStatus] = useState<{
    configured: boolean;
    connectionId?: string;
    hasApiKey?: boolean;
    updateWorkOrderPackage?: boolean;
    updateWorkOrderLine?: boolean;
  } | null>(null);
  const [syncStats, setSyncStats] = useState<{
    vehicles: number;
    workOrders: number;
    cannedJobs: number;
    lastSync: string | null;
  } | null>(null);
  const [connectionId, setConnectionId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [updatePackage, setUpdatePackage] = useState(false);
  const [updateLine, setUpdateLine] = useState(false);

  useEffect(() => {
    fetchStatus();
  }, []);

  async function fetchStatus() {
    try {
      const res = await fetch("/api/settings/protractor");
      if (res.ok) {
        const data = await res.json();
        setStatus(data);
        setUpdatePackage(data.updateWorkOrderPackage || false);
        setUpdateLine(data.updateWorkOrderLine || false);
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
      const res = await fetch("/api/protractor/sync");
      if (res.ok) {
        const data = await res.json();
        if (data.stats) {
          setSyncStats(data.stats);
        }
      }
    } catch (err) {
      console.error("Failed to fetch sync stats:", err);
    }
  }

  async function handleTest() {
    if (!connectionId || !apiKey) {
      setMessage({ type: "error", text: "Please enter both Connection ID and API Key" });
      return;
    }

    setTesting(true);
    setMessage(null);

    try {
      const res = await fetch("/api/settings/protractor/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId, apiKey }),
      });

      const data = await res.json();
      if (data.ok) {
        setMessage({ type: "success", text: `Connection successful! Found ${data.locations?.length || 0} locations.` });
      } else {
        setMessage({ type: "error", text: data.error || "Connection failed" });
      }
    } catch (err) {
      setMessage({ type: "error", text: "Connection test failed" });
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setMessage(null);

    try {
      const res = await fetch("/api/settings/protractor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          connectionId, 
          apiKey,
          updateWorkOrderPackage: updatePackage,
          updateWorkOrderLine: updateLine,
        }),
      });

      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: "Protractor settings saved successfully" });
        fetchStatus();
        onUpdate();
      } else {
        setMessage({ type: "error", text: data.error || "Failed to save" });
      }
    } catch (err) {
      setMessage({ type: "error", text: "Failed to save settings" });
    } finally {
      setSaving(false);
    }
  }

  async function handleSync() {
    setSyncing(true);
    setMessage(null);

    try {
      const res = await fetch("/api/protractor/sync", {
        method: "POST",
      });

      const data = await res.json();
      if (res.ok && data.ok) {
        setMessage({ 
          type: "success", 
          text: `Synced ${data.vehiclesSynced || 0} vehicles from ${data.workOrdersFound || 0} work orders` 
        });
        fetchSyncStats();
      } else {
        setMessage({ type: "error", text: data.error || "Sync failed" });
      }
    } catch (err) {
      setMessage({ type: "error", text: "Sync failed" });
    } finally {
      setSyncing(false);
    }
  }

  async function handleToggleOption(option: "package" | "line", value: boolean) {
    try {
      const res = await fetch("/api/settings/protractor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          updateWorkOrderPackage: option === "package" ? value : updatePackage,
          updateWorkOrderLine: option === "line" ? value : updateLine,
        }),
      });

      if (res.ok) {
        if (option === "package") setUpdatePackage(value);
        if (option === "line") setUpdateLine(value);
      }
    } catch (err) {
      console.error("Failed to update option:", err);
    }
  }

  if (loading) {
    return (
      <div className="p-6 flex justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900 mb-2">Protractor Integration</h2>
        <p className="text-gray-600">
          Connect to Protractor to sync vehicles, work orders, and add service packages.
        </p>
      </div>

      <div className={`rounded-lg p-4 ${status?.configured ? 'bg-green-50 border border-green-200' : 'bg-gray-50 border border-gray-200'}`}>
        <div className="flex items-center gap-3">
          {status?.configured ? (
            <CheckCircle className="w-5 h-5 text-green-600" />
          ) : (
            <AlertCircle className="w-5 h-5 text-gray-400" />
          )}
          <span className={status?.configured ? 'text-green-800' : 'text-gray-600'}>
            {status?.configured ? 'Connected' : 'Not configured'}
          </span>
        </div>
      </div>

      {!status?.configured && (
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              <Link2 className="w-4 h-4 inline mr-1" />
              Connection ID
            </label>
            <input
              type="text"
              value={connectionId}
              onChange={(e) => setConnectionId(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              placeholder="Your Protractor Connection ID"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              <Key className="w-4 h-4 inline mr-1" />
              API Key
            </label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              placeholder="Your Protractor API Key"
            />
          </div>

          <div className="flex gap-3">
            <button
              onClick={handleTest}
              disabled={testing || !connectionId || !apiKey}
              className="px-6 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              Test Connection
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !connectionId || !apiKey}
              className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              Save & Connect
            </button>
          </div>
        </div>
      )}

      {status?.configured && (
        <div className="space-y-6">
          <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-4">
            <h3 className="font-medium text-gray-900">Work Order Settings</h3>
            <p className="text-sm text-gray-600">
              Enable these options to allow adding service packages to work orders.
            </p>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-700">Update Work Order Package</p>
                  <p className="text-xs text-gray-500">Required for Add to RO feature</p>
                </div>
                <button
                  onClick={() => handleToggleOption("package", !updatePackage)}
                  className="focus:outline-none"
                >
                  {updatePackage ? (
                    <ToggleRight className="w-10 h-6 text-blue-600" />
                  ) : (
                    <ToggleLeft className="w-10 h-6 text-gray-400" />
                  )}
                </button>
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-700">Update Work Order Line</p>
                  <p className="text-xs text-gray-500">Required for line items in service packages</p>
                </div>
                <button
                  onClick={() => handleToggleOption("line", !updateLine)}
                  className="focus:outline-none"
                >
                  {updateLine ? (
                    <ToggleRight className="w-10 h-6 text-blue-600" />
                  ) : (
                    <ToggleLeft className="w-10 h-6 text-gray-400" />
                  )}
                </button>
              </div>
            </div>
          </div>

          <div className="bg-white border border-gray-200 rounded-lg p-4">
            <h3 className="font-medium text-gray-900 mb-3">Sync Data</h3>
            {syncStats && (
              <div className="grid grid-cols-3 gap-4 mb-4">
                <div className="text-center p-3 bg-gray-50 rounded-lg">
                  <p className="text-2xl font-semibold text-gray-900">{syncStats.vehicles}</p>
                  <p className="text-xs text-gray-500">Vehicles</p>
                </div>
                <div className="text-center p-3 bg-gray-50 rounded-lg">
                  <p className="text-2xl font-semibold text-gray-900">{syncStats.workOrders}</p>
                  <p className="text-xs text-gray-500">Work Orders</p>
                </div>
                <div className="text-center p-3 bg-gray-50 rounded-lg">
                  <p className="text-2xl font-semibold text-gray-900">{syncStats.cannedJobs}</p>
                  <p className="text-xs text-gray-500">Canned Jobs</p>
                </div>
              </div>
            )}
            {syncStats?.lastSync && (
              <p className="text-xs text-gray-500 mb-3">
                Last synced: {new Date(syncStats.lastSync).toLocaleString()}
              </p>
            )}
            <button
              onClick={handleSync}
              disabled={syncing}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {syncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              {syncing ? "Syncing..." : "Sync Now"}
            </button>
          </div>
        </div>
      )}

      {message && (
        <div className={`flex items-center gap-2 p-3 rounded-lg ${
          message.type === "success" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
        }`}>
          {message.type === "success" ? <CheckCircle className="w-5 h-5" /> : <XCircle className="w-5 h-5" />}
          <span>{message.text}</span>
        </div>
      )}
    </div>
  );
}

function AutovitalsSection({ onUpdate }: { onUpdate: () => void }) {
  const [loading, setLoading] = useState(true);
  const [isConfigured, setIsConfigured] = useState(false);
  const [shopName, setShopName] = useState("");

  useEffect(() => {
    fetchSettings();
  }, []);

  async function fetchSettings() {
    try {
      const res = await fetch("/api/autovitals/settings");
      if (res.ok) {
        const data = await res.json();
        setIsConfigured(data.isConfigured || false);
        setShopName(data.shopName || "");
      }
    } catch (err) {
      console.error("Failed to fetch AutoVitals settings:", err);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="p-6 flex justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900 mb-2">AutoVitals Integration</h2>
        <p className="text-gray-600">
          Import digital vehicle inspection (DVI) data from AutoVitals.
        </p>
      </div>

      <div className={`rounded-lg p-4 ${isConfigured ? 'bg-green-50 border border-green-200' : 'bg-gray-50 border border-gray-200'}`}>
        <div className="flex items-center gap-3">
          {isConfigured ? (
            <CheckCircle className="w-5 h-5 text-green-600" />
          ) : (
            <AlertCircle className="w-5 h-5 text-gray-400" />
          )}
          <span className={isConfigured ? 'text-green-800' : 'text-gray-600'}>
            {isConfigured ? `Connected${shopName ? ` to ${shopName}` : ''}` : 'Not configured'}
          </span>
        </div>
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <div className="flex gap-3">
          <Chrome className="w-6 h-6 text-blue-600 flex-shrink-0" />
          <div>
            <h3 className="font-medium text-blue-900 mb-2">Chrome Extension Required</h3>
            <p className="text-sm text-blue-800 mb-3">
              AutoVitals integration requires our Chrome extension to securely sync your inspection data. 
              The extension connects to your AutoVitals account and automatically imports DVI results.
            </p>
            <a
              href="#"
              className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium"
            >
              <ExternalLink className="w-4 h-4" />
              Install Chrome Extension
            </a>
          </div>
        </div>
      </div>

      <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
        <h3 className="font-medium text-gray-900 mb-3">How it works</h3>
        <ol className="space-y-2 text-sm text-gray-600">
          <li className="flex items-start gap-2">
            <span className="flex-shrink-0 w-5 h-5 rounded-full bg-gray-200 flex items-center justify-center text-xs font-medium">1</span>
            Install the MOS Chrome extension from the Chrome Web Store
          </li>
          <li className="flex items-start gap-2">
            <span className="flex-shrink-0 w-5 h-5 rounded-full bg-gray-200 flex items-center justify-center text-xs font-medium">2</span>
            Log into AutoVitals in your browser
          </li>
          <li className="flex items-start gap-2">
            <span className="flex-shrink-0 w-5 h-5 rounded-full bg-gray-200 flex items-center justify-center text-xs font-medium">3</span>
            Click the extension icon and authorize the connection
          </li>
          <li className="flex items-start gap-2">
            <span className="flex-shrink-0 w-5 h-5 rounded-full bg-gray-200 flex items-center justify-center text-xs font-medium">4</span>
            DVI data will automatically sync to MOS
          </li>
        </ol>
      </div>

      {isConfigured && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <p className="text-sm text-gray-600">
            Your AutoVitals connection is active. DVI data is being synced automatically via the Chrome extension.
          </p>
        </div>
      )}
    </div>
  );
}
