"use client";

import { useState, useEffect } from "react";
import { Building2, Search, RefreshCw, LogIn, Loader2, RotateCcw, Plus, Settings, X } from "lucide-react";

interface ShopBilling {
  plan: string;
  isPaid: boolean;
  vinLimit: number;
  vinViewCount: number;
}

interface Shop {
  _id: string;
  shopId: number;
  name: string;
  createdAt: string;
  userCount: number;
  vehicleCount: number;
  integrations: string[];
  billing: ShopBilling;
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
  const [modalAction, setModalAction] = useState<"setLimit" | "addViews" | "resetLimit" | null>(null);

  const accessShop = async (shopId: number) => {
    if (impersonating) return;
    setImpersonating(shopId);
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

  const vinAction = async (shopId: number, action: string, value?: number) => {
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

  const filteredShops = shops.filter(shop => 
    shop.name?.toLowerCase().includes(search.toLowerCase()) ||
    String(shop.shopId).includes(search)
  );

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
        <button
          onClick={loadShops}
          className="p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg"
        >
          <RefreshCw className="w-5 h-5" />
        </button>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
        <input
          type="text"
          placeholder="Search shops by name or ID..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
        />
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">Shop</th>
              <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">ID</th>
              <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">Users</th>
              <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">Vehicles</th>
              <th className="text-center px-4 py-3 text-sm font-medium text-gray-600">VIN Usage</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">Integrations</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">Created</th>
              <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filteredShops.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-gray-500">
                  {search ? "No shops match your search" : "No shops yet"}
                </td>
              </tr>
            ) : (
              filteredShops.map((shop) => (
                <tr key={shop._id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 bg-purple-100 rounded-lg flex items-center justify-center">
                        <Building2 className="w-4 h-4 text-purple-600" />
                      </div>
                      <div>
                        <span className="font-medium text-gray-900">{shop.name}</span>
                        {shop.billing.isPaid && (
                          <span className="ml-2 px-1.5 py-0.5 bg-green-100 text-green-700 text-xs rounded">Paid</span>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right text-gray-600">{shop.shopId}</td>
                  <td className="px-4 py-3 text-right text-gray-900">{shop.userCount}</td>
                  <td className="px-4 py-3 text-right text-gray-900">{shop.vehicleCount}</td>
                  <td className="px-4 py-3">
                    {shop.billing.isPaid ? (
                      <div className="text-center text-green-600 text-sm">Unlimited</div>
                    ) : (
                      <div className="flex items-center justify-center gap-2">
                        <div className="text-center">
                          <div className={`text-sm font-medium ${shop.billing.vinViewCount >= shop.billing.vinLimit ? "text-red-600" : "text-gray-900"}`}>
                            {shop.billing.vinViewCount} / {shop.billing.vinLimit}
                          </div>
                          <div className="w-24 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                            <div 
                              className={`h-full transition-all ${shop.billing.vinViewCount >= shop.billing.vinLimit ? "bg-red-500" : "bg-purple-500"}`}
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
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1 flex-wrap">
                      {shop.integrations?.length > 0 ? (
                        shop.integrations.map(int => (
                          <span key={int} className="px-2 py-0.5 bg-gray-100 text-gray-600 text-xs rounded">
                            {int}
                          </span>
                        ))
                      ) : (
                        <span className="text-gray-400 text-sm">None</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-600 text-sm">
                    {new Date(shop.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => accessShop(shop.shopId)}
                      disabled={impersonating !== null}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-purple-600 text-white text-sm font-medium rounded-lg hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {impersonating === shop.shopId ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <LogIn className="w-4 h-4" />
                      )}
                      Access
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="text-sm text-gray-500">
        Showing {filteredShops.length} of {shops.length} shops | Default trial limit: {defaultVinLimit} VINs
      </div>

      {selectedShop && modalAction && (
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
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
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
                className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
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
    </div>
  );
}
