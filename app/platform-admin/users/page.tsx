"use client";

import { useState, useEffect } from "react";
import { Users, Search, RefreshCw, X, Loader2, Building, Shield, MapPin, Trash2, Mail, Clock, Key } from "lucide-react";

interface User {
  _id: string;
  email: string;
  role: string;
  shopId: number;
  shopName: string;
  shopIds?: string[];
  createdAt: string;
  isPlatformAdmin?: boolean;
}

interface Shop {
  shopId: string;
  name: string;
  location?: string;
}

interface UserModalData {
  _id: string;
  email: string;
  role: string;
  shopId: string;
  shopIds: string[];
  shopNames: { shopId: string; name: string }[];
  isPlatformAdmin: boolean;
  createdAt: string;
  lastLogin?: string;
}

interface PendingInvite {
  _id: string;
  emailLower: string;
  role: string;
  shopId: number;
  shopName?: string;
  createdAt: string;
  expiresAt: string;
}

export default function PlatformUsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>("all");
  const [selectedUser, setSelectedUser] = useState<UserModalData | null>(null);
  const [modalLoading, setModalLoading] = useState(false);
  const [allShops, setAllShops] = useState<Shop[]>([]);
  const [saving, setSaving] = useState(false);
  const [editedRole, setEditedRole] = useState("");
  const [editedShopIds, setEditedShopIds] = useState<string[]>([]);
  const [editedIsPlatformAdmin, setEditedIsPlatformAdmin] = useState(false);
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);
  const [resendingInvite, setResendingInvite] = useState<string | null>(null);
  const [showInvites, setShowInvites] = useState(false);
  const [resettingPassword, setResettingPassword] = useState(false);

  useEffect(() => {
    loadUsers();
    fetchAllShops();
    loadPendingInvites();
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

  async function fetchAllShops() {
    try {
      const res = await fetch("/api/shops/list?scope=all");
      if (res.ok) {
        const data = await res.json();
        setAllShops(data.shops || []);
      }
    } catch (err) {
      console.error("Failed to fetch shops:", err);
    }
  }

  async function loadPendingInvites() {
    try {
      const res = await fetch("/api/platform-admin/invites");
      if (res.ok) {
        const data = await res.json();
        setPendingInvites(data.invites || []);
      }
    } catch (err) {
      console.error("Failed to fetch invites:", err);
    }
  }

  async function handleResendInvite(inviteId: string) {
    setResendingInvite(inviteId);
    try {
      const res = await fetch(`/api/settings/invites/${inviteId}/resend`, {
        method: "POST",
      });
      const data = await res.json();
      if (res.ok) {
        loadPendingInvites();
        alert(data.emailSent 
          ? `Invitation resent to ${data.email}` 
          : `New invite link created, but email failed to send`);
      } else {
        alert(data.error || "Failed to resend invite");
      }
    } catch (err) {
      console.error("Failed to resend invite:", err);
      alert("Failed to resend invite");
    } finally {
      setResendingInvite(null);
    }
  }

  async function handleCancelInvite(inviteId: string) {
    if (!confirm("Cancel this pending invitation?")) return;
    try {
      const res = await fetch(`/api/settings/invites/${inviteId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setPendingInvites(prev => prev.filter(i => i._id !== inviteId));
      }
    } catch (err) {
      console.error("Failed to cancel invite:", err);
    }
  }

  async function handleResetPassword() {
    if (!selectedUser) return;
    if (!confirm(`Send a password reset email to ${selectedUser.email}?`)) return;
    
    setResettingPassword(true);
    try {
      const res = await fetch(`/api/platform-admin/users/${selectedUser._id}/reset-password`, {
        method: "POST",
      });
      const data = await res.json();
      if (res.ok) {
        alert(data.emailSent 
          ? `Password reset email sent to ${data.email}` 
          : `Reset link created, but email failed to send`);
      } else {
        alert(data.error || "Failed to send password reset");
      }
    } catch (err) {
      console.error("Failed to reset password:", err);
      alert("Failed to send password reset email");
    } finally {
      setResettingPassword(false);
    }
  }

  async function handleUserClick(userId: string) {
    setModalLoading(true);
    try {
      const res = await fetch(`/api/platform-admin/users/${userId}`);
      if (res.ok) {
        const data = await res.json();
        setSelectedUser(data.user);
        setEditedRole(data.user.role);
        setEditedShopIds(data.user.shopIds || []);
        setEditedIsPlatformAdmin(data.user.isPlatformAdmin || false);
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
    const matchesSearch = 
      user.email?.toLowerCase().includes(search.toLowerCase()) ||
      user.shopName?.toLowerCase().includes(search.toLowerCase());
    const matchesRole = roleFilter === "all" || user.role === roleFilter;
    return matchesSearch && matchesRole;
  });

  const roleColors: Record<string, string> = {
    owner: "bg-purple-100 text-purple-700",
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
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
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

      {pendingInvites.length > 0 && (
        <div className="bg-amber-50 rounded-xl border border-amber-200 overflow-hidden">
          <button
            onClick={() => setShowInvites(!showInvites)}
            className="w-full px-4 py-3 flex items-center justify-between hover:bg-amber-100 transition-colors"
          >
            <div className="flex items-center gap-2">
              <Clock className="w-5 h-5 text-amber-600" />
              <span className="font-medium text-amber-800">
                Pending Invitations ({pendingInvites.length})
              </span>
            </div>
            <span className="text-amber-600 text-sm">
              {showInvites ? "Hide" : "Show"}
            </span>
          </button>
          {showInvites && (
            <div className="border-t border-amber-200 divide-y divide-amber-100">
              {pendingInvites.map((invite) => {
                const isExpired = new Date(invite.expiresAt) < new Date();
                return (
                  <div key={invite._id} className="px-4 py-3 flex items-center justify-between bg-white">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 bg-amber-100 rounded-full flex items-center justify-center">
                        <Mail className="w-4 h-4 text-amber-600" />
                      </div>
                      <div>
                        <div className="font-medium text-gray-900">{invite.emailLower}</div>
                        <div className="text-xs text-gray-500 flex items-center gap-2">
                          <span>{invite.shopName || `Shop ${invite.shopId}`}</span>
                          <span>•</span>
                          <span className={isExpired ? "text-red-600 font-medium" : ""}>
                            {isExpired ? "Expired" : `Expires ${new Date(invite.expiresAt).toLocaleDateString()}`}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${roleColors[invite.role] || "bg-gray-100 text-gray-700"}`}>
                        {invite.role}
                      </span>
                      <button
                        onClick={() => handleResendInvite(invite._id)}
                        disabled={resendingInvite === invite._id}
                        className="p-1.5 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors disabled:opacity-50"
                        title="Resend invitation"
                      >
                        {resendingInvite === invite._id ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <RefreshCw className="w-4 h-4" />
                        )}
                      </button>
                      <button
                        onClick={() => handleCancelInvite(invite._id)}
                        className="p-1.5 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                        title="Cancel invitation"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">User</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">Shop</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">Role</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">Locations</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">Created</th>
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
                          <span className="text-xs text-purple-600 flex items-center gap-1">
                            <Shield className="w-3 h-3" />
                            Platform Admin
                          </span>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-gray-900">{user.shopName}</div>
                    <div className="text-xs text-gray-500">ID: {user.shopId}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-1 rounded text-xs font-medium capitalize ${roleColors[user.role] || roleColors.user}`}>
                      {user.role}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {user.shopIds && user.shopIds.length > 0 ? (
                      <span className="flex items-center gap-1 text-sm text-gray-600">
                        <MapPin className="w-3 h-3" />
                        {user.shopIds.length + 1}
                      </span>
                    ) : (
                      <span className="text-sm text-gray-400">1</span>
                    )}
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
                <Loader2 className="w-8 h-8 animate-spin text-purple-600" />
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
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
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
                        className="w-4 h-4 text-purple-600 rounded border-gray-300 focus:ring-purple-500"
                      />
                      <div>
                        <div className="font-medium text-gray-900 flex items-center gap-2">
                          <Shield className="w-4 h-4 text-purple-600" />
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
                    <div className="p-3 bg-gray-50 rounded-lg border border-gray-200">
                      <div className="flex items-center gap-2">
                        <Building className="w-4 h-4 text-gray-500" />
                        <span className="font-medium">
                          {allShops.find(s => String(s.shopId) === String(selectedUser.shopId))?.name || `Shop ${selectedUser.shopId}`}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Additional Location Access
                    </label>
                    <div className="space-y-2 max-h-[180px] overflow-y-auto border border-gray-200 rounded-lg p-2">
                      {allShops
                        .filter(shop => String(shop.shopId) !== String(selectedUser.shopId))
                        .map(shop => (
                          <label
                            key={shop.shopId}
                            className="flex items-center gap-3 p-2 rounded-lg hover:bg-gray-50 cursor-pointer"
                          >
                            <input
                              type="checkbox"
                              checked={editedShopIds.includes(String(shop.shopId))}
                              onChange={() => toggleShopSelection(String(shop.shopId))}
                              className="w-4 h-4 text-purple-600 rounded border-gray-300 focus:ring-purple-500"
                            />
                            <div className="flex-1 min-w-0">
                              <div className="font-medium text-gray-900 text-sm truncate">{shop.name}</div>
                              {shop.location && (
                                <div className="text-xs text-gray-500 truncate">{shop.location}</div>
                              )}
                            </div>
                            <div className="text-xs text-gray-400">ID: {shop.shopId}</div>
                          </label>
                        ))}
                      {allShops.filter(shop => String(shop.shopId) !== String(selectedUser.shopId)).length === 0 && (
                        <p className="text-sm text-gray-500 text-center py-4">
                          No other locations available
                        </p>
                      )}
                    </div>
                  </div>

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
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleDeleteUser}
                      disabled={saving || resettingPassword}
                      className="px-4 py-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2"
                    >
                      <Trash2 className="w-4 h-4" />
                      Delete
                    </button>
                    <button
                      onClick={handleResetPassword}
                      disabled={saving || resettingPassword}
                      className="px-4 py-2 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2"
                    >
                      {resettingPassword ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Key className="w-4 h-4" />
                      )}
                      Reset Password
                    </button>
                  </div>
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
                      className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors disabled:opacity-50 flex items-center gap-2"
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
