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
  Mail,
  ExternalLink,
  Copy,
  Link,
  Key,
  Shield,
  Eye,
  EyeOff,
} from "lucide-react";

type ShopManagementChoice = "protractor" | "tekmetric" | "shopware" | "standalone" | null;
type DviChoice = "autoflow" | "tekmetric" | null;

interface IntegrationStatus {
  carfax: { configured: boolean; locationId?: string };
  autoflow: { configured: boolean };
  protractor: { configured: boolean; connectionId?: string };
  tekmetric: { configured: boolean; shopId?: number; shopName?: string; lastSync?: string };
  shopware: { configured: boolean; tenantId?: number; swShopId?: number; shopName?: string; lastSyncAt?: string };
}

export default function IntegrationsPage() {
  const [loading, setLoading] = useState(true);
  const [statuses, setStatuses] = useState<IntegrationStatus>({
    carfax: { configured: false },
    autoflow: { configured: false },
    protractor: { configured: false },
    tekmetric: { configured: false },
    shopware: { configured: false },
  });
  const [shopManagement, setShopManagement] = useState<ShopManagementChoice>(null);
  const [dviChoice, setDviChoice] = useState<DviChoice>(null);

  useEffect(() => {
    fetchAllStatuses();
  }, []);

  async function fetchAllStatuses() {
    try {
      const [carfaxRes, autoflowRes, protractorRes, tekmetricRes, shopwareRes] = await Promise.all([
        fetch("/api/settings/carfax").catch(() => null),
        fetch("/api/settings/autoflow").catch(() => null),
        fetch("/api/settings/protractor").catch(() => null),
        fetch("/api/settings/tekmetric").catch(() => null),
        fetch("/api/settings/shopware").catch(() => null),
      ]);

      const carfaxData = carfaxRes?.ok ? await carfaxRes.json() : {};
      const autoflowData = autoflowRes?.ok ? await autoflowRes.json() : {};
      const protractorData = protractorRes?.ok ? await protractorRes.json() : {};
      const tekmetricData = tekmetricRes?.ok ? await tekmetricRes.json() : {};
      const shopwareData = shopwareRes?.ok ? await shopwareRes.json() : {};

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
          connectionId: protractorData.connectionId,
          webhookToken: protractorData.webhookToken,
        },
        tekmetric: {
          configured: Boolean(tekmetricData.configured),
          shopId: tekmetricData.shopId,
          shopName: tekmetricData.shopName,
          lastSync: tekmetricData.lastSync,
        },
        shopware: {
          configured: Boolean(shopwareData.configured),
          tenantId: shopwareData.tenantId,
          swShopId: shopwareData.swShopId,
          shopName: shopwareData.shopName,
          lastSyncAt: shopwareData.lastSyncAt,
        },
      };

      setStatuses(newStatuses);

      // Fetch saved smsProvider preference
      const integrationsRes = await fetch("/api/settings/integrations").catch(() => null);
      const integrationsData = integrationsRes?.ok ? await integrationsRes.json() : {};
      
      // Use saved preference if available, otherwise auto-select based on what's configured
      if (integrationsData.smsProvider) {
        setShopManagement(integrationsData.smsProvider);
      } else if (newStatuses.tekmetric.configured) {
        setShopManagement("tekmetric");
      } else if (newStatuses.protractor.configured) {
        setShopManagement("protractor");
      } else if (newStatuses.shopware.configured) {
        setShopManagement("shopware");
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

  async function handleShopManagementChange(provider: ShopManagementChoice) {
    setShopManagement(provider);
    try {
      await fetch("/api/settings/integrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ smsProvider: provider }),
      });
    } catch (err) {
      console.error("Failed to save SMS provider preference:", err);
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
                  onChange={() => handleShopManagementChange("protractor")}
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
                  onChange={() => handleShopManagementChange("tekmetric")}
                  className="w-4 h-4 text-blue-600"
                />
                <span className="flex-1 font-medium text-gray-700">Tekmetric</span>
                {statuses.tekmetric.configured && <CheckCircle className="w-4 h-4 text-green-500" />}
              </label>
              <label className="flex items-center gap-3 p-3 rounded-lg border cursor-pointer hover:bg-gray-50 transition-colors">
                <input
                  type="radio"
                  name="shopManagement"
                  checked={shopManagement === "shopware"}
                  onChange={() => handleShopManagementChange("shopware")}
                  className="w-4 h-4 text-blue-600"
                />
                <span className="flex-1 font-medium text-gray-700">Shop-Ware</span>
                {statuses.shopware.configured && <CheckCircle className="w-4 h-4 text-green-500" />}
              </label>
              <label className="flex items-center gap-3 p-3 rounded-lg border cursor-pointer hover:bg-gray-50 transition-colors">
                <input
                  type="radio"
                  name="shopManagement"
                  checked={shopManagement === "standalone"}
                  onChange={() => handleShopManagementChange("standalone")}
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
            {shopManagement === "shopware" && (
              <ShopWareSection status={statuses.shopware} onUpdate={fetchAllStatuses} />
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

      <PartnerApiSection />

      <DevToolsSection />
    </main>
  );
}

type RateLimitTier = "standard" | "professional" | "enterprise";

interface PartnerApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  permissions: string[];
  rateLimit: number;
  rateLimitTier: RateLimitTier;
  isActive: boolean;
  usageCount: number;
  lastUsedAt?: string;
  createdAt: string;
}

const TIER_LABELS: Record<RateLimitTier, string> = {
  standard: "Standard",
  professional: "Professional",
  enterprise: "Enterprise",
};

const TIER_COLORS: Record<RateLimitTier, string> = {
  standard: "bg-gray-100 text-gray-800",
  professional: "bg-blue-100 text-blue-800",
  enterprise: "bg-purple-100 text-purple-800",
};

const DEFAULT_PERMISSIONS = [
  "appointments:create",
  "appointments:read",
  "vehicles:read",
  "recommendations:read",
];

function PartnerApiSection() {
  const [loading, setLoading] = useState(true);
  const [apiKey, setApiKey] = useState<PartnerApiKey | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);

  useEffect(() => {
    fetchPartnerKey();
  }, []);

  async function fetchPartnerKey() {
    try {
      const res = await fetch("/api/settings/api-keys");
      const data = await res.json();
      if (data.keys && data.keys.length > 0) {
        const partnerKey = data.keys.find((k: PartnerApiKey) => k.name === "Partner API Key" && k.isActive);
        setApiKey(partnerKey || null);
      }
      setIsPlatformAdmin(data.isPlatformAdmin || false);
    } catch (err) {
      console.error("Failed to fetch partner key:", err);
    } finally {
      setLoading(false);
    }
  }

  async function createPartnerKey() {
    setCreating(true);
    setMessage(null);

    try {
      const res = await fetch("/api/settings/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Partner API Key",
          permissions: DEFAULT_PERMISSIONS,
          rateLimitTier: "standard",
        }),
      });

      const data = await res.json();
      if (data.success) {
        setNewKey(data.key);
        setMessage({ type: "success", text: "Partner API key created!" });
        fetchPartnerKey();
      } else {
        setMessage({ type: "error", text: data.error || "Failed to create key" });
      }
    } catch (err) {
      setMessage({ type: "error", text: "Failed to create key" });
    } finally {
      setCreating(false);
    }
  }

  async function revokeKey() {
    if (!apiKey || !confirm("Are you sure you want to revoke this API key? This cannot be undone.")) {
      return;
    }

    setRevoking(true);
    setMessage(null);

    try {
      const res = await fetch(`/api/settings/api-keys?keyId=${apiKey.id}`, {
        method: "DELETE",
      });

      if (res.ok) {
        setMessage({ type: "success", text: "API key revoked" });
        setApiKey(null);
        setNewKey(null);
      } else {
        setMessage({ type: "error", text: "Failed to revoke key" });
      }
    } catch (err) {
      setMessage({ type: "error", text: "Failed to revoke key" });
    } finally {
      setRevoking(false);
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
    setMessage({ type: "success", text: "Copied to clipboard!" });
    setTimeout(() => setMessage(null), 2000);
  }

  return (
    <div className="mt-8 bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="p-4 border-b border-gray-100 bg-gray-50">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-green-100 rounded-lg">
            <Key className="w-5 h-5 text-green-600" />
          </div>
          <div>
            <h2 className="font-semibold text-gray-900">Partner API</h2>
            <p className="text-xs text-gray-500">Connect external systems to your shop</p>
          </div>
        </div>
      </div>

      <div className="p-6">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
          </div>
        ) : newKey ? (
          <div className="space-y-4">
            <div className="bg-green-50 border border-green-200 rounded-lg p-4">
              <div className="flex items-center gap-2 text-green-800 font-medium mb-2">
                <CheckCircle className="w-5 h-5" />
                API Key Created
              </div>
              <p className="text-sm text-green-700 mb-3">
                Copy this key now. You won&apos;t be able to see it again.
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 p-3 bg-white border border-green-300 rounded font-mono text-sm break-all">
                  {showKey ? newKey : "mos_" + "•".repeat(60)}
                </code>
                <button
                  onClick={() => setShowKey(!showKey)}
                  className="p-2 text-green-600 hover:bg-green-100 rounded"
                >
                  {showKey ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                </button>
                <button
                  onClick={() => copyToClipboard(newKey)}
                  className="p-2 bg-green-600 text-white rounded hover:bg-green-700"
                >
                  <Copy className="w-5 h-5" />
                </button>
              </div>
            </div>
            <button
              onClick={() => setNewKey(null)}
              className="text-sm text-gray-500 hover:text-gray-700"
            >
              Done
            </button>
          </div>
        ) : apiKey ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <Shield className="w-5 h-5 text-green-600" />
                  <span className="font-medium text-gray-900">Active API Key</span>
                </div>
                <span className={`px-2 py-1 text-xs rounded-full ${TIER_COLORS[apiKey.rateLimitTier]}`}>
                  {TIER_LABELS[apiKey.rateLimitTier]}
                </span>
              </div>
              <code className="text-sm bg-gray-100 px-3 py-1 rounded">
                {apiKey.keyPrefix}...
              </code>
            </div>

            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-gray-500">Rate Limit:</span>
                <span className="ml-2 font-medium">{apiKey.rateLimit} req/min</span>
              </div>
              <div>
                <span className="text-gray-500">Usage:</span>
                <span className="ml-2 font-medium">{apiKey.usageCount} calls</span>
              </div>
              <div>
                <span className="text-gray-500">Created:</span>
                <span className="ml-2 font-medium">{new Date(apiKey.createdAt).toLocaleDateString()}</span>
              </div>
              {apiKey.lastUsedAt && (
                <div>
                  <span className="text-gray-500">Last Used:</span>
                  <span className="ml-2 font-medium">{new Date(apiKey.lastUsedAt).toLocaleDateString()}</span>
                </div>
              )}
            </div>

            <div className="pt-4 border-t border-gray-100">
              <h4 className="text-sm font-medium text-gray-700 mb-2">Permissions</h4>
              <div className="flex flex-wrap gap-2">
                {apiKey.permissions.map((perm) => (
                  <span key={perm} className="text-xs bg-blue-50 text-blue-700 px-2 py-1 rounded">
                    {perm}
                  </span>
                ))}
              </div>
              {!isPlatformAdmin && (
                <p className="text-xs text-gray-500 mt-2">
                  Contact support to request additional permissions or higher rate limits.
                </p>
              )}
            </div>

            <div className="flex items-center justify-between pt-4">
              <a
                href="/api-docs"
                target="_blank"
                className="text-sm text-blue-600 hover:underline flex items-center gap-1"
              >
                <ExternalLink className="w-4 h-4" />
                View API Documentation
              </a>
              <button
                onClick={revokeKey}
                disabled={revoking}
                className="px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 rounded-lg flex items-center gap-1"
              >
                {revoking ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                Revoke Key
              </button>
            </div>
          </div>
        ) : (
          <div className="text-center py-6">
            <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <Key className="w-6 h-6 text-gray-400" />
            </div>
            <h3 className="font-medium text-gray-900 mb-2">No Partner API Key</h3>
            <p className="text-sm text-gray-500 mb-4">
              Create an API key to integrate external systems like CRMs, marketing tools, or custom applications.
            </p>
            <button
              onClick={createPartnerKey}
              disabled={creating}
              className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 flex items-center gap-2 mx-auto"
            >
              {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Key className="w-4 h-4" />}
              Create Partner API Key
            </button>
          </div>
        )}

        {message && (
          <div className={`mt-4 flex items-center gap-2 p-3 rounded-lg ${
            message.type === "success" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
          }`}>
            {message.type === "success" ? <CheckCircle className="w-5 h-5" /> : <XCircle className="w-5 h-5" />}
            <span className="text-sm">{message.text}</span>
          </div>
        )}
      </div>
    </div>
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

function ProtractorSection({ status, onUpdate }: { status: { configured: boolean; connectionId?: string; webhookToken?: string }; onUpdate: () => void }) {
  const [connectionId, setConnectionId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [sendingRequest, setSendingRequest] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  
  const webhookUrl = status.webhookToken 
    ? `https://mos.tools/api/webhooks/protractor/${status.webhookToken}`
    : null;
    
  const copyWebhookUrl = async () => {
    if (webhookUrl) {
      await navigator.clipboard.writeText(webhookUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  async function handleRequestApiAccess() {
    if (!confirm("This will send an email to Protractor support (support@protractor.com) requesting API access for your shop. The shop owner will be CC'd. Continue?")) {
      return;
    }
    
    setSendingRequest(true);
    setMessage(null);
    
    try {
      const res = await fetch("/api/settings/integration-setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "protractor" }),
      });
      
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: data.message || "Request sent!" });
      } else {
        setMessage({ type: "error", text: data.error || "Failed to send request" });
      }
    } catch (err) {
      setMessage({ type: "error", text: "Failed to send request" });
    } finally {
      setSendingRequest(false);
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

      if (res.ok) {
        setMessage({ type: "success", text: "Connected! Initial sync started in background." });
        onUpdate();
        // Fire-and-forget background sync - don't await
        fetch("/api/protractor/sync", { method: "POST" }).catch(() => {});
        return;
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
        
        {webhookUrl && (
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-3">
            <p className="text-xs font-medium text-gray-700 mb-2">Callback URL</p>
            <p className="text-xs text-gray-500 mb-2">Add this URL to Protractor to receive real-time updates</p>
            <div className="flex gap-2">
              <input
                type="text"
                value={webhookUrl}
                readOnly
                className="flex-1 px-3 py-2 text-xs border border-gray-300 rounded-lg bg-white font-mono"
              />
              <button
                onClick={copyWebhookUrl}
                className="px-3 py-2 bg-blue-600 text-white text-xs rounded-lg hover:bg-blue-700"
              >
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
          </div>
        )}
        
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
      
      <div className="border-t pt-3 mt-3">
        <p className="text-xs text-gray-500 mb-2">
          Need API access? We can email Protractor support on your behalf.
        </p>
        <button
          onClick={handleRequestApiAccess}
          disabled={sendingRequest}
          className="w-full px-4 py-2 bg-gray-100 text-gray-700 text-sm rounded-lg hover:bg-gray-200 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {sendingRequest ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
          Request API Access
        </button>
      </div>
    </div>
  );
}

function TekmetricSection({ status, onUpdate }: { status: { configured: boolean; shopId?: number; shopName?: string }; onUpdate: () => void }) {
  const [shopId, setShopId] = useState("");
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [sendingInstructions, setSendingInstructions] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [webhookCopied, setWebhookCopied] = useState(false);

  const chromeExtensionUrl = "https://chromewebstore.google.com/detail/mos-tools/gkcehigbdlhjacjbgiffnlfhdnghlknd";
  
  const getWebhookUrl = () => {
    if (typeof window !== "undefined") {
      return `${window.location.origin}/api/webhooks/tekmetric`;
    }
    return "/api/webhooks/tekmetric";
  };

  const copyWebhookUrl = async () => {
    const url = getWebhookUrl();
    try {
      await navigator.clipboard.writeText(url);
      setWebhookCopied(true);
      setTimeout(() => setWebhookCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  async function handleSendSetupInstructions() {
    if (!confirm("This will send setup instructions to the shop owner, including how to enable the integration in Tekmetric and install the Chrome extension. Continue?")) {
      return;
    }
    
    setSendingInstructions(true);
    setMessage(null);
    
    try {
      const res = await fetch("/api/settings/integration-setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "tekmetric" }),
      });
      
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: data.message || "Instructions sent!" });
      } else {
        setMessage({ type: "error", text: data.error || "Failed to send instructions" });
      }
    } catch (err) {
      setMessage({ type: "error", text: "Failed to send instructions" });
    } finally {
      setSendingInstructions(false);
    }
  }

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
        setMessage({ type: "success", text: "Connected! Initial sync started in background." });
        onUpdate();
        // Fire-and-forget background sync - don't await
        fetch("/api/tekmetric/sync", { method: "POST" }).catch(() => {});
        return;
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

        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
          <div className="flex items-center gap-2 text-sm text-blue-800 mb-2">
            <Link className="w-4 h-4" />
            <span className="font-medium">Webhook URL</span>
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs bg-white px-2 py-1.5 rounded border border-blue-200 text-gray-700 truncate">
              {getWebhookUrl()}
            </code>
            <button
              onClick={copyWebhookUrl}
              className="px-2 py-1.5 bg-blue-100 text-blue-700 rounded hover:bg-blue-200 transition-colors"
              title="Copy webhook URL"
            >
              {webhookCopied ? <CheckCircle className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            </button>
          </div>
          <p className="text-xs text-blue-600 mt-2">
            Add this URL in Tekmetric under Settings &rarr; Integrations &rarr; Webhooks
          </p>
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
        
        <div className="border-t pt-3 space-y-2">
          <a
            href={chromeExtensionUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="w-full px-4 py-2 bg-purple-100 text-purple-700 text-sm rounded-lg hover:bg-purple-200 flex items-center justify-center gap-2"
          >
            <ExternalLink className="w-4 h-4" />
            Install Chrome Extension
          </a>
          <button
            onClick={handleSendSetupInstructions}
            disabled={sendingInstructions}
            className="w-full px-4 py-2 bg-gray-100 text-gray-700 text-sm rounded-lg hover:bg-gray-200 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {sendingInstructions ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
            Email Setup Instructions
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
  const [webhookToken, setWebhookToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (status.configured) {
      fetch("/api/settings/autoflow")
        .then(r => r.json())
        .then(data => setWebhookToken(data.webhookToken || null))
        .catch(() => {});
    }
  }, [status.configured]);

  const webhookUrl = webhookToken ? `https://mos.tools/api/webhooks/autoflow/${webhookToken}` : null;

  const copyWebhookUrl = async () => {
    if (webhookUrl) {
      await navigator.clipboard.writeText(webhookUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

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

        {webhookUrl && (
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-3">
            <p className="text-xs font-medium text-gray-700 mb-2">Webhook URL</p>
            <div className="flex items-center gap-2">
              <input
                type="text"
                readOnly
                value={webhookUrl}
                className="flex-1 px-2 py-1.5 text-xs font-mono bg-white border border-gray-300 rounded"
              />
              <button
                type="button"
                onClick={copyWebhookUrl}
                className="px-2 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-100"
              >
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
            <p className="text-xs text-gray-500 mt-1">
              Paste this into AutoFlow webhook settings
            </p>
          </div>
        )}
        
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

function ShopWareWebhookPanel() {
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [webhookStatus, setWebhookStatus] = useState<{
    registered: boolean;
    webhookId?: string | number;
    webhookUrl?: string;
    registeredAt?: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [customUrl, setCustomUrl] = useState("");
  const [showCustomUrl, setShowCustomUrl] = useState(false);

  async function loadStatus() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/shopware/webhook");
      const data = await res.json();
      if (res.ok) {
        setWebhookStatus({
          registered: data.registered,
          webhookId: data.webhookId,
          webhookUrl: data.webhookUrl,
          registeredAt: data.registeredAt,
        });
        if (!data.registered) setShowCustomUrl(false);
      } else {
        setError(data.error || "Failed to load webhook status");
      }
    } catch {
      setError("Failed to load webhook status");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadStatus(); }, []);

  async function handleRegister() {
    setWorking(true);
    setError(null);
    try {
      const body: any = {};
      if (customUrl.trim()) body.url = customUrl.trim();
      const res = await fetch("/api/settings/shopware/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok) {
        await loadStatus();
      } else {
        setError(data.error || "Registration failed");
        if (data.error?.includes("HTTPS")) setShowCustomUrl(true);
      }
    } catch {
      setError("Registration failed");
    } finally {
      setWorking(false);
    }
  }

  async function handleUnregister() {
    if (!confirm("Unregister the Shop-Ware webhook?")) return;
    setWorking(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/shopware/webhook", { method: "DELETE" });
      const data = await res.json();
      if (res.ok) {
        await loadStatus();
      } else {
        setError(data.error || "Failed to unregister");
      }
    } catch {
      setError("Failed to unregister");
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="border border-gray-200 rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-gray-700">Webhook</span>
        {loading ? (
          <Loader2 className="w-4 h-4 text-gray-400 animate-spin" />
        ) : webhookStatus?.registered ? (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
            <CheckCircle className="w-3 h-3" /> Active
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500">
            Not registered
          </span>
        )}
      </div>

      {webhookStatus?.registered && (
        <div className="text-xs text-gray-500 break-all">
          {webhookStatus.webhookUrl}
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 rounded p-2">
          <XCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {!loading && !webhookStatus?.registered && (
        <div className="space-y-2">
          {showCustomUrl && (
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Custom HTTPS URL
              </label>
              <input
                type="text"
                value={customUrl}
                onChange={(e) => setCustomUrl(e.target.value)}
                className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:ring-1 focus:ring-blue-500"
                placeholder="https://your-domain.com/api/webhooks/shopware"
              />
            </div>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={handleRegister}
              disabled={working}
              className="flex-1 px-3 py-1.5 bg-blue-600 text-white text-xs rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-1"
            >
              {working && <Loader2 className="w-3 h-3 animate-spin" />}
              Register Webhook
            </button>
            {!showCustomUrl && (
              <button
                onClick={() => setShowCustomUrl(true)}
                className="text-xs text-gray-500 hover:text-gray-700 underline"
              >
                Custom URL
              </button>
            )}
          </div>
        </div>
      )}

      {!loading && webhookStatus?.registered && (
        <button
          onClick={handleUnregister}
          disabled={working}
          className="w-full px-3 py-1.5 bg-red-50 text-red-700 text-xs rounded-lg hover:bg-red-100 disabled:opacity-50 flex items-center justify-center gap-1"
        >
          {working ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
          Unregister
        </button>
      )}
    </div>
  );
}

function ShopWareSection({
  status,
  onUpdate,
}: {
  status: { configured: boolean; tenantId?: number; swShopId?: number; shopName?: string; lastSyncAt?: string };
  onUpdate: () => void;
}) {
  const [tenantId, setTenantId] = useState("");
  const [swShopId, setSwShopId] = useState("");
  const [saving, setSaving] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  async function handleSave() {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/settings/shopware", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId: parseInt(tenantId), swShopId: parseInt(swShopId) }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: `Connected to ${data.shopName || "Shop-Ware"}` });
        onUpdate();
      } else {
        setMessage({ type: "error", text: data.error || "Failed to connect" });
      }
    } catch {
      setMessage({ type: "error", text: "Failed to save" });
    } finally {
      setSaving(false);
    }
  }

  async function handleDisconnect() {
    if (!confirm("Disconnect Shop-Ware?")) return;
    setDisconnecting(true);
    try {
      const res = await fetch("/api/settings/shopware", { method: "DELETE" });
      if (res.ok) {
        setMessage({ type: "success", text: "Disconnected" });
        onUpdate();
      }
    } catch {
      setMessage({ type: "error", text: "Failed to disconnect" });
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
            <span>Connected: {status.shopName || `Shop ${status.swShopId}`}</span>
          </div>
          <div className="text-xs text-green-700 mt-1">
            Tenant {status.tenantId} · Shop {status.swShopId}
            {status.lastSyncAt && (
              <span> · Last sync {new Date(status.lastSyncAt).toLocaleDateString()}</span>
            )}
          </div>
        </div>

        <ShopWareWebhookPanel />

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
          {disconnecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3 border-t pt-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Tenant ID</label>
        <input
          type="text"
          value={tenantId}
          onChange={(e) => setTenantId(e.target.value)}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
          placeholder="e.g. 42"
        />
        <p className="text-xs text-gray-500 mt-1">Your Shop-Ware company (tenant) ID</p>
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Shop ID</label>
        <input
          type="text"
          value={swShopId}
          onChange={(e) => setSwShopId(e.target.value)}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
          placeholder="e.g. 3"
        />
        <p className="text-xs text-gray-500 mt-1">Your Shop-Ware shop ID within the tenant</p>
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
        disabled={saving || !tenantId || !swShopId}
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
