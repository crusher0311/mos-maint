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
  Trash2,
  Download,
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

      <DevToolsSection />
    </main>
  );
}

function DevToolsSection() {
  const [clearing, setClearing] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [isDevMode, setIsDevMode] = useState(false);

  useEffect(() => {
    setIsDevMode(process.env.NODE_ENV !== "production");
  }, []);

  async function handleClearVehicles() {
    if (!confirm("Are you sure you want to clear ALL vehicles, plans, and customers? This cannot be undone.")) {
      return;
    }
    
    setClearing(true);
    setMessage(null);

    try {
      const res = await fetch("/api/dev/clear-vehicles", {
        method: "DELETE",
      });

      const data = await res.json();
      if (res.ok) {
        setMessage({ 
          type: "success", 
          text: `Cleared ${data.deleted.vehicles} vehicles, ${data.deleted.plans} plans, and ${data.deleted.customers} customers` 
        });
      } else {
        setMessage({ type: "error", text: data.error || "Failed to clear data" });
      }
    } catch (err) {
      setMessage({ type: "error", text: "Failed to clear data" });
    } finally {
      setClearing(false);
    }
  }

  if (!isDevMode) {
    return null;
  }

  return (
    <div className="mt-8 bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-2">Developer Tools</h2>
        <p className="text-gray-600 mb-4">
          Tools for testing and development. Use with caution.
        </p>

        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <h3 className="font-medium text-red-800 mb-2">Clear Vehicle Data</h3>
          <p className="text-sm text-red-700 mb-4">
            Delete all vehicles, plans, and customers for this shop. This is useful for testing different integration imports. This action cannot be undone.
          </p>
          <button
            onClick={handleClearVehicles}
            disabled={clearing}
            className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {clearing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
            {clearing ? "Clearing..." : "Clear All Vehicles"}
          </button>
          
          {message && (
            <div className={`mt-4 flex items-center gap-2 p-3 rounded-lg ${
              message.type === "success" ? "bg-green-50 text-green-700" : "bg-red-100 text-red-800"
            }`}>
              {message.type === "success" ? <CheckCircle className="w-5 h-5" /> : <XCircle className="w-5 h-5" />}
              <span>{message.text}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CarfaxSection({ onUpdate }: { onUpdate: () => void }) {
  const [locationId, setLocationId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
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

  async function handleDisconnect() {
    if (!confirm("Are you sure you want to disconnect CARFAX?")) return;
    
    setDisconnecting(true);
    setMessage(null);

    try {
      const res = await fetch("/api/settings/carfax", {
        method: "DELETE",
      });

      if (res.ok) {
        setMessage({ type: "success", text: "CARFAX disconnected successfully" });
        setLocationId("");
        onUpdate();
      } else {
        setMessage({ type: "error", text: "Failed to disconnect" });
      }
    } catch (err) {
      setMessage({ type: "error", text: "Failed to disconnect" });
    } finally {
      setDisconnecting(false);
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

      <div className="flex gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          Save Location ID
        </button>
        {locationId && (
          <button
            onClick={handleDisconnect}
            disabled={disconnecting}
            className="px-6 py-2 bg-red-100 text-red-700 rounded-lg hover:bg-red-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {disconnecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
            Disconnect
          </button>
        )}
      </div>
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
  const [disconnecting, setDisconnecting] = useState(false);
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

  async function handleDisconnect() {
    if (!confirm("Are you sure you want to disconnect AutoFlow?")) return;
    
    setDisconnecting(true);
    setMessage(null);

    try {
      const res = await fetch("/api/settings/autoflow", {
        method: "DELETE",
      });

      if (res.ok) {
        setMessage({ type: "success", text: "AutoFlow disconnected successfully" });
        setDomain("");
        setApiKey("");
        setApiPassword("");
        onUpdate();
      } else {
        setMessage({ type: "error", text: "Failed to disconnect" });
      }
    } catch (err) {
      setMessage({ type: "error", text: "Failed to disconnect" });
    } finally {
      setDisconnecting(false);
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

      <div className="flex gap-3 flex-wrap">
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
        {isConfigured && (
          <button
            onClick={handleDisconnect}
            disabled={disconnecting}
            className="px-6 py-2 bg-red-100 text-red-700 rounded-lg hover:bg-red-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {disconnecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
            Disconnect
          </button>
        )}
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
  const [disconnecting, setDisconnecting] = useState(false);

  useEffect(() => {
    fetchStatus();
  }, []);

  async function fetchStatus() {
    try {
      const res = await fetch("/api/settings/protractor");
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
        body: JSON.stringify({ connectionId, apiKey }),
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

  async function handleDisconnect() {
    if (!confirm("Are you sure you want to disconnect Protractor? This will remove your credentials.")) {
      return;
    }
    
    setDisconnecting(true);
    setMessage(null);

    try {
      const res = await fetch("/api/settings/protractor", {
        method: "DELETE",
      });

      if (res.ok) {
        setMessage({ type: "success", text: "Protractor disconnected successfully" });
        setStatus(null);
        setSyncStats(null);
        setConnectionId("");
        setApiKey("");
        fetchStatus();
        onUpdate();
      } else {
        const data = await res.json();
        setMessage({ type: "error", text: data.error || "Failed to disconnect" });
      }
    } catch (err) {
      setMessage({ type: "error", text: "Failed to disconnect" });
    } finally {
      setDisconnecting(false);
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

          <div className="bg-white border border-gray-200 rounded-lg p-4">
            <h3 className="font-medium text-gray-900 mb-2">Canned Job Mappings</h3>
            <p className="text-sm text-gray-600 mb-4">
              Map maintenance recommendations to Protractor canned jobs for one-click "Add to RO" functionality.
            </p>
            <a
              href="/dashboard/settings/canned-jobs"
              className="inline-flex items-center gap-2 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 text-sm font-medium"
            >
              <Settings className="w-4 h-4" />
              Manage Canned Job Mappings
            </a>
          </div>

          <div className="bg-white border border-red-200 rounded-lg p-4">
            <h3 className="font-medium text-gray-900 mb-2">Disconnect Integration</h3>
            <p className="text-sm text-gray-600 mb-4">
              Remove Protractor connection. This will not delete any synced data.
            </p>
            <button
              onClick={handleDisconnect}
              disabled={disconnecting}
              className="px-4 py-2 bg-red-100 text-red-700 rounded-lg hover:bg-red-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 text-sm font-medium"
            >
              {disconnecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
              Disconnect Protractor
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
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [bulkSyncing, setBulkSyncing] = useState(false);
  const [bulkSyncStats, setBulkSyncStats] = useState<any>(null);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

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
        if (data.hasApiKey) {
          setApiKey("configured");
        }
      }
    } catch (err) {
      console.error("Failed to fetch AutoVitals settings:", err);
    } finally {
      setLoading(false);
    }
  }

  async function handleGenerateKey() {
    setGenerating(true);
    setMessage(null);
    
    try {
      const res = await fetch("/api/autovitals/extension/generate-key", {
        method: "POST",
      });
      
      const data = await res.json();
      if (res.ok) {
        setApiKey(data.apiKey);
        setShowApiKey(true);
        setMessage({ type: "success", text: "API key generated! Copy it now - it won't be shown again." });
        onUpdate();
      } else {
        setMessage({ type: "error", text: data.error || "Failed to generate API key" });
      }
    } catch (err) {
      setMessage({ type: "error", text: "Failed to generate API key" });
    } finally {
      setGenerating(false);
    }
  }

  async function handleRevokeKey() {
    if (!confirm("Are you sure you want to revoke this API key? The Chrome extension will stop working.")) {
      return;
    }
    
    try {
      const res = await fetch("/api/autovitals/extension/generate-key", {
        method: "DELETE",
      });
      
      if (res.ok) {
        setApiKey(null);
        setIsConfigured(false);
        setMessage({ type: "success", text: "API key revoked" });
        onUpdate();
      }
    } catch (err) {
      setMessage({ type: "error", text: "Failed to revoke API key" });
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
    setMessage({ type: "success", text: "Copied to clipboard!" });
  }

  async function handleBulkSync() {
    setBulkSyncing(true);
    setMessage(null);
    setBulkSyncStats(null);

    try {
      const res = await fetch("/api/autovitals/bulk-sync", {
        method: "POST",
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Bulk sync failed");
      }

      setBulkSyncStats(data.stats);
      setMessage({ 
        type: "success", 
        text: data.message || `Synced ${data.stats?.vehiclesSynced || 0} vehicles` 
      });
    } catch (err) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : "Bulk sync failed" });
    } finally {
      setBulkSyncing(false);
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

      {isConfigured && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h3 className="font-medium text-gray-900 mb-2">Import Vehicles from AutoVitals</h3>
          <p className="text-sm text-gray-600 mb-4">
            Import all vehicles from AutoVitals into MOS. This populates the Chrome extension sidebar 
            with data for any vehicle you view.
          </p>
          
          <button
            onClick={handleBulkSync}
            disabled={bulkSyncing}
            className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {bulkSyncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            {bulkSyncing ? "Importing..." : "Import All Vehicles"}
          </button>

          {bulkSyncStats && (
            <div className="mt-4 p-3 bg-gray-50 rounded-lg text-sm">
              <p className="font-medium text-gray-900 mb-2">Import Results:</p>
              <ul className="space-y-1 text-gray-600">
                <li>Appointments processed: {bulkSyncStats.appointments}</li>
                <li>Vehicles synced: {bulkSyncStats.vehiclesSynced}</li>
                <li>New vehicles imported: {bulkSyncStats.vehiclesImported}</li>
                <li>Inspections synced: {bulkSyncStats.inspectionsSynced}</li>
              </ul>
            </div>
          )}
        </div>
      )}

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

      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <h3 className="font-medium text-gray-900 mb-3">Step 1: Generate API Key</h3>
        <p className="text-sm text-gray-600 mb-4">
          Generate an API key that the Chrome extension will use to connect to your MOS account.
        </p>
        
        {apiKey && showApiKey ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={apiKey}
                readOnly
                className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg font-mono text-sm"
              />
              <button
                onClick={() => copyToClipboard(apiKey)}
                className="px-3 py-2 bg-blue-100 text-blue-700 rounded-lg hover:bg-blue-200 text-sm"
              >
                Copy
              </button>
            </div>
            <p className="text-xs text-amber-600">
              Save this key now! It won't be shown again after you leave this page.
            </p>
          </div>
        ) : apiKey ? (
          <div className="flex items-center gap-3">
            <span className="text-sm text-green-600">API key is configured</span>
            <button
              onClick={handleRevokeKey}
              className="text-sm text-red-600 hover:text-red-700"
            >
              Revoke Key
            </button>
          </div>
        ) : (
          <button
            onClick={handleGenerateKey}
            disabled={generating}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2 text-sm"
          >
            {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Key className="w-4 h-4" />}
            Generate API Key
          </button>
        )}
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <div className="flex gap-3">
          <Chrome className="w-6 h-6 text-blue-600 flex-shrink-0" />
          <div>
            <h3 className="font-medium text-blue-900 mb-2">Step 2: Install Chrome Extension</h3>
            <p className="text-sm text-blue-800 mb-3">
              Download and install the extension in Chrome to sync inspection data from AutoVitals.
            </p>
            <a
              href="/api/autovitals/extension/download"
              className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium mb-3"
            >
              <Download className="w-4 h-4" />
              Download Extension
            </a>
            <div className="bg-blue-100 rounded-lg p-3 mt-3">
              <p className="text-xs text-blue-800 font-medium mb-2">Installation steps:</p>
              <ol className="text-xs text-blue-700 space-y-1 list-decimal list-inside">
                <li>Extract the downloaded ZIP file to a permanent location</li>
                <li>Open Chrome and go to chrome://extensions</li>
                <li>Enable "Developer mode" (toggle in top right)</li>
                <li>Click "Load unpacked" and select the extracted folder</li>
              </ol>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
        <h3 className="font-medium text-gray-900 mb-3">Step 3: Connect the Extension</h3>
        <ol className="space-y-2 text-sm text-gray-600">
          <li className="flex items-start gap-2">
            <span className="flex-shrink-0 w-5 h-5 rounded-full bg-gray-200 flex items-center justify-center text-xs font-medium">1</span>
            Click the MOS AutoVitals extension icon in Chrome
          </li>
          <li className="flex items-start gap-2">
            <span className="flex-shrink-0 w-5 h-5 rounded-full bg-gray-200 flex items-center justify-center text-xs font-medium">2</span>
            Enter your MOS server URL (this site's URL)
          </li>
          <li className="flex items-start gap-2">
            <span className="flex-shrink-0 w-5 h-5 rounded-full bg-gray-200 flex items-center justify-center text-xs font-medium">3</span>
            Paste the API key you generated above
          </li>
          <li className="flex items-start gap-2">
            <span className="flex-shrink-0 w-5 h-5 rounded-full bg-gray-200 flex items-center justify-center text-xs font-medium">4</span>
            Navigate to AutoVitals - DVI data will sync automatically
          </li>
        </ol>
      </div>

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
