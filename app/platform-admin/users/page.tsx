"use client";

import { useState, useEffect } from "react";
import { Users, Search, RefreshCw, X, Loader2, Building, Shield, MapPin, Trash2, ChevronDown, ChevronRight, Plus, KeyRound, Copy, Check, AlertTriangle } from "lucide-react";

interface ShopInfo {
  shopId: number | string;
  name: string;
  locationIdentifier?: string | null;
}

interface User {
  _id: string;
  email: string;
  role: string;
  primaryShopId: number | string;
  shops: ShopInfo[];
  locationCount: number;
  createdAt: string;
  isPlatformAdmin?: boolean;
}

interface ShopMetadata {
  shopId: string;
  name: string;
  locationIdentifier?: string | null;
  isInUserEnterprise: boolean;
  isUserPrimary: boolean;
  isSelected: boolean;
}

interface EnterpriseInfo {
  _id: string;
  name: string;
  shopIds: string[];
}

interface UserModalData {
  _id: string;
  email: string;
  role: string;
  shopId: string;
  shopIds: string[];
  isPlatformAdmin: boolean;
  createdAt: string;
  lastLogin?: string;
}

export default function PlatformUsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>("all");
  const [selectedUser, setSelectedUser] = useState<UserModalData | null>(null);
  const [modalLoading, setModalLoading] = useState(false);
  const [allShops, setAllShops] = useState<ShopMetadata[]>([]);
  const [userEnterprise, setUserEnterprise] = useState<EnterpriseInfo | null>(null);
  const [saving, setSaving] = useState(false);
  const [editedRole, setEditedRole] = useState("");
  const [editedShopIds, setEditedShopIds] = useState<string[]>([]);
  const [editedIsPlatformAdmin, setEditedIsPlatformAdmin] = useState(false);
  const [showOtherLocations, setShowOtherLocations] = useState(false);
  const [locationSearch, setLocationSearch] = useState("");
  const [resetPasswordTarget, setResetPasswordTarget] = useState<{ id: string; email: string } | null>(null);
  const [resetPasswordValue, setResetPasswordValue] = useState("");
  const [resetPasswordError, setResetPasswordError] = useState<string | null>(null);
  const [resetPasswordSubmitting, setResetPasswordSubmitting] = useState(false);
  const [resetPasswordResult, setResetPasswordResult] = useState<{ password: string; sessionsRevoked: number } | null>(null);
  const [resetPasswordCopied, setResetPasswordCopied] = useState(false);

  function generateStrongPassword(length = 18) {
    const lowers = "abcdefghijkmnopqrstuvwxyz";
    const uppers = "ABCDEFGHJKLMNPQRSTUVWXYZ";
    const digits = "23456789";
    const symbols = "!@#$%^&*()-_=+[]{};:,.?";
    const all = lowers + uppers + digits + symbols;
    const cryptoObj = (typeof window !== "undefined" && window.crypto) ? window.crypto : null;
    const pickFrom = (chars: string) => {
      if (cryptoObj && cryptoObj.getRandomValues) {
        const arr = new Uint32Array(1);
        cryptoObj.getRandomValues(arr);
        return chars[arr[0] % chars.length];
      }
      return chars[Math.floor(Math.random() * chars.length)];
    };
    const required = [pickFrom(lowers), pickFrom(uppers), pickFrom(digits), pickFrom(symbols)];
    const rest: string[] = [];
    for (let i = 0; i < length - required.length; i++) {
      rest.push(pickFrom(all));
    }
    const combined = [...required, ...rest];
    for (let i = combined.length - 1; i > 0; i--) {
      let j: number;
      if (cryptoObj && cryptoObj.getRandomValues) {
        const arr = new Uint32Array(1);
        cryptoObj.getRandomValues(arr);
        j = arr[0] % (i + 1);
      } else {
        j = Math.floor(Math.random() * (i + 1));
      }
      [combined[i], combined[j]] = [combined[j], combined[i]];
    }
    return combined.join("");
  }

  function openResetPasswordDialog(userId: string, email: string) {
    setResetPasswordTarget({ id: userId, email });
    setResetPasswordValue("");
    setResetPasswordError(null);
    setResetPasswordResult(null);
    setResetPasswordSubmitting(false);
    setResetPasswordCopied(false);
  }

  function closeResetPasswordDialog() {
    setResetPasswordTarget(null);
    setResetPasswordValue("");
    setResetPasswordError(null);
    setResetPasswordResult(null);
    setResetPasswordSubmitting(false);
    setResetPasswordCopied(false);
  }

  async function handleConfirmResetPassword() {
    if (!resetPasswordTarget) return;
    const newPassword = resetPasswordValue;
    if (!newPassword || newPassword.length < 12) {
      setResetPasswordError("Password must be at least 12 characters long.");
      return;
    }
    setResetPasswordSubmitting(true);
    setResetPasswordError(null);
    try {
      const res = await fetch(
        `/api/platform-admin/users/${resetPasswordTarget.id}/reset-password`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ newPassword }),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setResetPasswordError(data?.error || "Failed to reset password");
        return;
      }
      setResetPasswordResult({
        password: newPassword,
        sessionsRevoked: data.sessionsRevoked ?? 0,
      });
      setResetPasswordValue("");
    } catch (err: any) {
      setResetPasswordError(err?.message || "Failed to reset password");
    } finally {
      setResetPasswordSubmitting(false);
    }
  }

  async function copyResetPasswordToClipboard(value: string) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const ta = document.createElement("textarea");
        ta.value = value;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setResetPasswordCopied(true);
      setTimeout(() => setResetPasswordCopied(false), 2000);
    } catch (err) {
      console.error("Copy failed:", err);
    }
  }

  useEffect(() => {
    loadUsers();
  }, []);

  const loadUsers = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/platform-admin/users");
      const data = await res.json();
      if (data.ok) {
        setUsers(data.users || []);
      }
    } catch (err) {
      console.error("Error loading users:", err);
    } finally {
      setLoading(false);
    }
  };

  async function handleUserClick(userId: string) {
    setModalLoading(true);
    setLocationSearch("");
    setShowOtherLocations(false);
    try {
      const res = await fetch(`/api/platform-admin/users/${userId}`);
      if (res.ok) {
        const data = await res.json();
        setSelectedUser(data.user);
        setEditedRole(data.user.role);
        setEditedShopIds((data.user.shopIds || []).map((id: any) => String(id)));
        setEditedIsPlatformAdmin(data.user.isPlatformAdmin || false);
        setAllShops(data.shops || []);
        setUserEnterprise(data.enterprise || null);
      }
    } catch (err) {
      console.error("Failed to fetch user details:", err);
    } finally {
      setModalLoading(false);
    }
  }

  async function handleSaveUser() {
    if (!selectedUser) return;
    
    setSaving(true);
    try {
      const res = await fetch(`/api/platform-admin/users/${selectedUser._id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role: editedRole,
          shopId: selectedUser.shopId,
          shopIds: editedShopIds,
          isPlatformAdmin: editedIsPlatformAdmin,
        }),
      });
      
      if (res.ok) {
        setSelectedUser(null);
        loadUsers();
      } else {
        const data = await res.json();
        alert(data.error || "Failed to update");
      }
    } catch (err) {
      console.error("Failed to save:", err);
      alert("Failed to save changes");
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteUser() {
    if (!selectedUser) return;
    if (!confirm(`Are you sure you want to delete ${selectedUser.email}? This cannot be undone.`)) return;
    
    setSaving(true);
    try {
      const res = await fetch(`/api/platform-admin/users/${selectedUser._id}`, {
        method: "DELETE",
      });
      
      if (res.ok) {
        setSelectedUser(null);
        loadUsers();
      } else {
        const data = await res.json();
        alert(data.error || "Failed to delete");
      }
    } catch (err) {
      console.error("Failed to delete:", err);
      alert("Failed to delete user");
    } finally {
      setSaving(false);
    }
  }

  function toggleShopSelection(shopId: string) {
    setEditedShopIds(prev => 
      prev.includes(shopId)
        ? prev.filter(id => id !== shopId)
        : [...prev, shopId]
    );
  }

  const filteredUsers = users.filter(user => {
    const shopNamesMatch = user.shops?.some(s => 
      s.name?.toLowerCase().includes(search.toLowerCase()) ||
      s.locationIdentifier?.toLowerCase().includes(search.toLowerCase())
    );
    const matchesSearch = 
      user.email?.toLowerCase().includes(search.toLowerCase()) || shopNamesMatch;
    const matchesRole = roleFilter === "all" || user.role === roleFilter;
    return matchesSearch && matchesRole;
  });

  const roleColors: Record<string, string> = {
    owner: "bg-[rgba(60,129,195,0.15)] text-[#3c81c3]",
    admin: "bg-blue-100 text-blue-700",
    manager: "bg-green-100 text-green-700",
    user: "bg-gray-100 text-gray-700",
    viewer: "bg-yellow-100 text-yellow-700",
  };

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
          <h1 className="text-2xl font-bold text-gray-900">All Users</h1>
          <p className="text-gray-600">View and manage all users across all shops</p>
        </div>
        <button
          onClick={loadUsers}
          className="p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg"
        >
          <RefreshCw className="w-5 h-5" />
        </button>
      </div>

      <div className="flex gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
          <input
            type="text"
            placeholder="Search by email or shop name..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] focus:border-transparent"
          />
        </div>
        <select
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value)}
          className="px-4 py-2 border border-gray-300 rounded-lg bg-white"
        >
          <option value="all">All Roles</option>
          <option value="owner">Owner</option>
          <option value="admin">Admin</option>
          <option value="manager">Manager</option>
          <option value="user">User</option>
          <option value="viewer">Viewer</option>
        </select>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">User</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">Shops</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">Role</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">Created</th>
              <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filteredUsers.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-gray-500">
                  {search || roleFilter !== "all" ? "No users match your filters" : "No users yet"}
                </td>
              </tr>
            ) : (
              filteredUsers.map((user) => (
                <tr 
                  key={user._id} 
                  className="hover:bg-gray-50 cursor-pointer"
                  onClick={() => handleUserClick(user._id)}
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 bg-blue-100 rounded-full flex items-center justify-center">
                        <span className="text-blue-600 font-medium text-sm">
                          {user.email?.charAt(0).toUpperCase()}
                        </span>
                      </div>
                      <div>
                        <div className="font-medium text-gray-900">{user.email}</div>
                        {user.isPlatformAdmin && (
                          <span className="text-xs text-[#3c81c3] flex items-center gap-1">
                            <Shield className="w-3 h-3" />
                            Platform Admin
                          </span>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1 max-w-md">
                      {user.shops?.slice(0, 3).map((shop, idx) => (
                        <span key={String(shop.shopId)} className="inline-flex items-center px-2 py-0.5 bg-gray-100 text-gray-700 rounded text-xs">
                          {shop.name}
                          {shop.locationIdentifier && <span className="ml-1 text-gray-500">({shop.locationIdentifier})</span>}
                        </span>
                      ))}
                      {user.shops?.length > 3 && (
                        <span className="inline-flex items-center px-2 py-0.5 bg-[rgba(60,129,195,0.1)] text-[#3c81c3] rounded text-xs">
                          +{user.shops.length - 3} more
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-1 rounded text-xs font-medium capitalize ${roleColors[user.role] || roleColors.user}`}>
                      {user.role}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-600 text-sm">
                    {user.createdAt ? new Date(user.createdAt).toLocaleDateString() : "-"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        openResetPasswordDialog(user._id, user.email);
                      }}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-[#3c81c3] hover:bg-[rgba(60,129,195,0.1)] rounded-lg transition-colors"
                      title="Force-reset this user's password"
                    >
                      <KeyRound className="w-3.5 h-3.5" />
                      Reset password
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="text-sm text-gray-500">
        Showing {filteredUsers.length} of {users.length} users
      </div>

      {(selectedUser || modalLoading) && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full max-h-[85vh] overflow-hidden">
            {modalLoading ? (
              <div className="p-12 flex items-center justify-center">
                <Loader2 className="w-8 h-8 animate-spin text-[#3c81c3]" />
              </div>
            ) : selectedUser && (
              <>
                <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
                  <div>
                    <h2 className="text-lg font-semibold text-gray-900">Edit User</h2>
                    <p className="text-sm text-gray-500">{selectedUser.email}</p>
                  </div>
                  <button
                    onClick={() => setSelectedUser(null)}
                    className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>
                
                <div className="p-6 space-y-5 max-h-[55vh] overflow-y-auto">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Role
                    </label>
                    <select
                      value={editedRole}
                      onChange={(e) => setEditedRole(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] focus:border-transparent"
                    >
                      <option value="owner">Owner</option>
                      <option value="admin">Admin</option>
                      <option value="manager">Manager</option>
                      <option value="user">User</option>
                      <option value="viewer">Viewer</option>
                    </select>
                  </div>

                  <div>
                    <label className="flex items-center gap-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={editedIsPlatformAdmin}
                        onChange={(e) => setEditedIsPlatformAdmin(e.target.checked)}
                        className="w-4 h-4 text-[#3c81c3] rounded border-gray-300 focus:ring-[#3c81c3]"
                      />
                      <div>
                        <div className="font-medium text-gray-900 flex items-center gap-2">
                          <Shield className="w-4 h-4 text-[#3c81c3]" />
                          Platform Admin
                        </div>
                        <div className="text-xs text-gray-500">
                          Can access the platform admin panel
                        </div>
                      </div>
                    </label>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Primary Location
                    </label>
                    <select
                      value={String(selectedUser.shopId)}
                      onChange={(e) => {
                        const newPrimaryId = e.target.value;
                        const oldPrimaryId = String(selectedUser.shopId);
                        setSelectedUser({...selectedUser, shopId: newPrimaryId});
                        // Move old primary to shopIds if not already there
                        if (!editedShopIds.includes(oldPrimaryId)) {
                          setEditedShopIds(prev => [...prev, oldPrimaryId]);
                        }
                        // Remove new primary from shopIds
                        setEditedShopIds(prev => prev.filter(id => id !== newPrimaryId));
                      }}
                      className="w-full p-3 bg-[rgba(60,129,195,0.1)] rounded-lg border border-[rgba(60,129,195,0.3)] focus:ring-2 focus:ring-[#3c81c3] focus:border-transparent"
                    >
                      {allShops.map(shop => (
                        <option key={shop.shopId} value={shop.shopId}>
                          {shop.name}{shop.locationIdentifier ? ` (${shop.locationIdentifier})` : ''} - ID: {shop.shopId}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-gray-500 mt-1">This is the user's main shop for login</p>
                  </div>

                  {userEnterprise && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        {userEnterprise.name} Locations
                      </label>
                      <div className="space-y-1 border border-gray-200 rounded-lg p-2 max-h-[140px] overflow-y-auto">
                        {allShops
                          .filter(shop => shop.isInUserEnterprise && !shop.isUserPrimary)
                          .map(shop => (
                            <div
                              key={shop.shopId}
                              className={`flex items-center gap-3 p-2 rounded-lg ${editedShopIds.includes(shop.shopId) ? 'bg-[rgba(60,129,195,0.1)]' : 'hover:bg-gray-50'}`}
                            >
                              <input
                                type="checkbox"
                                checked={editedShopIds.includes(shop.shopId)}
                                onChange={() => toggleShopSelection(shop.shopId)}
                                className="w-4 h-4 text-[#3c81c3] rounded border-gray-300 focus:ring-[#3c81c3]"
                              />
                              <div className="flex-1 min-w-0">
                                <div className="font-medium text-gray-900 text-sm truncate">
                                  {shop.name}
                                  {shop.locationIdentifier && (
                                    <span className="ml-1 text-gray-500">({shop.locationIdentifier})</span>
                                  )}
                                </div>
                              </div>
                              {editedShopIds.includes(shop.shopId) && (
                                <button
                                  onClick={(e) => { e.preventDefault(); toggleShopSelection(shop.shopId); }}
                                  className="text-red-500 hover:text-red-700 p-1"
                                  title="Remove access"
                                >
                                  <X className="w-3 h-3" />
                                </button>
                              )}
                            </div>
                          ))}
                        {allShops.filter(s => s.isInUserEnterprise && !s.isUserPrimary).length === 0 && (
                          <p className="text-sm text-gray-500 text-center py-2">No other enterprise locations</p>
                        )}
                      </div>
                    </div>
                  )}

                  <div>
                    <button
                      type="button"
                      onClick={() => setShowOtherLocations(!showOtherLocations)}
                      className="flex items-center gap-2 text-sm font-medium text-gray-700 hover:text-gray-900 mb-2"
                    >
                      {showOtherLocations ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                      All Other Locations ({allShops.filter(s => !s.isInUserEnterprise && !s.isUserPrimary).length})
                    </button>
                    
                    {showOtherLocations && (
                      <div className="border border-gray-200 rounded-lg p-2 space-y-2">
                        <div className="relative">
                          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                          <input
                            type="text"
                            placeholder="Search locations..."
                            value={locationSearch}
                            onChange={(e) => setLocationSearch(e.target.value)}
                            className="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] focus:border-transparent"
                          />
                        </div>
                        <div className="max-h-[140px] overflow-y-auto space-y-1">
                          {allShops
                            .filter(shop => !shop.isInUserEnterprise && !shop.isUserPrimary)
                            .filter(shop => 
                              !locationSearch || 
                              shop.name.toLowerCase().includes(locationSearch.toLowerCase()) ||
                              shop.shopId.toLowerCase().includes(locationSearch.toLowerCase())
                            )
                            .map(shop => (
                              <div
                                key={shop.shopId}
                                className={`flex items-center gap-3 p-2 rounded-lg ${editedShopIds.includes(shop.shopId) ? 'bg-[rgba(60,129,195,0.1)]' : 'hover:bg-gray-50'}`}
                              >
                                <input
                                  type="checkbox"
                                  checked={editedShopIds.includes(shop.shopId)}
                                  onChange={() => toggleShopSelection(shop.shopId)}
                                  className="w-4 h-4 text-[#3c81c3] rounded border-gray-300 focus:ring-[#3c81c3]"
                                />
                                <div className="flex-1 min-w-0">
                                  <div className="font-medium text-gray-900 text-sm truncate">
                                    {shop.name}
                                    {shop.locationIdentifier && (
                                      <span className="ml-1 text-gray-500">({shop.locationIdentifier})</span>
                                    )}
                                  </div>
                                </div>
                                <div className="text-xs text-gray-400">ID: {shop.shopId}</div>
                                {editedShopIds.includes(shop.shopId) && (
                                  <button
                                    onClick={(e) => { e.preventDefault(); toggleShopSelection(shop.shopId); }}
                                    className="text-red-500 hover:text-red-700 p-1"
                                    title="Remove access"
                                  >
                                    <X className="w-3 h-3" />
                                  </button>
                                )}
                              </div>
                            ))}
                          {allShops.filter(s => !s.isInUserEnterprise && !s.isUserPrimary).filter(s => 
                            !locationSearch || s.name.toLowerCase().includes(locationSearch.toLowerCase())
                          ).length === 0 && (
                            <p className="text-sm text-gray-500 text-center py-2">
                              {locationSearch ? 'No locations match your search' : 'No other locations'}
                            </p>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  {editedShopIds.length > 0 && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        Selected Additional Locations ({editedShopIds.length})
                      </label>
                      <div className="flex flex-wrap gap-2">
                        {editedShopIds.map(shopId => {
                          const shop = allShops.find(s => s.shopId === shopId);
                          return (
                            <span
                              key={shopId}
                              className="inline-flex items-center gap-1 px-2 py-1 bg-[rgba(60,129,195,0.15)] text-[#3c81c3] rounded-full text-xs"
                            >
                              {shop?.name || `Shop ${shopId}`}
                              <button
                                onClick={() => toggleShopSelection(shopId)}
                                className="hover:text-[#3c81c3]"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  <div className="pt-2">
                    <div className="text-xs text-gray-500 space-y-1">
                      <div>Created: {selectedUser.createdAt ? new Date(selectedUser.createdAt).toLocaleString() : "Unknown"}</div>
                      {selectedUser.lastLogin && (
                        <div>Last login: {new Date(selectedUser.lastLogin).toLocaleString()}</div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-between">
                  <button
                    onClick={handleDeleteUser}
                    disabled={saving}
                    className="px-4 py-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2"
                  >
                    <Trash2 className="w-4 h-4" />
                    Delete
                  </button>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => setSelectedUser(null)}
                      className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleSaveUser}
                      disabled={saving}
                      className="px-4 py-2 bg-[rgba(60,129,195,0.75)] text-white rounded-lg hover:bg-[#3c81c3] transition-colors disabled:opacity-50 flex items-center gap-2"
                    >
                      {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                      Save Changes
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {resetPasswordTarget && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-md w-full overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                  <KeyRound className="w-5 h-5 text-[#3c81c3]" />
                  {resetPasswordResult ? "Password reset" : "Reset password"}
                </h2>
                <p className="text-sm text-gray-500 break-all">{resetPasswordTarget.email}</p>
              </div>
              <button
                onClick={closeResetPasswordDialog}
                className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-4">
              {!resetPasswordResult ? (
                <>
                  <div className="flex items-start gap-3 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                    <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
                    <div className="text-sm text-amber-900">
                      This will immediately replace the user's password and sign them out of all sessions everywhere.
                      Make sure you can deliver the new password to the user out-of-band.
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      New password
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={resetPasswordValue}
                        onChange={(e) => setResetPasswordValue(e.target.value)}
                        placeholder="Type a new password or generate one"
                        autoComplete="off"
                        className="flex-1 px-3 py-2 border border-gray-300 rounded-lg font-mono text-sm focus:ring-2 focus:ring-[#3c81c3] focus:border-transparent"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          setResetPasswordValue(generateStrongPassword(18));
                          setResetPasswordError(null);
                        }}
                        className="px-3 py-2 text-sm font-medium text-[#3c81c3] border border-[#3c81c3] rounded-lg hover:bg-[rgba(60,129,195,0.1)] transition-colors whitespace-nowrap"
                      >
                        Generate
                      </button>
                    </div>
                    <p className="text-xs text-gray-500 mt-1">
                      Must be at least 12 characters with a mix of upper/lower case, digits, and symbols.
                    </p>
                  </div>

                  {resetPasswordError && (
                    <div className="p-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg">
                      {resetPasswordError}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="flex items-start gap-3 p-3 bg-green-50 border border-green-200 rounded-lg">
                    <Check className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
                    <div className="text-sm text-green-900">
                      Password updated. {resetPasswordResult.sessionsRevoked > 0
                        ? `${resetPasswordResult.sessionsRevoked} active session${resetPasswordResult.sessionsRevoked === 1 ? "" : "s"} signed out.`
                        : "No active sessions to revoke."}
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      New password (shown once)
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        readOnly
                        value={resetPasswordResult.password}
                        className="flex-1 px-3 py-2 border border-gray-300 bg-gray-50 rounded-lg font-mono text-sm select-all"
                      />
                      <button
                        type="button"
                        onClick={() => copyResetPasswordToClipboard(resetPasswordResult.password)}
                        className="px-3 py-2 text-sm font-medium text-white bg-[#3c81c3] rounded-lg hover:bg-[rgba(60,129,195,0.85)] transition-colors flex items-center gap-1.5 whitespace-nowrap"
                      >
                        {resetPasswordCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                        {resetPasswordCopied ? "Copied" : "Copy"}
                      </button>
                    </div>
                    <p className="text-xs text-amber-700 mt-2 font-medium">
                      This password will not be shown again. Copy it now and deliver it to the user securely.
                    </p>
                  </div>
                </>
              )}
            </div>

            <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-end gap-3">
              {!resetPasswordResult ? (
                <>
                  <button
                    onClick={closeResetPasswordDialog}
                    disabled={resetPasswordSubmitting}
                    className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleConfirmResetPassword}
                    disabled={resetPasswordSubmitting || !resetPasswordValue}
                    className="px-4 py-2 bg-[rgba(60,129,195,0.75)] text-white rounded-lg hover:bg-[#3c81c3] transition-colors disabled:opacity-50 flex items-center gap-2"
                  >
                    {resetPasswordSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}
                    Reset password
                  </button>
                </>
              ) : (
                <button
                  onClick={closeResetPasswordDialog}
                  className="px-4 py-2 bg-[rgba(60,129,195,0.75)] text-white rounded-lg hover:bg-[#3c81c3] transition-colors"
                >
                  Done
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
