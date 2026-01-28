"use client";

import { useState, useEffect } from "react";
import { Building2, Search, RefreshCw, LogIn, Loader2, RotateCcw, Plus, Settings, X, Lock, Unlock, Trash2, ChevronDown, ChevronUp, MapPin, Phone, Clock, CheckCircle2, Clock4, Play, AlertTriangle, Pause, AlertCircle, XCircle } from "lucide-react";

interface ShopBilling {
  plan: string;
  isPaid: boolean;
  vinLimit: number;
  vinViewCount: number;
  status?: string;
}

interface ShopFeatures {
  maintenance?: boolean;
  job_lookup?: boolean;
  common_failures?: boolean;
  oil_sticker?: boolean;
  keytags?: boolean;
  auto_booking?: boolean;
  part_xref?: boolean;
}

interface IntegrationDetails {
  protractor?: {
    configuredAt: string;
    locationName: string | null;
    shortName: string | null;
    address: string | null;
    phone: string | null;
    timeZone: string | null;
  } | null;
  carfax?: {
    locationId: string;
  } | null;
  tekmetric?: {
    shopId: string | number;
  } | null;
}

interface BackfillStatus {
  completed: boolean;
  inProgress: boolean;
  status: "completed" | "active" | "stale" | "error" | "pending";
  isStale?: boolean;
  totalJobsIndexed: number;
  processedCount: number;
  currentChunkDate: string | null;
  lastAttemptedAt: string | null;
  lastActivityAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  source?: "protractor" | "tekmetric";
}

interface Shop {
  _id: string;
  shopId: number | string;
  name: string;
  locationIdentifier?: string | null;
  enterpriseId?: string | null;
  enterpriseName?: string | null;
  createdAt: string;
  userCount: number;
  vehicleCount: number;
  integrations: string[];
  billing: ShopBilling;
  isLocked?: boolean;
  integrationDetails?: IntegrationDetails;
  enabledFeatures?: ShopFeatures | string[];
  backfill?: BackfillStatus | null;
  stickerCount?: number;
  stickerCountThisMonth?: number;
}

export default function PlatformShopsPage() {
  const [shops, setShops] = useState<Shop[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [impersonating, setImpersonating] = useState<number | null>(null);
  const [defaultVinLimit, setDefaultVinLimit] = useState(10);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [selectedShop, setSelectedShop] = useState<Shop | null>(null);
  const [vinInput, setVinInput] = useState("");
  const [modalAction, setModalAction] = useState<"setLimit" | "addViews" | "resetLimit" | "manageFeatures" | null>(null);
  const [expandedShop, setExpandedShop] = useState<string | null>(null);
  const [featureEdits, setFeatureEdits] = useState<ShopFeatures>({});
  const [billingEdits, setBillingEdits] = useState<{ plan: string; status: string }>({ plan: "trial", status: "trial" });
  const [groupByEnterprise, setGroupByEnterprise] = useState(false);

  const accessShop = async (shopId: number | string) => {
    if (impersonating) return;
    setImpersonating(typeof shopId === 'number' ? shopId : -1);
    try {
      const res = await fetch("/api/platform-admin/impersonate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shopId }),
      });
      const data = await res.json();
      if (res.ok) {
        window.location.href = "/dashboard";
      } else {
        alert(data.error || "Failed to access shop");
      }
    } catch (err) {
      console.error("Error accessing shop:", err);
      alert("Failed to access shop");
    } finally {
      setImpersonating(null);
    }
  };

  const vinAction = async (shopId: number | string, action: string, value?: number) => {
    setActionLoading(`${shopId}-${action}`);
    try {
      const res = await fetch(`/api/platform-admin/shops/${shopId}/vins`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, value }),
      });
      const data = await res.json();
      if (data.ok) {
        loadShops();
        setSelectedShop(null);
        setModalAction(null);
        setVinInput("");
      } else {
        alert(data.error || "Action failed");
      }
    } catch (err) {
      console.error("VIN action error:", err);
      alert("Action failed");
    } finally {
      setActionLoading(null);
    }
  };

  const toggleLock = async (shopId: number | string, isLocked: boolean) => {
    const action = isLocked ? "unlock" : "lock";
    setActionLoading(`${shopId}-${action}`);
    try {
      const res = await fetch(`/api/platform-admin/shops/${shopId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (data.ok) {
        loadShops();
      } else {
        alert(data.error || "Action failed");
      }
    } catch (err) {
      console.error("Lock/unlock error:", err);
      alert("Action failed");
    } finally {
      setActionLoading(null);
    }
  };

  const updateShopSettings = async (shopId: number | string, billing?: { plan: string; status: string }, features?: ShopFeatures) => {
    setActionLoading(`${shopId}-settings`);
    try {
      const res = await fetch(`/api/platform-admin/shops/${shopId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ billing, features }),
      });
      const data = await res.json();
      if (data.ok) {
        loadShops();
        setSelectedShop(null);
        setModalAction(null);
      } else {
        alert(data.error || "Update failed");
      }
    } catch (err) {
      console.error("Update shop settings error:", err);
      alert("Update failed");
    } finally {
      setActionLoading(null);
    }
  };

  const triggerBackfill = async (shopId: number | string, action: "resume" | "reset") => {
    const numericShopId = typeof shopId === 'string' ? parseInt(shopId) : shopId;
    setActionLoading(`${shopId}-backfill`);
    try {
      const res = await fetch("/api/platform-admin/backfill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shopId: numericShopId, action }),
      });
      const data = await res.json();
      if (data.ok) {
        alert(data.message);
        loadShops();
      } else {
        alert(data.error || "Backfill action failed");
      }
    } catch (err) {
      console.error("Backfill error:", err);
      alert("Backfill action failed");
    } finally {
      setActionLoading(null);
    }
  };

  const openFeatureModal = (shop: Shop) => {
    setSelectedShop(shop);
    
    // Convert enabledFeatures to object format if it's an array
    let features: ShopFeatures = {};
    if (Array.isArray(shop.enabledFeatures)) {
      // Convert array format to object format
      shop.enabledFeatures.forEach((f: string) => {
        features[f as keyof ShopFeatures] = true;
      });
    } else if (shop.enabledFeatures && typeof shop.enabledFeatures === 'object') {
      features = shop.enabledFeatures;
    }
    
    setFeatureEdits(features);
    setBillingEdits({ 
      plan: shop.billing.plan || "trial", 
      status: shop.billing.status || "trial" 
    });
    setVinInput(String(shop.billing.vinLimit || 10));
    setModalAction("manageFeatures");
  };

  const deleteShop = async (shop: Shop) => {
    if (!confirm(`Are you sure you want to PERMANENTLY DELETE "${shop.name}"?\n\nThis will remove:\n- The shop\n- All users\n- All sessions\n\nThis action cannot be undone!`)) {
      return;
    }
    setActionLoading(`${shop.shopId}-delete`);
    try {
      const res = await fetch(`/api/platform-admin/shops/${shop.shopId}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (data.ok) {
        loadShops();
      } else {
        alert(data.error || "Delete failed");
      }
    } catch (err) {
      console.error("Delete error:", err);
      alert("Delete failed");
    } finally {
      setActionLoading(null);
    }
  };

  useEffect(() => {
    loadShops();
  }, []);

  const loadShops = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/platform-admin/shops");
      const data = await res.json();
      if (data.ok) {
        setShops(data.shops || []);
        setDefaultVinLimit(data.defaultVinLimit || 10);
      }
    } catch (err) {
      console.error("Error loading shops:", err);
    } finally {
      setLoading(false);
    }
  };

  const searchLower = search.toLowerCase();
  const filteredShops = shops.filter(shop => 
    shop.name?.toLowerCase().includes(searchLower) ||
    (shop.locationIdentifier && shop.locationIdentifier.toLowerCase().includes(searchLower)) ||
    (shop.enterpriseName && shop.enterpriseName.toLowerCase().includes(searchLower)) ||
    String(shop.shopId).includes(search)
  );
  
  // Group shops by enterprise if enabled
  const groupedShops = groupByEnterprise 
    ? (() => {
        const groups: { enterprise: string | null; shops: Shop[] }[] = [];
        const enterpriseMap = new Map<string | null, Shop[]>();
        
        filteredShops.forEach(shop => {
          const key = shop.enterpriseId || null;
          if (!enterpriseMap.has(key)) {
            enterpriseMap.set(key, []);
          }
          enterpriseMap.get(key)!.push(shop);
        });
        
        // Sort: enterprises first (alphabetically), then standalone shops
        const enterpriseKeys = Array.from(enterpriseMap.keys()).sort((a, b) => {
          if (a === null) return 1;
          if (b === null) return -1;
          const nameA = enterpriseMap.get(a)?.[0]?.enterpriseName || '';
          const nameB = enterpriseMap.get(b)?.[0]?.enterpriseName || '';
          return nameA.localeCompare(nameB);
        });
        
        enterpriseKeys.forEach(key => {
          const shopsInGroup = enterpriseMap.get(key)!;
          groups.push({
            enterprise: key ? (shopsInGroup[0]?.enterpriseName || `Enterprise ${key}`) : null,
            shops: shopsInGroup.sort((a, b) => (a.locationIdentifier || a.name).localeCompare(b.locationIdentifier || b.name))
          });
        });
        
        return groups;
      })()
    : null;

  if (loading) {
    return (
      <div className="p-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-1/4"></div>
          <div className="h-64 bg-gray-200 rounded-lg"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">All Shops</h1>
          <p className="text-gray-600">Manage all client shops on the platform</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={async () => {
              if (!confirm("Resume backfill for all shops that haven't completed? This will restart any stalled backfills.")) return;
              setActionLoading("resume-all");
              try {
                const res = await fetch("/api/platform-admin/backfill", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ action: "resume_all_incomplete" }),
                });
                const data = await res.json();
                if (data.ok) {
                  alert(`Resumed backfill for ${data.shopIds?.length || 0} shops`);
                  loadShops();
                } else {
                  alert(data.error || "Failed to resume backfills");
                }
              } catch (err) {
                console.error("Resume all error:", err);
                alert("Failed to resume backfills");
              } finally {
                setActionLoading(null);
              }
            }}
            disabled={actionLoading === "resume-all"}
            className="flex items-center gap-2 px-3 py-2 text-sm bg-orange-100 text-orange-700 hover:bg-orange-200 rounded-lg disabled:opacity-50"
          >
            {actionLoading === "resume-all" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            Resume All Incomplete
          </button>
          <button
            onClick={loadShops}
            className="p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg"
          >
            <RefreshCw className="w-5 h-5" />
          </button>
        </div>
      </div>

      <div className="flex gap-4 items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
          <input
            type="text"
            placeholder="Search shops by name, location, or ID..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] focus:border-transparent"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-600 whitespace-nowrap cursor-pointer">
          <input
            type="checkbox"
            checked={groupByEnterprise}
            onChange={(e) => setGroupByEnterprise(e.target.checked)}
            className="w-4 h-4 text-[#3c81c3] rounded border-gray-300 focus:ring-[#3c81c3]"
          />
          Group by Enterprise
        </label>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-auto">
        <table className="w-full min-w-[1000px]">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">Shop</th>
              <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">ID</th>
              <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">Users</th>
              <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">Vehicles</th>
              <th className="text-center px-4 py-3 text-sm font-medium text-gray-600">VIN Usage</th>
              <th className="text-center px-4 py-3 text-sm font-medium text-gray-600">Stickers</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">Integrations</th>
              <th className="text-center px-4 py-3 text-sm font-medium text-gray-600">Backfill</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">Created</th>
              <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filteredShops.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-gray-500">
                  {search ? "No shops match your search" : "No shops yet"}
                </td>
              </tr>
            ) : groupByEnterprise && groupedShops ? (
              groupedShops.flatMap((group, groupIndex) => [
                <tr key={`group-${groupIndex}`} className="bg-gray-100">
                  <td colSpan={9} className="px-4 py-2">
                    <div className="flex items-center gap-2 font-medium text-gray-700">
                      <Building2 className="w-4 h-4" />
                      {group.enterprise || "Standalone Shops"}
                      <span className="text-xs text-gray-500 font-normal">({group.shops.length} location{group.shops.length !== 1 ? 's' : ''})</span>
                    </div>
                  </td>
                </tr>,
                ...group.shops.flatMap((shop) => [
                <tr key={`${shop._id}-row`} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${shop.isLocked ? "bg-red-100" : shop.enterpriseId ? "bg-blue-100" : "bg-[rgba(60,129,195,0.15)]"}`}>
                        {shop.isLocked ? (
                          <Lock className="w-4 h-4 text-red-600" />
                        ) : (
                          <Building2 className={`w-4 h-4 ${shop.enterpriseId ? "text-blue-600" : "text-[#3c81c3]"}`} />
                        )}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className={`font-medium ${shop.isLocked ? "text-red-700" : "text-gray-900"}`}>{shop.name}</span>
                          {shop.locationIdentifier && (
                            <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 text-xs rounded">{shop.locationIdentifier}</span>
                          )}
                          {shop.isLocked && (
                            <span className="px-1.5 py-0.5 bg-red-100 text-red-700 text-xs rounded">Locked</span>
                          )}
                          {shop.billing.plan === "demo" ? (
                            <span className="px-1.5 py-0.5 bg-[rgba(60,129,195,0.15)] text-[#3c81c3] text-xs rounded">Demo</span>
                          ) : shop.billing.plan === "enterprise" ? (
                            <span className="px-1.5 py-0.5 bg-indigo-100 text-indigo-700 text-xs rounded">Enterprise</span>
                          ) : shop.billing.plan === "professional" ? (
                            <span className="px-1.5 py-0.5 bg-green-100 text-green-700 text-xs rounded">Pro</span>
                          ) : shop.billing.plan === "starter" ? (
                            <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 text-xs rounded">Starter</span>
                          ) : (
                            <span className="px-1.5 py-0.5 bg-gray-100 text-gray-600 text-xs rounded">Trial</span>
                          )}
                        </div>
                        {shop.enterpriseName && !groupByEnterprise && (
                          <div className="text-xs text-gray-500">{shop.enterpriseName}</div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right text-gray-600">{shop.shopId}</td>
                  <td className="px-4 py-3 text-right text-gray-900">{shop.userCount}</td>
                  <td className="px-4 py-3 text-right text-gray-900">{shop.vehicleCount}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-center gap-2">
                      <div className="text-center">
                        <div className={`text-sm font-medium ${shop.billing.vinViewCount >= shop.billing.vinLimit ? "text-red-600" : shop.billing.isPaid ? "text-green-600" : "text-gray-900"}`}>
                          {shop.billing.vinViewCount} / {shop.billing.vinLimit}
                          {shop.billing.isPaid && <span className="ml-1 text-green-500 text-xs">(Paid)</span>}
                        </div>
                        <div className="w-24 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                          <div 
                            className={`h-full transition-all ${shop.billing.vinViewCount >= shop.billing.vinLimit ? "bg-red-500" : shop.billing.isPaid ? "bg-green-500" : "bg-[#3c81c3]"}`}
                            style={{ width: `${Math.min(100, (shop.billing.vinViewCount / shop.billing.vinLimit) * 100)}%` }}
                          />
                        </div>
                      </div>
                      <div className="flex gap-0.5">
                        <button
                          onClick={() => { setSelectedShop(shop); setModalAction("addViews"); setVinInput("10"); }}
                          title="Add VINs"
                          className="p-1 text-green-600 hover:bg-green-50 rounded"
                        >
                          <Plus className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => { setSelectedShop(shop); setModalAction("setLimit"); setVinInput(String(shop.billing.vinLimit)); }}
                          title="Set Custom Limit"
                          className="p-1 text-blue-600 hover:bg-blue-50 rounded"
                        >
                          <Settings className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => { setSelectedShop(shop); setModalAction("resetLimit"); }}
                          title="Reset to Default Limit"
                          className="p-1 text-gray-500 hover:bg-gray-50 rounded"
                        >
                          <X className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => { if(confirm(`Reset all viewed VINs for ${shop.name}? This will start their trial fresh.`)) vinAction(shop.shopId, "resetViews"); }}
                            title="Reset Viewed VINs (Start Fresh)"
                            disabled={actionLoading === `${shop.shopId}-resetViews`}
                            className="p-1 text-orange-600 hover:bg-orange-50 rounded disabled:opacity-50"
                          >
                            {actionLoading === `${shop.shopId}-resetViews` ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <RotateCcw className="w-4 h-4" />
                            )}
                          </button>
                        </div>
                      </div>
                    </td>
                  <td className="px-4 py-3 text-center">
                    <div className="text-sm">
                      <span className="font-medium text-gray-900">{shop.stickerCountThisMonth || 0}</span>
                      <span className="text-gray-400 text-xs ml-1">/ {shop.stickerCount || 0}</span>
                    </div>
                    <div className="text-xs text-gray-500">this month / total</div>
                  </td>
                  <td className="px-4 py-3">
                    {shop.integrations?.length > 0 ? (
                      <button
                        onClick={() => setExpandedShop(expandedShop === shop._id ? null : shop._id)}
                        className="flex items-center gap-1 text-left hover:bg-gray-50 rounded px-1 -mx-1"
                      >
                        <div className="flex gap-1 flex-wrap items-center">
                          {shop.integrations.map(int => {
                            const iconMap: Record<string, string> = {
                              "Protractor": "/protractor-icon.png",
                              "Tekmetric": "/tekmetric-logo.png",
                              "CARFAX": "/icons/carfax.png",
                              "AutoFlow": "/icons/autoflow.png",
                            };
                            const icon = iconMap[int];
                            return icon ? (
                              <img 
                                key={int}
                                src={icon}
                                alt={int}
                                title={int}
                                className="w-6 h-6 rounded object-contain"
                              />
                            ) : (
                              <span key={int} className={`px-2 py-0.5 text-xs rounded font-medium ${
                                int === "AutoVitals" ? "bg-orange-100 text-orange-700" : "bg-gray-100 text-gray-700"
                              }`}>
                                {int}
                              </span>
                            );
                          })}
                        </div>
                        {expandedShop === shop._id ? (
                          <ChevronUp className="w-4 h-4 text-gray-400 flex-shrink-0" />
                        ) : (
                          <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />
                        )}
                      </button>
                    ) : (
                      <span className="text-gray-400 text-sm">None</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {shop.backfill ? (
                      shop.backfill.status === "completed" ? (
                        <div className="flex items-center justify-center gap-1" title={`Completed: ${shop.backfill.totalJobsIndexed.toLocaleString()} jobs indexed (${shop.backfill.source || 'unknown'})`}>
                          <CheckCircle2 className="w-4 h-4 text-green-600" />
                          <span className="text-xs text-green-600">{shop.backfill.totalJobsIndexed.toLocaleString()}</span>
                        </div>
                      ) : shop.backfill.status === "active" ? (
                        <div className="flex items-center justify-center gap-1" title={`Active: ${shop.backfill.processedCount.toLocaleString()} WOs processed, ${shop.backfill.totalJobsIndexed.toLocaleString()} jobs indexed. Processing: ${shop.backfill.currentChunkDate ? new Date(shop.backfill.currentChunkDate).toLocaleDateString() : 'starting'}. Last activity: ${shop.backfill.lastActivityAt ? new Date(shop.backfill.lastActivityAt).toLocaleTimeString() : 'unknown'}`}>
                          <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />
                          <span className="text-xs text-blue-600">{shop.backfill.totalJobsIndexed.toLocaleString()}</span>
                        </div>
                      ) : shop.backfill.status === "stale" ? (
                        <div className="flex items-center justify-center gap-1" title={`Stale (no activity in 5+ min): ${shop.backfill.processedCount.toLocaleString()} WOs processed, ${shop.backfill.totalJobsIndexed.toLocaleString()} jobs indexed. Last activity: ${shop.backfill.lastActivityAt ? new Date(shop.backfill.lastActivityAt).toLocaleString() : 'unknown'}`}>
                          <AlertCircle className="w-4 h-4 text-orange-500" />
                          <span className="text-xs text-orange-600">{shop.backfill.totalJobsIndexed.toLocaleString()}</span>
                        </div>
                      ) : shop.backfill.status === "error" ? (
                        <div className="flex items-center justify-center gap-1" title={`Error: ${shop.backfill.lastError || 'Unknown error'}. Last run: ${shop.backfill.lastErrorAt ? new Date(shop.backfill.lastErrorAt).toLocaleString() : 'unknown'}`}>
                          <XCircle className="w-4 h-4 text-red-500" />
                          <span className="text-xs text-red-600">{shop.backfill.totalJobsIndexed.toLocaleString()}</span>
                        </div>
                      ) : (
                        <div className="flex items-center justify-center gap-1" title={`Pending: ${shop.backfill.processedCount.toLocaleString()} WOs processed, ${shop.backfill.totalJobsIndexed.toLocaleString()} jobs indexed. Last run: ${shop.backfill.lastAttemptedAt ? new Date(shop.backfill.lastAttemptedAt).toLocaleString() : 'never'}`}>
                          <Pause className="w-4 h-4 text-amber-500" />
                          <span className="text-xs text-amber-600">{shop.backfill.totalJobsIndexed.toLocaleString()}</span>
                        </div>
                      )
                    ) : (
                      <span className="text-gray-300">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-600 text-sm">
                    {new Date(shop.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => openFeatureModal(shop)}
                        disabled={actionLoading !== null}
                        title="Manage billing & features"
                        className="p-1.5 text-[#3c81c3] hover:bg-[rgba(60,129,195,0.1)] rounded-lg transition-colors disabled:opacity-50"
                      >
                        <Settings className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => toggleLock(shop.shopId, !!shop.isLocked)}
                        disabled={actionLoading !== null}
                        title={shop.isLocked ? "Unlock shop" : "Lock shop"}
                        className={`p-1.5 rounded-lg transition-colors disabled:opacity-50 ${
                          shop.isLocked 
                            ? "text-green-600 hover:bg-green-50" 
                            : "text-orange-600 hover:bg-orange-50"
                        }`}
                      >
                        {actionLoading === `${shop.shopId}-lock` || actionLoading === `${shop.shopId}-unlock` ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : shop.isLocked ? (
                          <Unlock className="w-4 h-4" />
                        ) : (
                          <Lock className="w-4 h-4" />
                        )}
                      </button>
                      <button
                        onClick={() => deleteShop(shop)}
                        disabled={actionLoading !== null}
                        title="Delete shop permanently"
                        className="p-1.5 text-red-600 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50"
                      >
                        {actionLoading === `${shop.shopId}-delete` ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Trash2 className="w-4 h-4" />
                        )}
                      </button>
                      <button
                        onClick={() => accessShop(shop.shopId)}
                        disabled={impersonating !== null || shop.isLocked}
                        title={shop.isLocked ? "Shop is locked" : "Access this shop"}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[rgba(60,129,195,0.75)] text-white text-sm font-medium rounded-lg hover:bg-[#3c81c3] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        {impersonating === shop.shopId ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <LogIn className="w-4 h-4" />
                        )}
                        Access
                      </button>
                    </div>
                  </td>
                </tr>,
                expandedShop === shop._id && shop.integrationDetails ? (
                  <tr key={`${shop._id}-expanded`} className="bg-blue-50">
                    <td colSpan={9} className="px-4 py-4">
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        {shop.integrationDetails.protractor && (
                          <div className="bg-white rounded-lg p-4 border border-blue-200">
                            <div className="flex items-center gap-2 mb-3">
                              <span className="px-2 py-0.5 bg-blue-100 text-blue-700 text-xs rounded font-medium">Protractor</span>
                              <span className="text-xs text-gray-500">
                                Connected {new Date(shop.integrationDetails.protractor.configuredAt).toLocaleDateString()}
                              </span>
                            </div>
                            {shop.integrationDetails.protractor.locationName && (
                              <div className="font-medium text-gray-900 mb-2">
                                {shop.integrationDetails.protractor.locationName}
                                {shop.integrationDetails.protractor.shortName && (
                                  <span className="text-gray-500 font-normal"> ({shop.integrationDetails.protractor.shortName})</span>
                                )}
                              </div>
                            )}
                            {shop.integrationDetails.protractor.address && (
                              <div className="flex items-start gap-2 text-sm text-gray-600 mb-1">
                                <MapPin className="w-4 h-4 mt-0.5 flex-shrink-0" />
                                <span>{shop.integrationDetails.protractor.address}</span>
                              </div>
                            )}
                            {shop.integrationDetails.protractor.phone && (
                              <div className="flex items-center gap-2 text-sm text-gray-600 mb-1">
                                <Phone className="w-4 h-4 flex-shrink-0" />
                                <span>{shop.integrationDetails.protractor.phone}</span>
                              </div>
                            )}
                            {shop.integrationDetails.protractor.timeZone && (
                              <div className="flex items-center gap-2 text-sm text-gray-600">
                                <Clock className="w-4 h-4 flex-shrink-0" />
                                <span>{shop.integrationDetails.protractor.timeZone}</span>
                              </div>
                            )}
                          </div>
                        )}
                        {shop.integrationDetails.carfax && (
                          <div className="bg-white rounded-lg p-4 border border-blue-200">
                            <div className="flex items-center gap-2 mb-3">
                              <span className="px-2 py-0.5 bg-red-100 text-red-700 text-xs rounded font-medium">CARFAX</span>
                            </div>
                            <div className="text-sm text-gray-600">
                              <span className="font-medium">Location ID:</span> {shop.integrationDetails.carfax.locationId}
                            </div>
                          </div>
                        )}
                        {shop.integrationDetails.tekmetric && (
                          <div className="bg-white rounded-lg p-4 border border-blue-200">
                            <div className="flex items-center gap-2 mb-3">
                              <span className="px-2 py-0.5 bg-green-100 text-green-700 text-xs rounded font-medium">Tekmetric</span>
                            </div>
                            <div className="text-sm text-gray-600">
                              <span className="font-medium">Shop ID:</span> {shop.integrationDetails.tekmetric.shopId}
                            </div>
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                ) : null,
              ])
              ])
            ) : (
              filteredShops.flatMap((shop) => [
                <tr key={`${shop._id}-row-flat`} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${shop.isLocked ? "bg-red-100" : shop.enterpriseId ? "bg-blue-100" : "bg-[rgba(60,129,195,0.15)]"}`}>
                        {shop.isLocked ? (
                          <Lock className="w-4 h-4 text-red-600" />
                        ) : (
                          <Building2 className={`w-4 h-4 ${shop.enterpriseId ? "text-blue-600" : "text-[#3c81c3]"}`} />
                        )}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className={`font-medium ${shop.isLocked ? "text-red-700" : "text-gray-900"}`}>{shop.name}</span>
                          {shop.locationIdentifier && (
                            <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 text-xs rounded">{shop.locationIdentifier}</span>
                          )}
                          {shop.isLocked && (
                            <span className="px-1.5 py-0.5 bg-red-100 text-red-700 text-xs rounded">Locked</span>
                          )}
                          {shop.billing.plan === "demo" ? (
                            <span className="px-1.5 py-0.5 bg-[rgba(60,129,195,0.15)] text-[#3c81c3] text-xs rounded">Demo</span>
                          ) : shop.billing.plan === "enterprise" ? (
                            <span className="px-1.5 py-0.5 bg-indigo-100 text-indigo-700 text-xs rounded">Enterprise</span>
                          ) : shop.billing.plan === "professional" ? (
                            <span className="px-1.5 py-0.5 bg-green-100 text-green-700 text-xs rounded">Pro</span>
                          ) : shop.billing.plan === "starter" ? (
                            <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 text-xs rounded">Starter</span>
                          ) : (
                            <span className="px-1.5 py-0.5 bg-gray-100 text-gray-600 text-xs rounded">Trial</span>
                          )}
                        </div>
                        {shop.enterpriseName && (
                          <div className="text-xs text-gray-500">{shop.enterpriseName}</div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right text-gray-600">{shop.shopId}</td>
                  <td className="px-4 py-3 text-right text-gray-900">{shop.userCount}</td>
                  <td className="px-4 py-3 text-right text-gray-900">{shop.vehicleCount}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-center gap-2">
                      <div className="text-center">
                        <div className={`text-sm font-medium ${shop.billing.vinViewCount >= shop.billing.vinLimit ? "text-red-600" : shop.billing.isPaid ? "text-green-600" : "text-gray-900"}`}>
                          {shop.billing.vinViewCount} / {shop.billing.vinLimit}
                          {shop.billing.isPaid && <span className="ml-1 text-green-500 text-xs">(Paid)</span>}
                        </div>
                        <div className="w-24 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                          <div 
                            className={`h-full transition-all ${shop.billing.vinViewCount >= shop.billing.vinLimit ? "bg-red-500" : shop.billing.isPaid ? "bg-green-500" : "bg-[#3c81c3]"}`}
                            style={{ width: `${Math.min(100, (shop.billing.vinViewCount / shop.billing.vinLimit) * 100)}%` }}
                          />
                        </div>
                      </div>
                      <div className="flex gap-0.5">
                        <button
                          onClick={() => { setSelectedShop(shop); setModalAction("addViews"); setVinInput("10"); }}
                          title="Add VINs"
                          className="p-1 text-green-600 hover:bg-green-50 rounded"
                        >
                          <Plus className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => { setSelectedShop(shop); setModalAction("setLimit"); setVinInput(String(shop.billing.vinLimit)); }}
                          title="Set Custom Limit"
                          className="p-1 text-blue-600 hover:bg-blue-50 rounded"
                        >
                          <Settings className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => { setSelectedShop(shop); setModalAction("resetLimit"); }}
                          title="Reset to Default"
                          className="p-1 text-orange-600 hover:bg-orange-50 rounded"
                        >
                          <RotateCcw className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <div className="text-sm">
                      <span className="font-medium text-gray-900">{shop.stickerCountThisMonth || 0}</span>
                      <span className="text-gray-400 text-xs ml-1">/ {shop.stickerCount || 0}</span>
                    </div>
                    <div className="text-xs text-gray-500">this month / total</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-1">
                      {shop.integrations.map(int => {
                        const iconMap: Record<string, string> = {
                          "Protractor": "/protractor-icon.png",
                          "Tekmetric": "/tekmetric-logo.png",
                          "CARFAX": "/icons/carfax.png",
                          "AutoFlow": "/icons/autoflow.png",
                        };
                        const icon = iconMap[int];
                        return icon ? (
                          <img 
                            key={int}
                            src={icon}
                            alt={int}
                            title={int}
                            onClick={shop.integrationDetails ? () => setExpandedShop(expandedShop === shop._id ? null : shop._id) : undefined}
                            className={`w-6 h-6 rounded object-contain ${shop.integrationDetails ? "cursor-pointer hover:opacity-80" : ""}`}
                          />
                        ) : (
                          <span 
                            key={int} 
                            onClick={shop.integrationDetails ? () => setExpandedShop(expandedShop === shop._id ? null : shop._id) : undefined}
                            className={`px-2 py-0.5 text-xs rounded ${
                              int === "AutoVitals" ? "bg-orange-100 text-orange-700" :
                              "bg-gray-100 text-gray-700"
                            } ${shop.integrationDetails ? "cursor-pointer hover:opacity-80" : ""}`}
                          >
                            {int}
                          </span>
                        );
                      })}
                      {shop.integrations.length === 0 && (
                        <span className="text-gray-400 text-sm">None</span>
                      )}
                      {shop.integrationDetails && (
                        <button
                          onClick={() => setExpandedShop(expandedShop === shop._id ? null : shop._id)}
                          className="p-0.5 text-gray-400 hover:text-gray-600"
                        >
                          {expandedShop === shop._id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                        </button>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-center">
                    {shop.backfill ? (
                      shop.backfill.status === "completed" ? (
                        <div className="flex items-center justify-center gap-1 text-green-600" title={`Completed: ${shop.backfill.totalJobsIndexed.toLocaleString()} jobs indexed (${shop.backfill.source || 'unknown'})`}>
                          <CheckCircle2 className="w-4 h-4" />
                          <span className="text-xs">{shop.backfill.totalJobsIndexed.toLocaleString()}</span>
                        </div>
                      ) : shop.backfill.status === "active" ? (
                        <div className="flex items-center justify-center gap-1 text-blue-600" title={`Active: ${shop.backfill.processedCount.toLocaleString()} WOs processed, ${shop.backfill.totalJobsIndexed.toLocaleString()} jobs indexed. Processing: ${shop.backfill.currentChunkDate ? new Date(shop.backfill.currentChunkDate).toLocaleDateString() : 'starting'}. Last activity: ${shop.backfill.lastActivityAt ? new Date(shop.backfill.lastActivityAt).toLocaleTimeString() : 'unknown'}`}>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          <span className="text-xs">{shop.backfill.totalJobsIndexed.toLocaleString()}</span>
                        </div>
                      ) : shop.backfill.status === "stale" ? (
                        <div className="flex items-center justify-center gap-1 text-orange-600" title={`Stale (no activity in 5+ min): ${shop.backfill.processedCount.toLocaleString()} WOs processed, ${shop.backfill.totalJobsIndexed.toLocaleString()} jobs indexed. Last activity: ${shop.backfill.lastActivityAt ? new Date(shop.backfill.lastActivityAt).toLocaleString() : 'unknown'}`}>
                          <AlertCircle className="w-4 h-4" />
                          <span className="text-xs">{shop.backfill.totalJobsIndexed.toLocaleString()}</span>
                        </div>
                      ) : shop.backfill.status === "error" ? (
                        <div className="flex items-center justify-center gap-1 text-red-600" title={`Error: ${shop.backfill.lastError || 'Unknown error'}. Last run: ${shop.backfill.lastErrorAt ? new Date(shop.backfill.lastErrorAt).toLocaleString() : 'unknown'}`}>
                          <XCircle className="w-4 h-4" />
                          <span className="text-xs">{shop.backfill.totalJobsIndexed.toLocaleString()}</span>
                        </div>
                      ) : (
                        <div className="flex items-center justify-center gap-1 text-amber-600" title={`Pending: ${shop.backfill.processedCount.toLocaleString()} WOs processed, ${shop.backfill.totalJobsIndexed.toLocaleString()} jobs indexed. Last run: ${shop.backfill.lastAttemptedAt ? new Date(shop.backfill.lastAttemptedAt).toLocaleString() : 'never'}`}>
                          <Pause className="w-4 h-4" />
                          <span className="text-xs">{shop.backfill.totalJobsIndexed.toLocaleString()}</span>
                        </div>
                      )
                    ) : (
                      <span className="text-gray-300">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-600 text-sm">
                    {new Date(shop.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => openFeatureModal(shop)}
                        disabled={actionLoading !== null}
                        title="Manage billing & features"
                        className="p-1.5 text-[#3c81c3] hover:bg-[rgba(60,129,195,0.1)] rounded-lg transition-colors disabled:opacity-50"
                      >
                        <Settings className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => toggleLock(shop.shopId, !!shop.isLocked)}
                        disabled={actionLoading !== null}
                        title={shop.isLocked ? "Unlock shop" : "Lock shop"}
                        className={`p-1.5 rounded-lg transition-colors disabled:opacity-50 ${
                          shop.isLocked 
                            ? "text-green-600 hover:bg-green-50" 
                            : "text-orange-600 hover:bg-orange-50"
                        }`}
                      >
                        {actionLoading === `${shop.shopId}-lock` || actionLoading === `${shop.shopId}-unlock` ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : shop.isLocked ? (
                          <Unlock className="w-4 h-4" />
                        ) : (
                          <Lock className="w-4 h-4" />
                        )}
                      </button>
                      <button
                        onClick={() => deleteShop(shop)}
                        disabled={actionLoading !== null}
                        title="Delete shop permanently"
                        className="p-1.5 text-red-600 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50"
                      >
                        {actionLoading === `${shop.shopId}-delete` ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Trash2 className="w-4 h-4" />
                        )}
                      </button>
                      <button
                        onClick={() => accessShop(shop.shopId)}
                        disabled={impersonating !== null || shop.isLocked}
                        title={shop.isLocked ? "Shop is locked" : "Access this shop"}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[rgba(60,129,195,0.75)] text-white text-sm font-medium rounded-lg hover:bg-[#3c81c3] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        {impersonating === shop.shopId ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <LogIn className="w-4 h-4" />
                        )}
                        Access
                      </button>
                    </div>
                  </td>
                </tr>,
              ])
            )}
          </tbody>
        </table>
      </div>

      <div className="text-sm text-gray-500">
        Showing {filteredShops.length} of {shops.length} shops | Default trial limit: {defaultVinLimit} VINs
      </div>

      {selectedShop && modalAction && modalAction !== "manageFeatures" && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => { setSelectedShop(null); setModalAction(null); }}>
          <div className="bg-white rounded-xl p-6 max-w-md w-full mx-4 shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              {modalAction === "addViews" ? "Add VINs" : modalAction === "resetLimit" ? "Reset to Default" : "Set VIN Limit"}
            </h3>
            <p className="text-sm text-gray-500 mb-4">
              {modalAction === "addViews" 
                ? `Add extra VINs to ${selectedShop.name}'s trial allowance`
                : modalAction === "resetLimit"
                ? `Reset ${selectedShop.name} to use the default trial limit (${defaultVinLimit} VINs)`
                : `Set a custom VIN limit for ${selectedShop.name}`
              }
            </p>
            {modalAction !== "resetLimit" && (
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {modalAction === "addViews" ? "VINs to add" : "New VIN limit"}
                </label>
                <input
                  type="number"
                  min="1"
                  value={vinInput}
                  onChange={(e) => setVinInput(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] focus:border-transparent"
                />
                {modalAction === "setLimit" && (
                  <p className="text-xs text-gray-500 mt-1">
                    Current: {selectedShop.billing.vinViewCount} used of {selectedShop.billing.vinLimit} limit
                  </p>
                )}
                {modalAction === "addViews" && (
                  <p className="text-xs text-gray-500 mt-1">
                    Will increase limit from {selectedShop.billing.vinLimit} to {selectedShop.billing.vinLimit + (Number(vinInput) || 0)}
                  </p>
                )}
              </div>
            )}
            {modalAction === "resetLimit" && (
              <div className="mb-4 p-3 bg-orange-50 border border-orange-200 rounded-lg">
                <p className="text-sm text-orange-800">
                  This will remove any custom VIN limit and revert to the platform default of {defaultVinLimit} VINs.
                </p>
              </div>
            )}
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => { setSelectedShop(null); setModalAction(null); }}
                className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={() => vinAction(selectedShop.shopId, modalAction, modalAction === "resetLimit" ? undefined : Number(vinInput))}
                disabled={(modalAction !== "resetLimit" && (!vinInput || Number(vinInput) < 1)) || actionLoading !== null}
                className="px-4 py-2 bg-[rgba(60,129,195,0.75)] text-white rounded-lg hover:bg-[#3c81c3] disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {actionLoading && (
                  <Loader2 className="w-4 h-4 animate-spin" />
                )}
                {modalAction === "addViews" ? "Add VINs" : modalAction === "resetLimit" ? "Reset to Default" : "Set Limit"}
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedShop && modalAction === "manageFeatures" && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => { setSelectedShop(null); setModalAction(null); }}>
          <div className="bg-white rounded-xl p-6 max-w-lg w-full mx-4 shadow-xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 mb-1">Manage Shop Settings</h3>
            <p className="text-sm text-gray-500 mb-4">{selectedShop.name} (ID: {selectedShop.shopId})</p>
            
            <div className="space-y-6">
              <div>
                <h4 className="text-sm font-medium text-gray-900 mb-3">Billing Plan</h4>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Plan</label>
                    <select
                      value={billingEdits.plan}
                      onChange={(e) => {
                        const newPlan = e.target.value;
                        setBillingEdits({ ...billingEdits, plan: newPlan });
                        if (newPlan === "demo") {
                          setVinInput("999999");
                          setFeatureEdits({
                            maintenance: true,
                            job_lookup: true,
                            common_failures: true,
                            oil_sticker: true,
                            keytags: true,
                            auto_booking: true,
                            part_xref: true,
                          });
                        }
                      }}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] text-sm"
                    >
                      <option value="trial">Trial</option>
                      <option value="starter">Starter</option>
                      <option value="professional">Professional</option>
                      <option value="enterprise">Enterprise</option>
                      <option value="demo">Demo</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Status</label>
                    <select
                      value={billingEdits.status}
                      onChange={(e) => setBillingEdits({ ...billingEdits, status: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] text-sm"
                    >
                      <option value="trial">Trial</option>
                      <option value="active">Active</option>
                      <option value="past_due">Past Due</option>
                      <option value="canceled">Canceled</option>
                      <option value="demo">Demo</option>
                    </select>
                  </div>
                </div>
                <div className="mt-3">
                  <label className="block text-xs text-gray-500 mb-1">VIN Limit</label>
                  <input
                    type="number"
                    min="1"
                    value={vinInput}
                    onChange={(e) => setVinInput(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] text-sm"
                  />
                </div>
              </div>

              <div>
                <h4 className="text-sm font-medium text-gray-900 mb-3">Feature Toggles</h4>
                <p className="text-xs text-gray-500 mb-3">Override plan defaults. Leave unchecked to use plan defaults.</p>
                <div className="space-y-2">
                  {[
                    { key: "maintenance", label: "Maintenance Tracking", desc: "Track vehicle maintenance schedules and DVI insights" },
                    { key: "job_lookup", label: "Job Lookup", desc: "Search historical jobs with smart autocomplete" },
                    { key: "common_failures", label: "Common Failures Advisor", desc: "Predict common repairs by vehicle/mileage" },
                    { key: "oil_sticker", label: "Oil Sticker", desc: "Generate oil change reminder stickers" },
                    { key: "keytags", label: "Keytags", desc: "Print customer/vehicle info on Dymo labels" },
                    { key: "auto_booking", label: "Auto Booking", desc: "Automated appointment booking for oil changes" },
                    { key: "part_xref", label: "Part Cross-Reference", desc: "Cross-reference parts across manufacturers" },
                  ].map(feature => (
                    <label key={feature.key} className="flex items-start gap-3 p-3 border border-gray-200 rounded-lg hover:bg-gray-50 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={featureEdits[feature.key as keyof ShopFeatures] === true}
                        onChange={(e) => setFeatureEdits({ ...featureEdits, [feature.key]: e.target.checked })}
                        className="mt-0.5 w-4 h-4 text-[#3c81c3] border-gray-300 rounded focus:ring-[#3c81c3]"
                      />
                      <div>
                        <div className="font-medium text-gray-900 text-sm">{feature.label}</div>
                        <div className="text-xs text-gray-500">{feature.desc}</div>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex gap-3 justify-end mt-6 pt-4 border-t border-gray-200">
              <button
                onClick={() => { setSelectedShop(null); setModalAction(null); }}
                className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={() => updateShopSettings(
                  selectedShop.shopId, 
                  { ...billingEdits, vinLimit: Number(vinInput) } as any, 
                  featureEdits
                )}
                disabled={actionLoading !== null}
                className="px-4 py-2 bg-[rgba(60,129,195,0.75)] text-white rounded-lg hover:bg-[#3c81c3] disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {actionLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
