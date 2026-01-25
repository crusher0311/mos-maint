"use client";

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Users, Building2, Check, X, Plus, Loader2, Search } from "lucide-react";

interface ShopAccess {
  shopId: number;
  shopName: string;
  locationIdentifier?: string | null;
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

export default function EnterpriseUsersPage() {
  const searchParams = useSearchParams();
  const enterpriseId = searchParams.get("id");

  const [enterprise, setEnterprise] = useState<Enterprise | null>(null);
  const [shops, setShops] = useState<Shop[]>([]);
  const [users, setUsers] = useState<EnterpriseUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedUser, setExpandedUser] = useState<string | null>(null);

  useEffect(() => {
    if (enterpriseId) loadData();
  }, [enterpriseId]);

  const loadData = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/enterprise/users?enterpriseId=${enterpriseId}`);
      const data = await res.json();
      setEnterprise(data.enterprise);
      setShops(data.shops || []);
      setUsers(data.users || []);
    } catch (err) {
      console.error("Error loading data:", err);
    } finally {
      setLoading(false);
    }
  };

  const grantAccess = async (email: string, shopId: number) => {
    setSaving(`${email}-${shopId}`);
    try {
      const res = await fetch("/api/enterprise/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enterpriseId,
          email,
          shopId,
          action: "grant",
        }),
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
      const res = await fetch("/api/enterprise/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enterpriseId,
          email,
          shopId,
          action: "revoke",
        }),
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

  const filteredUsers = users.filter(
    (u) =>
      searchQuery === "" ||
      u.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
      u.name?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  if (!enterpriseId) {
    return (
      <div className="min-h-screen bg-gray-50 p-8">
        <div className="max-w-4xl mx-auto">
          <p className="text-gray-600">No enterprise selected. Please select an enterprise from the dashboard.</p>
          <Link href="/admin/enterprise" className="text-blue-600 hover:underline mt-4 inline-block">
            Back to Enterprise Dashboard
          </Link>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto p-8">
        <div className="mb-6">
          <Link
            href="/admin/enterprise"
            className="inline-flex items-center gap-2 text-gray-600 hover:text-gray-900 mb-4"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Enterprise Dashboard
          </Link>
          
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-blue-100 rounded-xl flex items-center justify-center">
              <Users className="w-6 h-6 text-mos-blue" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">User Access Management</h1>
              <p className="text-gray-600">{enterprise?.name} - Manage location access for users</p>
            </div>
          </div>
        </div>

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
                const availableShops = shops.filter((s) => !userShopIds.has(s.shopId));
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
                                  {shop.locationIdentifier && (
                                    <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 text-xs rounded">{shop.locationIdentifier}</span>
                                  )}
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
    </div>
  );
}
