"use client";

import { useState, useEffect, Fragment } from "react";
import { Building2, Plus, Trash2, Loader2, RefreshCw, Search, ChevronDown, ChevronUp, X, Check } from "lucide-react";

interface Enterprise {
  _id: string;
  name: string;
  shopIds: (number | string)[];
  shopCount: number;
  createdAt: string;
}

interface Shop {
  shopId: number | string;
  name: string;
  enterpriseId?: string;
}

export default function PlatformEnterprisesPage() {
  const [enterprises, setEnterprises] = useState<Enterprise[]>([]);
  const [availableShops, setAvailableShops] = useState<Shop[]>([]);
  const [allShops, setAllShops] = useState<Shop[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [expandedEnterprise, setExpandedEnterprise] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newName, setNewName] = useState("");
  const [selectedShops, setSelectedShops] = useState<(number | string)[]>([]);
  const [search, setSearch] = useState("");

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/platform-admin/enterprises");
      const data = await res.json();
      if (data.ok) {
        setEnterprises(data.enterprises || []);
        setAvailableShops(data.availableShops || []);
        setAllShops(data.allShops || []);
      }
    } catch (err) {
      console.error("Error loading enterprises:", err);
    } finally {
      setLoading(false);
    }
  };

  const createEnterprise = async () => {
    if (!newName.trim()) return;
    setActionLoading("create");
    try {
      const res = await fetch("/api/platform-admin/enterprises", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim(), shopIds: selectedShops }),
      });
      const data = await res.json();
      if (data.ok) {
        setShowCreateModal(false);
        setNewName("");
        setSelectedShops([]);
        loadData();
      } else {
        alert(data.error || "Failed to create enterprise");
      }
    } catch (err) {
      console.error("Create enterprise error:", err);
      alert("Failed to create enterprise");
    } finally {
      setActionLoading(null);
    }
  };

  const addShopToEnterprise = async (enterpriseId: string, shopId: number | string) => {
    setActionLoading(`add-${enterpriseId}-${shopId}`);
    try {
      const res = await fetch(`/api/platform-admin/enterprises/${enterpriseId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "add_shop", shopId }),
      });
      const data = await res.json();
      if (data.ok) {
        loadData();
      } else {
        alert(data.error || "Failed to add shop");
      }
    } catch (err) {
      console.error("Add shop error:", err);
    } finally {
      setActionLoading(null);
    }
  };

  const removeShopFromEnterprise = async (enterpriseId: string, shopId: number | string) => {
    setActionLoading(`remove-${enterpriseId}-${shopId}`);
    try {
      const res = await fetch(`/api/platform-admin/enterprises/${enterpriseId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "remove_shop", shopId }),
      });
      const data = await res.json();
      if (data.ok) {
        loadData();
      } else {
        alert(data.error || "Failed to remove shop");
      }
    } catch (err) {
      console.error("Remove shop error:", err);
    } finally {
      setActionLoading(null);
    }
  };

  const deleteEnterprise = async (enterprise: Enterprise) => {
    if (!confirm(`Delete enterprise "${enterprise.name}"?\n\nThis will unlink all ${enterprise.shopCount} shops from this enterprise.`)) {
      return;
    }
    setActionLoading(`delete-${enterprise._id}`);
    try {
      const res = await fetch(`/api/platform-admin/enterprises/${enterprise._id}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (data.ok) {
        loadData();
      } else {
        alert(data.error || "Failed to delete enterprise");
      }
    } catch (err) {
      console.error("Delete enterprise error:", err);
    } finally {
      setActionLoading(null);
    }
  };

  const getShopName = (shopId: number | string) => {
    return allShops.find(s => s.shopId === shopId)?.name || `Shop ${shopId}`;
  };

  const filteredEnterprises = enterprises.filter(e =>
    e.name.toLowerCase().includes(search.toLowerCase())
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
          <h1 className="text-2xl font-bold text-gray-900">Enterprise Accounts</h1>
          <p className="text-gray-600">Manage multi-location enterprise accounts</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={loadData}
            className="p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg"
          >
            <RefreshCw className="w-5 h-5" />
          </button>
          <button
            onClick={() => setShowCreateModal(true)}
            className="inline-flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700"
          >
            <Plus className="w-4 h-4" />
            Create Enterprise
          </button>
        </div>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
        <input
          type="text"
          placeholder="Search enterprises..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
        />
      </div>

      {filteredEnterprises.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-8 text-center">
          <Building2 className="w-12 h-12 text-gray-300 mx-auto mb-4" />
          <p className="text-gray-500">
            {search ? "No enterprises match your search" : "No enterprise accounts yet"}
          </p>
          {!search && (
            <button
              onClick={() => setShowCreateModal(true)}
              className="mt-4 text-purple-600 hover:text-purple-700 font-medium"
            >
              Create your first enterprise
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {filteredEnterprises.map((enterprise) => (
            <div key={enterprise._id} className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
              <div
                className="flex items-center justify-between p-4 cursor-pointer hover:bg-gray-50"
                onClick={() => setExpandedEnterprise(expandedEnterprise === enterprise._id ? null : enterprise._id)}
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-purple-100 rounded-lg flex items-center justify-center">
                    <Building2 className="w-5 h-5 text-purple-600" />
                  </div>
                  <div>
                    <div className="font-semibold text-gray-900">{enterprise.name}</div>
                    <div className="text-sm text-gray-500">
                      {enterprise.shopCount} shop{enterprise.shopCount !== 1 ? "s" : ""} • Created {new Date(enterprise.createdAt).toLocaleDateString()}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={(e) => { e.stopPropagation(); deleteEnterprise(enterprise); }}
                    disabled={actionLoading !== null}
                    className="p-2 text-red-600 hover:bg-red-50 rounded-lg disabled:opacity-50"
                  >
                    {actionLoading === `delete-${enterprise._id}` ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Trash2 className="w-4 h-4" />
                    )}
                  </button>
                  {expandedEnterprise === enterprise._id ? (
                    <ChevronUp className="w-5 h-5 text-gray-400" />
                  ) : (
                    <ChevronDown className="w-5 h-5 text-gray-400" />
                  )}
                </div>
              </div>

              {expandedEnterprise === enterprise._id && (
                <div className="border-t border-gray-100 p-4 bg-gray-50">
                  <div className="mb-4">
                    <h4 className="font-medium text-gray-700 mb-2">Linked Shops</h4>
                    {enterprise.shopIds.length === 0 ? (
                      <p className="text-sm text-gray-500">No shops linked yet</p>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {enterprise.shopIds.map((shopId) => (
                          <div
                            key={shopId}
                            className="inline-flex items-center gap-2 px-3 py-1.5 bg-white border border-gray-200 rounded-lg text-sm"
                          >
                            <span>{getShopName(shopId)}</span>
                            <button
                              onClick={() => removeShopFromEnterprise(enterprise._id, shopId)}
                              disabled={actionLoading !== null}
                              className="text-gray-400 hover:text-red-600 disabled:opacity-50"
                            >
                              {actionLoading === `remove-${enterprise._id}-${shopId}` ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                <X className="w-3 h-3" />
                              )}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {availableShops.length > 0 && (
                    <div>
                      <h4 className="font-medium text-gray-700 mb-2">Add Shops</h4>
                      <div className="flex flex-wrap gap-2">
                        {availableShops.map((shop) => (
                          <button
                            key={shop.shopId}
                            onClick={() => addShopToEnterprise(enterprise._id, shop.shopId)}
                            disabled={actionLoading !== null}
                            className="inline-flex items-center gap-1 px-3 py-1.5 bg-green-50 border border-green-200 text-green-700 rounded-lg text-sm hover:bg-green-100 disabled:opacity-50"
                          >
                            {actionLoading === `add-${enterprise._id}-${shop.shopId}` ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <Plus className="w-3 h-3" />
                            )}
                            {shop.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="text-sm text-gray-500">
        {enterprises.length} enterprise{enterprises.length !== 1 ? "s" : ""} • {availableShops.length} unassigned shop{availableShops.length !== 1 ? "s" : ""}
      </div>

      {showCreateModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowCreateModal(false)}>
          <div className="bg-white rounded-xl p-6 max-w-md w-full mx-4 shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Create Enterprise Account</h3>
            
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">Enterprise Name</label>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g., Big Auto Group"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
              />
            </div>

            {availableShops.length > 0 && (
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">Link Shops (optional)</label>
                <div className="max-h-48 overflow-y-auto border border-gray-200 rounded-lg p-2 space-y-1">
                  {availableShops.map((shop) => (
                    <label
                      key={shop.shopId}
                      className="flex items-center gap-2 p-2 hover:bg-gray-50 rounded cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={selectedShops.includes(shop.shopId)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedShops([...selectedShops, shop.shopId]);
                          } else {
                            setSelectedShops(selectedShops.filter(id => id !== shop.shopId));
                          }
                        }}
                        className="rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                      />
                      <span className="text-sm">{shop.name}</span>
                    </label>
                  ))}
                </div>
                {selectedShops.length > 0 && (
                  <p className="text-xs text-gray-500 mt-1">{selectedShops.length} shop{selectedShops.length !== 1 ? "s" : ""} selected</p>
                )}
              </div>
            )}

            <div className="flex gap-3 justify-end">
              <button
                onClick={() => { setShowCreateModal(false); setNewName(""); setSelectedShops([]); }}
                className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={createEnterprise}
                disabled={!newName.trim() || actionLoading === "create"}
                className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {actionLoading === "create" && <Loader2 className="w-4 h-4 animate-spin" />}
                Create Enterprise
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
