"use client";

import { useState, useEffect } from "react";
import {
  Puzzle,
  CheckCircle,
  XCircle,
  Loader2,
  AlertCircle,
  Trash2,
  Car,
  Wrench,
  ClipboardCheck,
} from "lucide-react";

type ShopManagementChoice = "protractor" | "tekmetric" | "standalone" | null;
type DviChoice = "autoflow" | "tekmetric" | null;

interface IntegrationStatus {
  carfax: { configured: boolean; locationId?: string };
  autoflow: { configured: boolean };
  protractor: { configured: boolean; connectionId?: string };
  tekmetric: { configured: boolean; shopId?: number; shopName?: string; lastSync?: string };
}

export default function IntegrationsPage() {
  const [loading, setLoading] = useState(true);
  const [statuses, setStatuses] = useState<IntegrationStatus>({
    carfax: { configured: false },
    autoflow: { configured: false },
    protractor: { configured: false },
    tekmetric: { configured: false },
  });
  const [shopManagement, setShopManagement] = useState<ShopManagementChoice>(null);
  const [dviChoice, setDviChoice] = useState<DviChoice>(null);

  useEffect(() => {
    fetchAllStatuses();
  }, []);

  async function fetchAllStatuses() {
    try {
      const [carfaxRes, autoflowRes, protractorRes, tekmetricRes] = await Promise.all([
        fetch("/api/settings/carfax").catch(() => null),
        fetch("/api/settings/autoflow").catch(() => null),
        fetch("/api/settings/protractor").catch(() => null),
        fetch("/api/settings/tekmetric").catch(() => null),
      ]);

      const carfaxData = carfaxRes?.ok ? await carfaxRes.json() : {};
      const autoflowData = autoflowRes?.ok ? await autoflowRes.json() : {};
      const protractorData = protractorRes?.ok ? await protractorRes.json() : {};
      const tekmetricData = tekmetricRes?.ok ? await tekmetricRes.json() : {};

      const newStatuses = {
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
        tekmetric: {
          configured: Boolean(tekmetricData.configured),
          shopId: tekmetricData.shopId,
          shopName: tekmetricData.shopName,
          lastSync: tekmetricData.lastSync,
        },
      };

      setStatuses(newStatuses);

      // Auto-select based on what's configured
      if (newStatuses.protractor.configured) {
        setShopManagement("protractor");
      } else if (newStatuses.tekmetric.configured) {
        setShopManagement("tekmetric");
      }

      if (newStatuses.autoflow.configured) {
        setDviChoice("autoflow");
      } else if (newStatuses.tekmetric.configured) {
        setDviChoice("tekmetric");
      }
    } catch (err) {
      console.error("Failed to fetch integration statuses:", err);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[400px]">
        <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <main className="p-6">
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 bg-blue-100 rounded-lg">
          <Puzzle className="w-6 h-6 text-blue-600" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Integrations</h1>
          <p className="text-gray-500">Connect your shop to external services</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Column 1: CARFAX */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="p-4 border-b border-gray-100 bg-gray-50">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-red-100 rounded-lg">
                <Car className="w-5 h-5 text-red-600" />
              </div>
              <div>
                <h2 className="font-semibold text-gray-900">Vehicle History</h2>
                <p className="text-xs text-gray-500">Service history data</p>
              </div>
            </div>
          </div>
          <CarfaxSection status={statuses.carfax} onUpdate={fetchAllStatuses} />
        </div>

        {/* Column 2: Shop Management System */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="p-4 border-b border-gray-100 bg-gray-50">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-blue-100 rounded-lg">
                <Wrench className="w-5 h-5 text-blue-600" />
              </div>
              <div>
                <h2 className="font-semibold text-gray-900">Shop Management</h2>
                <p className="text-xs text-gray-500">Vehicle & RO data source</p>
              </div>
            </div>
          </div>
          <div className="p-4">
            <div className="space-y-2 mb-4">
              <label className="flex items-center gap-3 p-3 rounded-lg border cursor-pointer hover:bg-gray-50 transition-colors">
                <input
                  type="radio"
                  name="shopManagement"
                  checked={shopManagement === "protractor"}
                  onChange={() => setShopManagement("protractor")}
                  className="w-4 h-4 text-blue-600"
                />
                <span className="flex-1 font-medium text-gray-700">Protractor</span>
                {statuses.protractor.configured && <CheckCircle className="w-4 h-4 text-green-500" />}
              </label>
              <label className="flex items-center gap-3 p-3 rounded-lg border cursor-pointer hover:bg-gray-50 transition-colors">
                <input
                  type="radio"
                  name="shopManagement"
                  checked={shopManagement === "tekmetric"}
                  onChange={() => setShopManagement("tekmetric")}
                  className="w-4 h-4 text-blue-600"
                />
                <span className="flex-1 font-medium text-gray-700">Tekmetric</span>
                {statuses.tekmetric.configured && <CheckCircle className="w-4 h-4 text-green-500" />}
              </label>
              <label className="flex items-center gap-3 p-3 rounded-lg border cursor-pointer hover:bg-gray-50 transition-colors">
                <input
                  type="radio"
                  name="shopManagement"
                  checked={shopManagement === "standalone"}
                  onChange={() => setShopManagement("standalone")}
                  className="w-4 h-4 text-blue-600"
                />
                <span className="flex-1 font-medium text-gray-700">Stand Alone</span>
              </label>
            </div>
            
            {shopManagement === "protractor" && (
              <ProtractorSection status={statuses.protractor} onUpdate={fetchAllStatuses} />
            )}
            {shopManagement === "tekmetric" && (
              <TekmetricSection status={statuses.tekmetric} onUpdate={fetchAllStatuses} />
            )}
            {shopManagement === "standalone" && (
              <StandaloneSection />
            )}
            {!shopManagement && (
              <div className="text-center text-gray-400 py-8">
                Select an option above to configure
              </div>
            )}
          </div>
        </div>

        {/* Column 3: DVI */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="p-4 border-b border-gray-100 bg-gray-50">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-green-100 rounded-lg">
                <ClipboardCheck className="w-5 h-5 text-green-600" />
              </div>
              <div>
                <h2 className="font-semibold text-gray-900">DVI Integration</h2>
                <p className="text-xs text-gray-500">Digital Vehicle Inspections</p>
              </div>
            </div>
          </div>
          <div className="p-4">
            <div className="space-y-2 mb-4">
              <label className="flex items-center gap-3 p-3 rounded-lg border cursor-pointer hover:bg-gray-50 transition-colors">
                <input
                  type="radio"
                  name="dvi"
                  checked={dviChoice === "autoflow"}
                  onChange={() => setDviChoice("autoflow")}
                  className="w-4 h-4 text-blue-600"
                />
                <span className="flex-1 font-medium text-gray-700">AutoFlow</span>
                {statuses.autoflow.configured && <CheckCircle className="w-4 h-4 text-green-500" />}
              </label>
              <label className="flex items-center gap-3 p-3 rounded-lg border cursor-pointer hover:bg-gray-50 transition-colors">
                <input
                  type="radio"
                  name="dvi"
                  checked={dviChoice === "tekmetric"}
                  onChange={() => setDviChoice("tekmetric")}
                  className="w-4 h-4 text-blue-600"
                />
                <span className="flex-1 font-medium text-gray-700">Tekmetric</span>
                {statuses.tekmetric.configured && <CheckCircle className="w-4 h-4 text-green-500" />}
              </label>
            </div>
            
            {dviChoice === "autoflow" && (
              <AutoflowSection status={statuses.autoflow} onUpdate={fetchAllStatuses} />
            )}
            {dviChoice === "tekmetric" && (
              <TekmetricDviSection status={statuses.tekmetric} />
            )}
            {!dviChoice && (
              <div className="text-center text-gray-400 py-8">
                Select an option above to configure
              </div>
            )}
          </div>
        </div>
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

function CarfaxSection({ status, onUpdate }: { status: { configured: boolean; locationId?: string }; onUpdate: () => void }) {
  const [locationId, setLocationId] = useState(status.locationId || "");
  const [saving, setSaving] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    setLocationId(status.locationId || "");
  }, [status.locationId]);

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
        setMessage({ type: "success", text: "CARFAX connected" });
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
    if (!confirm("Disconnect CARFAX?")) return;
    
    setDisconnecting(true);
    setMessage(null);

    try {
      const res = await fetch("/api/settings/carfax", { method: "DELETE" });
      if (res.ok) {
        setMessage({ type: "success", text: "Disconnected" });
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

  return (
    <div className="p-4 space-y-4">
      <div className={`rounded-lg p-3 ${status.configured ? 'bg-green-50 border border-green-200' : 'bg-gray-50 border border-gray-200'}`}>
        <div className="flex items-center gap-2 text-sm">
          {status.configured ? (
            <>
              <CheckCircle className="w-4 h-4 text-green-600" />
              <span className="text-green-800">Connected</span>
            </>
          ) : (
            <>
              <AlertCircle className="w-4 h-4 text-gray-400" />
              <span className="text-gray-600">Not configured</span>
            </>
          )}
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Location ID
        </label>
        <input
          type="text"
          value={locationId}
          onChange={(e) => setLocationId(e.target.value)}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          placeholder="Your CARFAX Location ID"
        />
      </div>

      {message && (
        <div className={`flex items-center gap-2 p-2 rounded-lg text-sm ${
          message.type === "success" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
        }`}>
          {message.type === "success" ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
          <span>{message.text}</span>
        </div>
      )}

      <div className="flex gap-2">
        <button
          onClick={handleSave}
          disabled={saving || !locationId}
          className="flex-1 px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {saving && <Loader2 className="w-4 h-4 animate-spin" />}
          Connect
        </button>
        {status.configured && (
          <button
            onClick={handleDisconnect}
            disabled={disconnecting}
            className="px-4 py-2 bg-red-100 text-red-700 text-sm rounded-lg hover:bg-red-200 disabled:opacity-50"
          >
            {disconnecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
          </button>
        )}
      </div>
    </div>
  );
}

function ProtractorSection({ status, onUpdate }: { status: { configured: boolean; connectionId?: string }; onUpdate: () => void }) {
  const [connectionId, setConnectionId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  async function handleSave() {
    setSaving(true);
    setMessage(null);

    try {
      const res = await fetch("/api/settings/protractor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId, apiKey }),
      });

      if (res.ok) {
        setMessage({ type: "success", text: "Protractor connected" });
        onUpdate();
      } else {
        const data = await res.json();
        setMessage({ type: "error", text: data.error || "Failed to connect" });
      }
    } catch (err) {
      setMessage({ type: "error", text: "Failed to save" });
    } finally {
      setSaving(false);
    }
  }

  async function handleSync() {
    setSyncing(true);
    setMessage(null);

    try {
      const res = await fetch("/api/protractor/sync", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: `Synced ${data.vehicles || 0} vehicles` });
      } else {
        setMessage({ type: "error", text: data.error || "Sync failed" });
      }
    } catch (err) {
      setMessage({ type: "error", text: "Sync failed" });
    } finally {
      setSyncing(false);
    }
  }

  async function handleDisconnect() {
    if (!confirm("Disconnect Protractor?")) return;
    setDisconnecting(true);
    try {
      const res = await fetch("/api/settings/protractor", { method: "DELETE" });
      if (res.ok) {
        setMessage({ type: "success", text: "Disconnected" });
        onUpdate();
      }
    } catch (err) {
      setMessage({ type: "error", text: "Failed" });
    } finally {
      setDisconnecting(false);
    }
  }

  if (status.configured) {
    return (
      <div className="space-y-3 border-t pt-4">
        <div className="bg-green-50 border border-green-200 rounded-lg p-3">
          <div className="flex items-center gap-2 text-sm text-green-800">
            <CheckCircle className="w-4 h-4" />
            <span>Connected to Protractor</span>
          </div>
        </div>
        
        {message && (
          <div className={`flex items-center gap-2 p-2 rounded-lg text-sm ${
            message.type === "success" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
          }`}>
            {message.type === "success" ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
            <span>{message.text}</span>
          </div>
        )}
        
        <div className="flex gap-2">
          <button
            onClick={handleSync}
            disabled={syncing}
            className="flex-1 px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {syncing && <Loader2 className="w-4 h-4 animate-spin" />}
            Sync Now
          </button>
          <button
            onClick={handleDisconnect}
            disabled={disconnecting}
            className="px-4 py-2 bg-red-100 text-red-700 text-sm rounded-lg hover:bg-red-200"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3 border-t pt-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Connection ID</label>
        <input
          type="text"
          value={connectionId}
          onChange={(e) => setConnectionId(e.target.value)}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
          placeholder="Your Protractor Connection ID"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">API Key</label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
          placeholder="Your Protractor API Key"
        />
      </div>

      {message && (
        <div className={`flex items-center gap-2 p-2 rounded-lg text-sm ${
          message.type === "success" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
        }`}>
          {message.type === "success" ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
          <span>{message.text}</span>
        </div>
      )}

      <button
        onClick={handleSave}
        disabled={saving || !connectionId || !apiKey}
        className="w-full px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {saving && <Loader2 className="w-4 h-4 animate-spin" />}
        Connect
      </button>
    </div>
  );
}

function TekmetricSection({ status, onUpdate }: { status: { configured: boolean; shopId?: number; shopName?: string }; onUpdate: () => void }) {
  const [shopId, setShopId] = useState("");
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  async function handleSave() {
    setSaving(true);
    setMessage(null);

    try {
      const res = await fetch("/api/settings/tekmetric", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shopId: parseInt(shopId) }),
      });

      if (res.ok) {
        setMessage({ type: "success", text: "Tekmetric connected" });
        onUpdate();
      } else {
        const data = await res.json();
        setMessage({ type: "error", text: data.error || "Failed to connect" });
      }
    } catch (err) {
      setMessage({ type: "error", text: "Failed to save" });
    } finally {
      setSaving(false);
    }
  }

  async function handleSync() {
    setSyncing(true);
    setMessage(null);

    try {
      const res = await fetch("/api/tekmetric/sync", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: `Synced ${data.imported || 0} vehicles` });
      } else {
        setMessage({ type: "error", text: data.error || "Sync failed" });
      }
    } catch (err) {
      setMessage({ type: "error", text: "Sync failed" });
    } finally {
      setSyncing(false);
    }
  }

  async function handleDisconnect() {
    if (!confirm("Disconnect Tekmetric?")) return;
    setDisconnecting(true);
    try {
      const res = await fetch("/api/settings/tekmetric", { method: "DELETE" });
      if (res.ok) {
        setMessage({ type: "success", text: "Disconnected" });
        onUpdate();
      }
    } catch (err) {
      setMessage({ type: "error", text: "Failed" });
    } finally {
      setDisconnecting(false);
    }
  }

  if (status.configured) {
    return (
      <div className="space-y-3 border-t pt-4">
        <div className="bg-green-50 border border-green-200 rounded-lg p-3">
          <div className="flex items-center gap-2 text-sm text-green-800">
            <CheckCircle className="w-4 h-4" />
            <span>Connected: {status.shopName || `Shop ${status.shopId}`}</span>
          </div>
        </div>
        
        {message && (
          <div className={`flex items-center gap-2 p-2 rounded-lg text-sm ${
            message.type === "success" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
          }`}>
            {message.type === "success" ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
            <span>{message.text}</span>
          </div>
        )}
        
        <div className="flex gap-2">
          <button
            onClick={handleSync}
            disabled={syncing}
            className="flex-1 px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {syncing && <Loader2 className="w-4 h-4 animate-spin" />}
            Sync Now
          </button>
          <button
            onClick={handleDisconnect}
            disabled={disconnecting}
            className="px-4 py-2 bg-red-100 text-red-700 text-sm rounded-lg hover:bg-red-200"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3 border-t pt-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Shop ID</label>
        <input
          type="text"
          value={shopId}
          onChange={(e) => setShopId(e.target.value)}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
          placeholder="Your Tekmetric Shop ID"
        />
        <p className="text-xs text-gray-500 mt-1">Find this in your Tekmetric account settings</p>
      </div>

      {message && (
        <div className={`flex items-center gap-2 p-2 rounded-lg text-sm ${
          message.type === "success" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
        }`}>
          {message.type === "success" ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
          <span>{message.text}</span>
        </div>
      )}

      <button
        onClick={handleSave}
        disabled={saving || !shopId}
        className="w-full px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {saving && <Loader2 className="w-4 h-4 animate-spin" />}
        Connect
      </button>
    </div>
  );
}

function StandaloneSection() {
  return (
    <div className="space-y-3 border-t pt-4">
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h3 className="font-medium text-blue-800 mb-2">Stand Alone Mode</h3>
        <p className="text-sm text-blue-700">
          Use MOS without a shop management system. You can manually enter VINs and mileage to get maintenance recommendations.
        </p>
      </div>
      <div className="bg-gray-50 rounded-lg p-4 text-center">
        <p className="text-sm text-gray-600 mb-3">
          Go to the Vehicles page and use "Add Vehicle" to manually enter vehicle information.
        </p>
        <a
          href="/dashboard"
          className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700"
        >
          <Car className="w-4 h-4" />
          Go to Vehicles
        </a>
      </div>
    </div>
  );
}

function AutoflowSection({ status, onUpdate }: { status: { configured: boolean }; onUpdate: () => void }) {
  const [domain, setDomain] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiPassword, setApiPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

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
        setMessage({ type: "success", text: "AutoFlow connected" });
        onUpdate();
      } else {
        const data = await res.json();
        setMessage({ type: "error", text: data.error || "Failed to connect" });
      }
    } catch (err) {
      setMessage({ type: "error", text: "Failed to save" });
    } finally {
      setSaving(false);
    }
  }

  async function handleDisconnect() {
    if (!confirm("Disconnect AutoFlow?")) return;
    setDisconnecting(true);
    try {
      const res = await fetch("/api/settings/autoflow", { method: "DELETE" });
      if (res.ok) {
        setMessage({ type: "success", text: "Disconnected" });
        setDomain("");
        setApiKey("");
        setApiPassword("");
        onUpdate();
      }
    } catch (err) {
      setMessage({ type: "error", text: "Failed" });
    } finally {
      setDisconnecting(false);
    }
  }

  if (status.configured) {
    return (
      <div className="space-y-3 border-t pt-4">
        <div className="bg-green-50 border border-green-200 rounded-lg p-3">
          <div className="flex items-center gap-2 text-sm text-green-800">
            <CheckCircle className="w-4 h-4" />
            <span>Connected to AutoFlow</span>
          </div>
        </div>
        
        {message && (
          <div className={`flex items-center gap-2 p-2 rounded-lg text-sm ${
            message.type === "success" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
          }`}>
            {message.type === "success" ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
            <span>{message.text}</span>
          </div>
        )}
        
        <button
          onClick={handleDisconnect}
          disabled={disconnecting}
          className="w-full px-4 py-2 bg-red-100 text-red-700 text-sm rounded-lg hover:bg-red-200 flex items-center justify-center gap-2"
        >
          {disconnecting && <Loader2 className="w-4 h-4 animate-spin" />}
          <Trash2 className="w-4 h-4" />
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3 border-t pt-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Domain</label>
        <input
          type="text"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
          placeholder="yourshop.autoflow.com"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">API Key</label>
        <input
          type="text"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
          placeholder="API Key"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">API Password</label>
        <input
          type="password"
          value={apiPassword}
          onChange={(e) => setApiPassword(e.target.value)}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
          placeholder="API Password"
        />
      </div>

      {message && (
        <div className={`flex items-center gap-2 p-2 rounded-lg text-sm ${
          message.type === "success" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
        }`}>
          {message.type === "success" ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
          <span>{message.text}</span>
        </div>
      )}

      <button
        onClick={handleSave}
        disabled={saving || !domain || !apiKey}
        className="w-full px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {saving && <Loader2 className="w-4 h-4 animate-spin" />}
        Connect
      </button>
    </div>
  );
}

function TekmetricDviSection({ status }: { status: { configured: boolean; shopId?: number; shopName?: string } }) {
  if (status.configured) {
    return (
      <div className="space-y-3 border-t pt-4">
        <div className="bg-green-50 border border-green-200 rounded-lg p-3">
          <div className="flex items-center gap-2 text-sm text-green-800">
            <CheckCircle className="w-4 h-4" />
            <span>Using Tekmetric inspections</span>
          </div>
        </div>
        <p className="text-sm text-gray-600">
          DVI data will be pulled from your Tekmetric integration automatically.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3 border-t pt-4">
      <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
        <div className="flex items-center gap-2 text-sm text-yellow-800">
          <AlertCircle className="w-4 h-4" />
          <span>Tekmetric not connected</span>
        </div>
      </div>
      <p className="text-sm text-gray-600">
        Connect Tekmetric in the Shop Management section first to use Tekmetric for DVI data.
      </p>
    </div>
  );
}
