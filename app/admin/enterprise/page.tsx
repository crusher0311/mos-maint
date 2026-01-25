"use client";

import { useState, useEffect } from "react";
import { Building2, TrendingUp, DollarSign, Users, Package, ChevronDown, ChevronUp, RefreshCw, Plus, Settings } from "lucide-react";
import Link from "next/link";

interface ShopAnalytics {
  shopId: number;
  shopName: string;
  jobsAdded: number;
  jobsSold: number;
  revenue: number;
  totalVehicles?: number;
  activeVehicles?: number;
}

interface EnterpriseAnalytics {
  enterprise: {
    id: string;
    name: string;
    shopCount: number;
  };
  summary: {
    totalJobsAdded: number;
    totalJobsSold: number;
    totalRevenue: number;
    avgRevenuePerShop: number;
  };
  shopBreakdown: ShopAnalytics[];
  shops: any[];
}

interface Enterprise {
  _id: string;
  name: string;
  shopIds: number[];
  createdAt: string;
}

export default function EnterpriseDashboardPage() {
  const [enterprises, setEnterprises] = useState<Enterprise[]>([]);
  const [selectedEnterprise, setSelectedEnterprise] = useState<string | null>(null);
  const [analytics, setAnalytics] = useState<EnterpriseAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newEnterpriseName, setNewEnterpriseName] = useState("");
  const [expandedShops, setExpandedShops] = useState<Set<number>>(new Set());
  const [dateRange, setDateRange] = useState<"7d" | "30d" | "90d" | "all">("30d");

  useEffect(() => {
    loadEnterprises();
  }, []);

  useEffect(() => {
    if (selectedEnterprise) {
      loadAnalytics(selectedEnterprise);
    }
  }, [selectedEnterprise, dateRange]);

  const loadEnterprises = async () => {
    try {
      const res = await fetch("/api/enterprise");
      const data = await res.json();
      setEnterprises(data.enterprises || []);
      if (data.enterprises?.length > 0 && !selectedEnterprise) {
        setSelectedEnterprise(data.enterprises[0]._id);
      }
    } catch (err) {
      console.error("Error loading enterprises:", err);
    } finally {
      setLoading(false);
    }
  };

  const loadAnalytics = async (enterpriseId: string) => {
    setAnalyticsLoading(true);
    try {
      const params = new URLSearchParams({ enterpriseId });
      
      if (dateRange !== "all") {
        const days = dateRange === "7d" ? 7 : dateRange === "30d" ? 30 : 90;
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);
        params.set("startDate", startDate.toISOString());
      }
      
      const res = await fetch(`/api/enterprise/analytics?${params}`);
      const data = await res.json();
      setAnalytics(data);
    } catch (err) {
      console.error("Error loading analytics:", err);
    } finally {
      setAnalyticsLoading(false);
    }
  };

  const createEnterprise = async () => {
    if (!newEnterpriseName.trim()) return;
    
    try {
      const res = await fetch("/api/enterprise", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newEnterpriseName.trim() })
      });
      
      if (res.ok) {
        setNewEnterpriseName("");
        setShowCreateModal(false);
        loadEnterprises();
      }
    } catch (err) {
      console.error("Error creating enterprise:", err);
    }
  };

  const toggleShopExpanded = (shopId: number) => {
    const newSet = new Set(expandedShops);
    if (newSet.has(shopId)) {
      newSet.delete(shopId);
    } else {
      newSet.add(shopId);
    }
    setExpandedShops(newSet);
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(amount);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <RefreshCw className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (enterprises.length === 0) {
    return (
      <div className="min-h-screen bg-gray-50 p-8">
        <div className="max-w-2xl mx-auto">
          <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
            <Building2 className="w-16 h-16 text-gray-300 mx-auto mb-4" />
            <h1 className="text-2xl font-bold text-gray-900 mb-2">Enterprise Dashboard</h1>
            <p className="text-gray-600 mb-6">
              No enterprise accounts found. Create one to manage multiple shop locations.
            </p>
            <button
              onClick={() => setShowCreateModal(true)}
              className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              <Plus className="w-4 h-4" />
              Create Enterprise Account
            </button>
          </div>
        </div>
        
        {showCreateModal && (
          <CreateEnterpriseModal
            name={newEnterpriseName}
            setName={setNewEnterpriseName}
            onCreate={createEnterprise}
            onClose={() => setShowCreateModal(false)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Building2 className="w-8 h-8 text-blue-600" />
              <div>
                <h1 className="text-2xl font-bold text-gray-900">Enterprise Dashboard</h1>
                <p className="text-sm text-gray-500">Multi-location analytics and configuration</p>
              </div>
            </div>
            
            <div className="flex items-center gap-4">
              <select
                value={selectedEnterprise || ""}
                onChange={(e) => setSelectedEnterprise(e.target.value)}
                className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
              >
                {enterprises.map((ent) => (
                  <option key={ent._id} value={ent._id}>
                    {ent.name} ({ent.shopIds?.length || 0} locations)
                  </option>
                ))}
              </select>
              
              <button
                onClick={() => setShowCreateModal(true)}
                className="inline-flex items-center gap-2 px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm"
              >
                <Plus className="w-4 h-4" />
                New
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            {(["7d", "30d", "90d", "all"] as const).map((range) => (
              <button
                key={range}
                onClick={() => setDateRange(range)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  dateRange === range
                    ? "bg-blue-600 text-white"
                    : "bg-white text-gray-600 border border-gray-300 hover:bg-gray-50"
                }`}
              >
                {range === "7d" ? "7 Days" : range === "30d" ? "30 Days" : range === "90d" ? "90 Days" : "All Time"}
              </button>
            ))}
          </div>
          
          <button
            onClick={() => selectedEnterprise && loadAnalytics(selectedEnterprise)}
            disabled={analyticsLoading}
            className="inline-flex items-center gap-2 px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900"
          >
            <RefreshCw className={`w-4 h-4 ${analyticsLoading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>

        {analyticsLoading && !analytics ? (
          <div className="flex items-center justify-center py-12">
            <RefreshCw className="w-8 h-8 animate-spin text-blue-600" />
          </div>
        ) : analytics ? (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-blue-100 rounded-xl flex items-center justify-center">
                    <Building2 className="w-6 h-6 text-blue-600" />
                  </div>
                  <div>
                    <p className="text-sm text-gray-500">Locations</p>
                    <p className="text-2xl font-bold text-gray-900">{analytics.enterprise.shopCount}</p>
                  </div>
                </div>
              </div>

              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-green-100 rounded-xl flex items-center justify-center">
                    <Package className="w-6 h-6 text-green-600" />
                  </div>
                  <div>
                    <p className="text-sm text-gray-500">Jobs Added by MOS</p>
                    <p className="text-2xl font-bold text-gray-900">{analytics.summary.totalJobsAdded.toLocaleString()}</p>
                  </div>
                </div>
              </div>

              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-blue-100 rounded-xl flex items-center justify-center">
                    <TrendingUp className="w-6 h-6 text-mos-blue" />
                  </div>
                  <div>
                    <p className="text-sm text-gray-500">Jobs Sold</p>
                    <p className="text-2xl font-bold text-gray-900">{analytics.summary.totalJobsSold.toLocaleString()}</p>
                  </div>
                </div>
              </div>

              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-yellow-100 rounded-xl flex items-center justify-center">
                    <DollarSign className="w-6 h-6 text-yellow-600" />
                  </div>
                  <div>
                    <p className="text-sm text-gray-500">Revenue from MOS</p>
                    <p className="text-2xl font-bold text-gray-900">{formatCurrency(analytics.summary.totalRevenue)}</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
              <div className="lg:col-span-2 bg-white rounded-xl border border-gray-200">
                <div className="px-6 py-4 border-b border-gray-200">
                  <h2 className="font-semibold text-gray-900">Shop Performance</h2>
                </div>
                <div className="divide-y divide-gray-200">
                  {analytics.shopBreakdown.map((shop) => (
                    <div key={shop.shopId} className="px-6 py-4">
                      <div
                        className="flex items-center justify-between cursor-pointer"
                        onClick={() => toggleShopExpanded(shop.shopId)}
                      >
                        <div className="flex items-center gap-3">
                          {expandedShops.has(shop.shopId) ? (
                            <ChevronUp className="w-4 h-4 text-gray-400" />
                          ) : (
                            <ChevronDown className="w-4 h-4 text-gray-400" />
                          )}
                          <div>
                            <p className="font-medium text-gray-900">{shop.shopName}</p>
                            <p className="text-sm text-gray-500">Shop ID: {shop.shopId}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-8">
                          <div className="text-right">
                            <p className="text-sm text-gray-500">Jobs Added</p>
                            <p className="font-semibold text-gray-900">{shop.jobsAdded}</p>
                          </div>
                          <div className="text-right">
                            <p className="text-sm text-gray-500">Jobs Sold</p>
                            <p className="font-semibold text-gray-900">{shop.jobsSold}</p>
                          </div>
                          <div className="text-right">
                            <p className="text-sm text-gray-500">Revenue</p>
                            <p className="font-semibold text-green-600">{formatCurrency(shop.revenue)}</p>
                          </div>
                        </div>
                      </div>
                      
                      {expandedShops.has(shop.shopId) && (
                        <div className="mt-4 pl-7 grid grid-cols-3 gap-4">
                          <div className="bg-gray-50 rounded-lg p-3">
                            <p className="text-xs text-gray-500">Active Vehicles</p>
                            <p className="font-semibold">{shop.activeVehicles || 0}</p>
                          </div>
                          <div className="bg-gray-50 rounded-lg p-3">
                            <p className="text-xs text-gray-500">Total Vehicles</p>
                            <p className="font-semibold">{shop.totalVehicles || 0}</p>
                          </div>
                          <div className="bg-gray-50 rounded-lg p-3">
                            <p className="text-xs text-gray-500">Conversion Rate</p>
                            <p className="font-semibold">
                              {shop.jobsAdded > 0 
                                ? `${Math.round((shop.jobsSold / shop.jobsAdded) * 100)}%`
                                : "—"
                              }
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                  
                  {analytics.shopBreakdown.length === 0 && (
                    <div className="px-6 py-8 text-center text-gray-500">
                      No shop data available yet. Add shops to this enterprise to see performance.
                    </div>
                  )}
                </div>
              </div>

              <div className="bg-white rounded-xl border border-gray-200">
                <div className="px-6 py-4 border-b border-gray-200">
                  <h2 className="font-semibold text-gray-900">Quick Actions</h2>
                </div>
                <div className="p-4 space-y-3">
                  <Link
                    href={`/admin/enterprise/mappings?id=${selectedEnterprise}`}
                    className="flex items-center gap-3 p-3 rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    <Settings className="w-5 h-5 text-gray-400" />
                    <div>
                      <p className="font-medium text-gray-900">Shared Mappings</p>
                      <p className="text-sm text-gray-500">Configure canned job mappings for all locations</p>
                    </div>
                  </Link>
                  
                  <Link
                    href={`/admin/enterprise/shops?id=${selectedEnterprise}`}
                    className="flex items-center gap-3 p-3 rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    <Building2 className="w-5 h-5 text-gray-400" />
                    <div>
                      <p className="font-medium text-gray-900">Manage Shops</p>
                      <p className="text-sm text-gray-500">Add or remove locations from this enterprise</p>
                    </div>
                  </Link>
                  
                  <Link
                    href={`/admin/enterprise/users?id=${selectedEnterprise}`}
                    className="flex items-center gap-3 p-3 rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    <Users className="w-5 h-5 text-gray-400" />
                    <div>
                      <p className="font-medium text-gray-900">User Access</p>
                      <p className="text-sm text-gray-500">Manage user access to multiple locations</p>
                    </div>
                  </Link>
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="text-center py-12 text-gray-500">
            Select an enterprise to view analytics
          </div>
        )}
      </div>

      {showCreateModal && (
        <CreateEnterpriseModal
          name={newEnterpriseName}
          setName={setNewEnterpriseName}
          onCreate={createEnterprise}
          onClose={() => setShowCreateModal(false)}
        />
      )}
    </div>
  );
}

function CreateEnterpriseModal({
  name,
  setName,
  onCreate,
  onClose
}: {
  name: string;
  setName: (name: string) => void;
  onCreate: () => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl p-6 w-full max-w-md">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Create Enterprise Account</h2>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Enterprise name (e.g., AutoCare Group)"
          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        />
        <div className="flex items-center justify-end gap-3 mt-6">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-600 hover:text-gray-900"
          >
            Cancel
          </button>
          <button
            onClick={onCreate}
            disabled={!name.trim()}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
