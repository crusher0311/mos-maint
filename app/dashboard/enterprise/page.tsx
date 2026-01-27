"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Building2, Users, Check, X, Plus, Loader2, Search, ArrowLeft } from "lucide-react";

interface ShopAccess {
  shopId: number;
  shopName: string;
  userId: string;
}

interface EnterpriseUser {
  email: string;
  name: string | null;
  role: string;
  createdAt: string;
  shopAccess: ShopAccess[];
}

interface Shop {
  shopId: number;
  name: string;
  locationIdentifier?: string | null;
}

interface Enterprise {
  id: string;
  name: string;
}

export default function EnterpriseUserAccessPage() {
  const [enterprise, setEnterprise] = useState<Enterprise | null>(null);
  const [shops, setShops] = useState<Shop[]>([]);
  const [users, setUsers] = useState<EnterpriseUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedUser, setExpandedUser] = useState<string | null>(null);
  
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newShop, setNewShop] = useState({
    name: "",
    smsProvider: "tekmetric" as "tekmetric" | "protractor" | "none",
    tekmetricShopId: "",
    protractorShopId: "",
    assignUserEmails: [] as string[]
  });

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/dashboard/enterprise-users");
      const data = await res.json();
      
      if (!res.ok) {
        setError(data.error || "Failed to load data");
        return;
      }
      
      setEnterprise(data.enterprise);
      setShops(data.shops || []);
      setUsers(data.users || []);
    } catch (err) {
      console.error("Error loading data:", err);
      setError("Failed to load enterprise data");
    } finally {
      setLoading(false);
    }
  };

  const grantAccess = async (email: string, shopId: number) => {
    setSaving(`${email}-${shopId}`);
    try {
      const res = await fetch("/api/dashboard/enterprise-users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, shopId, action: "grant" }),
      });
      
      if (res.ok) {
        await loadData();
      } else {
        const data = await res.json();
        alert(data.error || "Failed to grant access");
      }
    } catch (err) {
      console.error("Error granting access:", err);
    } finally {
      setSaving(null);
    }
  };

  const revokeAccess = async (email: string, shopId: number) => {
    if (!confirm(`Remove ${email}'s access to this location?`)) return;
    
    setSaving(`${email}-${shopId}`);
    try {
      const res = await fetch("/api/dashboard/enterprise-users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, shopId, action: "revoke" }),
      });
      
      if (res.ok) {
        await loadData();
      } else {
        const data = await res.json();
        alert(data.error || "Failed to revoke access");
      }
    } catch (err) {
      console.error("Error revoking access:", err);
    } finally {
      setSaving(null);
    }
  };

  const createLocation = async () => {
    if (!newShop.name.trim() || !enterprise) return;
    
    setCreating(true);
    try {
      const res = await fetch("/api/enterprise/shops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enterpriseId: enterprise.id,
          name: newShop.name.trim(),
          smsProvider: newShop.smsProvider,
          tekmetricShopId: newShop.tekmetricShopId || undefined,
          protractorShopId: newShop.protractorShopId || undefined,
          assignUserEmails: newShop.assignUserEmails
        })
      });
      
      if (res.ok) {
        setShowCreateModal(false);
        setNewShop({
          name: "",
          smsProvider: "tekmetric",
          tekmetricShopId: "",
          protractorShopId: "",
          assignUserEmails: []
        });
        await loadData();
      } else {
        const data = await res.json();
        alert(data.error || "Failed to create location");
      }
    } catch (err) {
      console.error("Error creating location:", err);
      alert("Failed to create location");
    } finally {
      setCreating(false);
    }
  };

  const filteredUsers = users.filter(
    (u) =>
      searchQuery === "" ||
      u.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
      u.name?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (error || !enterprise) {
    return (
      <div className="flex-1 p-8">
        <div className="max-w-2xl mx-auto text-center">
          <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <Building2 className="w-8 h-8 text-gray-400" />
          </div>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">No Enterprise Account</h2>
          <p className="text-gray-600 mb-6">
            {error || "Your shop is not part of an enterprise account. Enterprise features allow you to manage multiple locations."}
          </p>
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-2 text-blue-600 hover:text-blue-700"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-5xl mx-auto p-8">
        <div className="mb-6">
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-2 text-gray-600 hover:text-gray-900 mb-4"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Dashboard
          </Link>
          
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 bg-blue-100 rounded-xl flex items-center justify-center">
                <Building2 className="w-6 h-6 text-blue-600" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-gray-900">Enterprise Overview</h1>
                <p className="text-gray-600">{enterprise.name} - Manage your locations and team</p>
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

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Building2 className="w-5 h-5 text-blue-600" />
                <h2 className="font-semibold text-gray-900">Locations ({shops.length})</h2>
              </div>
            </div>
            <div className="divide-y divide-gray-100 max-h-64 overflow-y-auto">
              {shops.length === 0 ? (
                <div className="px-6 py-8 text-center text-gray-500">
                  <Building2 className="w-8 h-8 text-gray-300 mx-auto mb-2" />
                  <p>No locations yet</p>
                  <button
                    onClick={() => setShowCreateModal(true)}
                    className="text-blue-600 hover:underline text-sm mt-1"
                  >
                    Create your first location
                  </button>
                </div>
              ) : (
                shops.map((shop) => (
                  <div key={shop.shopId} className="px-6 py-3 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 bg-blue-100 rounded-lg flex items-center justify-center">
                        <Building2 className="w-4 h-4 text-blue-600" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="font-medium text-gray-900 text-sm">{shop.name}</p>
                          {shop.locationIdentifier && (
                            <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 text-xs rounded font-medium">
                              {shop.locationIdentifier}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-gray-500">ID: {shop.shopId}</p>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Users className="w-5 h-5 text-blue-600" />
                <h2 className="font-semibold text-gray-900">Team Members ({users.length})</h2>
              </div>
            </div>
            <div className="divide-y divide-gray-100 max-h-64 overflow-y-auto">
              {users.length === 0 ? (
                <div className="px-6 py-8 text-center text-gray-500">
                  <Users className="w-8 h-8 text-gray-300 mx-auto mb-2" />
                  <p>No team members yet</p>
                </div>
              ) : (
                users.map((user) => (
                  <div key={user.email} className="px-6 py-3 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-white text-xs font-medium">
                        {user.email.substring(0, 2).toUpperCase()}
                      </div>
                      <div>
                        <p className="font-medium text-gray-900 text-sm">{user.email}</p>
                        {user.name && <p className="text-xs text-gray-500">{user.name}</p>}
                      </div>
                    </div>
                    <span className="px-2 py-0.5 bg-gray-100 text-gray-600 text-xs rounded-full">
                      {user.shopAccess.length} location{user.shopAccess.length !== 1 ? "s" : ""}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <h2 className="text-lg font-semibold text-gray-900 mb-4">User Access Management</h2>

        <div className="bg-white rounded-xl border border-gray-200 shadow-sm mb-6">
          <div className="p-4 border-b border-gray-200">
            <div className="flex items-center gap-4">
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  type="text"
                  placeholder="Search users..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              <div className="text-sm text-gray-500">
                {users.length} users across {shops.length} locations
              </div>
            </div>
          </div>

          <div className="divide-y divide-gray-200">
            {filteredUsers.length === 0 ? (
              <div className="p-8 text-center text-gray-500">
                {searchQuery ? "No users match your search" : "No users found in this enterprise"}
              </div>
            ) : (
              filteredUsers.map((user) => {
                const userShopIds = new Set(user.shopAccess.map((a) => a.shopId));
                const isExpanded = expandedUser === user.email;

                return (
                  <div key={user.email} className="p-4">
                    <div 
                      className="flex items-center justify-between cursor-pointer"
                      onClick={() => setExpandedUser(isExpanded ? null : user.email)}
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-blue-600 flex items-center justify-center text-white font-medium">
                          {user.email.substring(0, 2).toUpperCase()}
                        </div>
                        <div>
                          <p className="font-medium text-gray-900">{user.email}</p>
                          {user.name && <p className="text-sm text-gray-500">{user.name}</p>}
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <span className="text-sm text-gray-500 capitalize">{user.role}</span>
                        <span className="px-2 py-1 bg-gray-100 rounded-full text-xs text-gray-600">
                          {user.shopAccess.length} location{user.shopAccess.length !== 1 ? "s" : ""}
                        </span>
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="mt-4 ml-13 pl-4 border-l-2 border-gray-200">
                        <p className="text-sm font-medium text-gray-700 mb-2">Location Access</p>
                        <div className="grid gap-2">
                          {shops.map((shop) => {
                            const hasAccess = userShopIds.has(shop.shopId);
                            const isSaving = saving === `${user.email}-${shop.shopId}`;

                            return (
                              <div
                                key={shop.shopId}
                                className={`flex items-center justify-between p-3 rounded-lg border ${
                                  hasAccess
                                    ? "bg-green-50 border-green-200"
                                    : "bg-gray-50 border-gray-200"
                                }`}
                              >
                                <div className="flex items-center gap-2">
                                  <Building2 className="w-4 h-4 text-gray-400" />
                                  <span className="text-sm font-medium">{shop.name}</span>
                                </div>
                                
                                {isSaving ? (
                                  <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
                                ) : hasAccess ? (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      revokeAccess(user.email, shop.shopId);
                                    }}
                                    disabled={user.shopAccess.length <= 1}
                                    className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
                                      user.shopAccess.length <= 1
                                        ? "bg-gray-200 text-gray-400 cursor-not-allowed"
                                        : "bg-red-100 text-red-600 hover:bg-red-200"
                                    }`}
                                    title={user.shopAccess.length <= 1 ? "User must have at least one location" : "Remove access"}
                                  >
                                    <X className="w-3 h-3" />
                                    Remove
                                  </button>
                                ) : (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      grantAccess(user.email, shop.shopId);
                                    }}
                                    className="flex items-center gap-1 px-2 py-1 rounded bg-blue-100 text-blue-600 hover:bg-blue-200 text-xs font-medium transition-colors"
                                  >
                                    <Plus className="w-3 h-3" />
                                    Grant Access
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
          <h3 className="font-medium text-blue-900 mb-2">How Location Access Works</h3>
          <ul className="text-sm text-blue-800 space-y-1">
            <li>Users with access to multiple locations can switch between them from the sidebar dropdown</li>
            <li>Granting access creates a linked account at that location with the same login credentials</li>
            <li>Each user must have access to at least one location</li>
          </ul>
        </div>
      </div>

      {showCreateModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full mx-4 max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b border-gray-200">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-gray-900">Create New Location</h2>
                <button
                  onClick={() => setShowCreateModal(false)}
                  className="p-1 hover:bg-gray-100 rounded"
                >
                  <X className="w-5 h-5 text-gray-500" />
                </button>
              </div>
            </div>

            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Location Name *
                </label>
                <input
                  type="text"
                  value={newShop.name}
                  onChange={(e) => setNewShop(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="e.g., Downtown Location"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
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
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="tekmetric">Tekmetric</option>
                  <option value="protractor">Protractor</option>
                  <option value="none">None / Set up later</option>
                </select>
              </div>

              {newShop.smsProvider === "tekmetric" && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Tekmetric Shop ID (optional)
                  </label>
                  <input
                    type="text"
                    value={newShop.tekmetricShopId}
                    onChange={(e) => setNewShop(prev => ({ ...prev, tekmetricShopId: e.target.value }))}
                    placeholder="e.g., 12345"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                  <p className="mt-1 text-xs text-gray-500">Can be configured later if not known</p>
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
                    placeholder="e.g., SHOP123"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                  <p className="mt-1 text-xs text-gray-500">Can be configured later if not known</p>
                </div>
              )}

              {users.length > 0 && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Grant Access to Users
                  </label>
                  <div className="space-y-2 max-h-40 overflow-y-auto border border-gray-200 rounded-lg p-2">
                    {users.map((user) => (
                      <label key={user.email} className="flex items-center gap-2 p-2 hover:bg-gray-50 rounded cursor-pointer">
                        <input
                          type="checkbox"
                          checked={newShop.assignUserEmails.includes(user.email)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setNewShop(prev => ({
                                ...prev,
                                assignUserEmails: [...prev.assignUserEmails, user.email]
                              }));
                            } else {
                              setNewShop(prev => ({
                                ...prev,
                                assignUserEmails: prev.assignUserEmails.filter(e => e !== user.email)
                              }));
                            }
                          }}
                          className="w-4 h-4 text-blue-600 rounded"
                        />
                        <span className="text-sm text-gray-900">{user.email}</span>
                        {user.name && <span className="text-xs text-gray-500">({user.name})</span>}
                      </label>
                    ))}
                  </div>
                  <p className="mt-1 text-xs text-gray-500">
                    Selected users will be granted access with their existing role
                  </p>
                </div>
              )}
            </div>

            <div className="p-6 border-t border-gray-200 flex justify-end gap-3">
              <button
                onClick={() => setShowCreateModal(false)}
                className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={createLocation}
                disabled={!newShop.name.trim() || creating}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
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
