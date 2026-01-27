"use client";

import { useState, useEffect } from "react";
import { Users, Search, RefreshCw, X, Loader2, Building, Shield, MapPin, Trash2, ChevronDown, ChevronRight, Plus } from "lucide-react";

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
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filteredUsers.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-gray-500">
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
    </div>
  );
}
