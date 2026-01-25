"use client";

import React, { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Building2, Plus, Check, X, RefreshCw, ArrowLeft, Search, Users, Settings, ExternalLink, Loader2 } from "lucide-react";
import Link from "next/link";

interface Shop {
  _id: string;
  shopId: number;
  name: string;
  enterpriseId?: string;
  protractor?: { baseUrl: string };
  tekmetric?: { shopId: number };
  userCount?: number;
}

interface Enterprise {
  _id: string;
  name: string;
  shopIds: number[];
}

interface AvailableUser {
  _id: string;
  email: string;
  name?: string;
  role: string;
}

function ShopManagementContent() {
  const searchParams = useSearchParams();
  const enterpriseId = searchParams.get("id");
  
  const [enterprise, setEnterprise] = useState<Enterprise | null>(null);
  const [allShops, setAllShops] = useState<Shop[]>([]);
  const [availableUsers, setAvailableUsers] = useState<AvailableUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [saving, setSaving] = useState<number | null>(null);
  
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newShop, setNewShop] = useState({
    name: "",
    smsProvider: "tekmetric" as "tekmetric" | "protractor" | "none",
    tekmetricShopId: "",
    protractorShopId: "",
    assignUserIds: [] as string[]
  });

  useEffect(() => {
    if (enterpriseId) {
      loadData();
    }
  }, [enterpriseId]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [entRes, shopsRes] = await Promise.all([
        fetch(`/api/enterprise?id=${enterpriseId}`),
        fetch("/api/admin/shops")
      ]);
      
      const entData = await entRes.json();
      const shopsData = await shopsRes.json();
      
      setEnterprise(entData.enterprise);
      setAllShops(shopsData.shops || []);
      
      if (entData.availableUsers) {
        setAvailableUsers(entData.availableUsers);
      }
    } catch (err) {
      console.error("Error loading data:", err);
    } finally {
      setLoading(false);
    }
  };
  
  const createNewShop = async () => {
    if (!newShop.name.trim() || !enterpriseId) return;
    
    setCreating(true);
    try {
      const res = await fetch("/api/enterprise/shops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enterpriseId,
          name: newShop.name.trim(),
          smsProvider: newShop.smsProvider,
          tekmetricShopId: newShop.smsProvider === "tekmetric" && newShop.tekmetricShopId 
            ? parseInt(newShop.tekmetricShopId) 
            : undefined,
          protractorShopId: newShop.smsProvider === "protractor" && newShop.protractorShopId 
            ? newShop.protractorShopId 
            : undefined,
          assignUserIds: newShop.assignUserIds
        })
      });

      if (res.ok) {
        setNewShop({
          name: "",
          smsProvider: "tekmetric",
          tekmetricShopId: "",
          protractorShopId: "",
          assignUserIds: []
        });
        setShowCreateModal(false);
        await loadData();
      } else {
        const data = await res.json();
        alert(data.error || "Failed to create shop");
      }
    } catch (err) {
      console.error("Error creating shop:", err);
      alert("Failed to create shop");
    } finally {
      setCreating(false);
    }
  };
  
  const toggleUserSelection = (userId: string) => {
    setNewShop(prev => ({
      ...prev,
      assignUserIds: prev.assignUserIds.includes(userId)
        ? prev.assignUserIds.filter(id => id !== userId)
        : [...prev.assignUserIds, userId]
    }));
  };

  const addShopToEnterprise = async (shopId: number) => {
    if (!enterpriseId) return;
    setSaving(shopId);
    
    try {
      await fetch("/api/enterprise", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enterpriseId,
          shopId,
          action: "add_shop"
        })
      });
      
      setEnterprise(prev => prev ? {
        ...prev,
        shopIds: [...prev.shopIds, shopId]
      } : null);
    } catch (err) {
      console.error("Error adding shop:", err);
    } finally {
      setSaving(null);
    }
  };

  const removeShopFromEnterprise = async (shopId: number) => {
    if (!enterpriseId) return;
    setSaving(shopId);
    
    try {
      await fetch("/api/enterprise", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enterpriseId,
          shopId,
          action: "remove_shop"
        })
      });
      
      setEnterprise(prev => prev ? {
        ...prev,
        shopIds: prev.shopIds.filter(id => id !== shopId)
      } : null);
    } catch (err) {
      console.error("Error removing shop:", err);
    } finally {
      setSaving(null);
    }
  };

  const enterpriseShops = allShops.filter(s => enterprise?.shopIds.includes(s.shopId));
  const availableShops = allShops.filter(s => 
    !enterprise?.shopIds.includes(s.shopId) &&
    (searchQuery === "" || 
     s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
     String(s.shopId).includes(searchQuery))
  );

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <RefreshCw className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (!enterprise) {
    return (
      <div className="min-h-screen bg-gray-50 p-8">
        <div className="max-w-2xl mx-auto text-center">
          <p className="text-gray-600">Enterprise not found</p>
          <Link href="/admin/enterprise" className="text-blue-600 hover:underline mt-4 inline-block">
            Back to Enterprise Dashboard
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Link href="/admin/enterprise" className="p-2 hover:bg-gray-100 rounded-lg">
                <ArrowLeft className="w-5 h-5 text-gray-600" />
              </Link>
              <div>
                <h1 className="text-xl font-bold text-gray-900">Manage Locations</h1>
                <p className="text-sm text-gray-500">{enterprise.name}</p>
              </div>
            </div>
            <button
              onClick={() => setShowCreateModal(true)}
              className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium"
            >
              <Plus className="w-4 h-4" />
              Create New Location
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-8">
        <div className="bg-white rounded-xl border border-gray-200 mb-6">
          <div className="px-6 py-4 border-b border-gray-200">
            <h2 className="font-semibold text-gray-900">
              Enterprise Shops ({enterpriseShops.length})
            </h2>
          </div>
          <div className="divide-y divide-gray-200">
            {enterpriseShops.map((shop) => (
              <div key={shop.shopId} className="px-6 py-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center">
                    <Building2 className="w-5 h-5 text-blue-600" />
                  </div>
                  <div>
                    <p className="font-medium text-gray-900">{shop.name}</p>
                    <p className="text-sm text-gray-500">Shop ID: {shop.shopId}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {shop.protractor && (
                    <span className="px-2 py-1 bg-blue-100 text-mos-blue text-xs rounded-full">
                      Protractor
                    </span>
                  )}
                  {shop.tekmetric && (
                    <span className="px-2 py-1 bg-green-100 text-green-700 text-xs rounded-full">
                      Tekmetric
                    </span>
                  )}
                  <button
                    onClick={() => removeShopFromEnterprise(shop.shopId)}
                    disabled={saving === shop.shopId}
                    className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                    title="Remove from enterprise"
                  >
                    {saving === shop.shopId ? (
                      <RefreshCw className="w-4 h-4 animate-spin" />
                    ) : (
                      <X className="w-4 h-4" />
                    )}
                  </button>
                </div>
              </div>
            ))}
            {enterpriseShops.length === 0 && (
              <div className="px-6 py-8 text-center text-gray-500">
                No shops in this enterprise yet. Add shops from the list below.
              </div>
            )}
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200">
          <div className="px-6 py-4 border-b border-gray-200">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-gray-900">Available Shops</h2>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search shops..."
                  className="pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
          </div>
          <div className="divide-y divide-gray-200 max-h-96 overflow-y-auto">
            {availableShops.map((shop) => (
              <div key={shop.shopId} className="px-6 py-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-gray-100 rounded-lg flex items-center justify-center">
                    <Building2 className="w-5 h-5 text-gray-400" />
                  </div>
                  <div>
                    <p className="font-medium text-gray-900">{shop.name}</p>
                    <p className="text-sm text-gray-500">Shop ID: {shop.shopId}</p>
                  </div>
                </div>
                <button
                  onClick={() => addShopToEnterprise(shop.shopId)}
                  disabled={saving === shop.shopId}
                  className="inline-flex items-center gap-2 px-3 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50"
                >
                  {saving === shop.shopId ? (
                    <RefreshCw className="w-4 h-4 animate-spin" />
                  ) : (
                    <>
                      <Plus className="w-4 h-4" />
                      Add
                    </>
                  )}
                </button>
              </div>
            ))}
            {availableShops.length === 0 && (
              <div className="px-6 py-8 text-center text-gray-500">
                {searchQuery ? "No shops match your search" : "All shops are already in this enterprise"}
              </div>
            )}
          </div>
        </div>
      </div>
      
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Create New Location</h2>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Location Name *
                </label>
                <input
                  type="text"
                  value={newShop.name}
                  onChange={(e) => setNewShop(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="e.g., Downtown Auto Care"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Shop Management System
                </label>
                <select
                  value={newShop.smsProvider}
                  onChange={(e) => setNewShop(prev => ({ 
                    ...prev, 
                    smsProvider: e.target.value as "tekmetric" | "protractor" | "none" 
                  }))}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="tekmetric">Tekmetric</option>
                  <option value="protractor">Protractor</option>
                  <option value="none">None / Configure Later</option>
                </select>
              </div>

              {newShop.smsProvider === "tekmetric" && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Tekmetric Shop ID (optional)
                  </label>
                  <input
                    type="number"
                    value={newShop.tekmetricShopId}
                    onChange={(e) => setNewShop(prev => ({ ...prev, tekmetricShopId: e.target.value }))}
                    placeholder="e.g., 14956"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Find this in your Tekmetric URL: shop.tekmetric.com/shop/[ID]
                  </p>
                </div>
              )}

              {newShop.smsProvider === "protractor" && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Protractor Shop ID (optional)
                  </label>
                  <input
                    type="text"
                    value={newShop.protractorShopId}
                    onChange={(e) => setNewShop(prev => ({ ...prev, protractorShopId: e.target.value }))}
                    placeholder="e.g., shop123"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
              )}

              {availableUsers.length > 0 && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Assign Users to This Location
                  </label>
                  <div className="max-h-48 overflow-y-auto border border-gray-200 rounded-lg divide-y divide-gray-200">
                    {availableUsers.map((user) => {
                      const isSelected = newShop.assignUserIds.includes(user._id);
                      return (
                        <div
                          key={user._id}
                          onClick={() => toggleUserSelection(user._id)}
                          className={`flex items-center justify-between p-3 cursor-pointer transition-colors ${
                            isSelected ? "bg-blue-50" : "hover:bg-gray-50"
                          }`}
                        >
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center text-sm font-medium text-gray-600">
                              {user.email.substring(0, 2).toUpperCase()}
                            </div>
                            <div>
                              <p className="text-sm font-medium text-gray-900">{user.email}</p>
                              {user.name && <p className="text-xs text-gray-500">{user.name}</p>}
                            </div>
                          </div>
                          <div className={`w-5 h-5 rounded border flex items-center justify-center ${
                            isSelected 
                              ? "bg-blue-600 border-blue-600" 
                              : "border-gray-300"
                          }`}>
                            {isSelected && <Check className="w-3 h-3 text-white" />}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <p className="text-xs text-gray-500 mt-1">
                    {newShop.assignUserIds.length} user{newShop.assignUserIds.length !== 1 ? "s" : ""} selected
                  </p>
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-gray-200">
              <button
                onClick={() => setShowCreateModal(false)}
                className="px-4 py-2 text-gray-600 hover:text-gray-900"
              >
                Cancel
              </button>
              <button
                onClick={createNewShop}
                disabled={!newShop.name.trim() || creating}
                className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {creating && <Loader2 className="w-4 h-4 animate-spin" />}
                Create Location
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ShopManagementPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <RefreshCw className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    }>
      <ShopManagementContent />
    </Suspense>
  );
}
