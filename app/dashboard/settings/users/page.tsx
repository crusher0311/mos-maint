"use client";

import { useState, useEffect } from "react";
import { Users, Plus, Mail, Shield, Trash2, Loader2, UserPlus, X, MapPin, Building, History, RefreshCw } from "lucide-react";
import Link from "next/link";

interface ShopUser {
  _id: string;
  email: string;
  role: string;
  shopId: string;
  shopIds?: string[];
  createdAt: string;
  lastLogin?: string;
}

interface PendingInvite {
  _id: string;
  emailLower: string;
  role: string;
  createdAt: string;
  expiresAt: string;
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
  preferences?: {
    jobHistory?: {
      enabled: boolean;
      priorityShopIds: number[];
      excludeOthers: boolean;
    };
  };
}

export default function UsersSettingsPage() {
  const [users, setUsers] = useState<ShopUser[]>([]);
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentUserRole, setCurrentUserRole] = useState<string>("");
  const [selectedUser, setSelectedUser] = useState<UserModalData | null>(null);
  const [modalLoading, setModalLoading] = useState(false);
  const [allShops, setAllShops] = useState<Shop[]>([]);
  const [saving, setSaving] = useState(false);
  const [selectedShopIds, setSelectedShopIds] = useState<string[]>([]);
  const [resendingInvite, setResendingInvite] = useState<string | null>(null);

  useEffect(() => {
    fetchUsers();
    fetchAllShops();
  }, []);

  async function fetchUsers() {
    try {
      const res = await fetch("/api/settings/users");
      if (res.ok) {
        const data = await res.json();
        setUsers(data.users || []);
        setInvites(data.pendingInvites || []);
        setCurrentUserRole(data.currentUserRole || "");
      }
    } catch (err) {
      console.error("Failed to fetch users:", err);
    } finally {
      setLoading(false);
    }
  }

  async function fetchAllShops() {
    try {
      const res = await fetch("/api/shops/list");
      if (res.ok) {
        const data = await res.json();
        setAllShops(data.shops || []);
      }
    } catch (err) {
      console.error("Failed to fetch shops:", err);
    }
  }

  async function handleUserClick(userId: string) {
    if (!canManageUsers) return;
    
    setModalLoading(true);
    try {
      const res = await fetch(`/api/settings/users/${userId}`);
      if (res.ok) {
        const data = await res.json();
        setSelectedUser(data.user);
        setSelectedShopIds(data.user.shopIds || []);
      }
    } catch (err) {
      console.error("Failed to fetch user details:", err);
    } finally {
      setModalLoading(false);
    }
  }

  async function handleSaveLocations() {
    if (!selectedUser) return;
    
    setSaving(true);
    try {
      const res = await fetch(`/api/settings/users/${selectedUser._id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shopIds: selectedShopIds }),
      });
      
      if (res.ok) {
        setSelectedUser(null);
        fetchUsers();
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

  function toggleShopSelection(shopId: string) {
    setSelectedShopIds(prev => 
      prev.includes(shopId)
        ? prev.filter(id => id !== shopId)
        : [...prev, shopId]
    );
  }

  async function handleRemoveUser(userId: string) {
    if (!confirm("Are you sure you want to remove this user?")) return;
    
    try {
      const res = await fetch(`/api/settings/users/${userId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setUsers(users.filter(u => u._id !== userId));
      }
    } catch (err) {
      console.error("Failed to remove user:", err);
    }
  }

  async function handleCancelInvite(inviteId: string) {
    try {
      const res = await fetch(`/api/settings/invites/${inviteId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setInvites(invites.filter(i => i._id !== inviteId));
      }
    } catch (err) {
      console.error("Failed to cancel invite:", err);
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
        fetchUsers();
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

  const canManageUsers = currentUserRole === "owner" || currentUserRole === "admin";

  const roleColors: Record<string, string> = {
    owner: "bg-purple-100 text-purple-800",
    admin: "bg-red-100 text-red-800",
    manager: "bg-blue-100 text-blue-800",
    user: "bg-green-100 text-green-800",
    viewer: "bg-gray-100 text-gray-800",
  };

  if (loading) {
    return (
      <div className="flex-1 p-8">
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 p-8 overflow-auto">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-100 rounded-lg">
              <Users className="w-6 h-6 text-blue-600" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Users</h1>
              <p className="text-sm text-gray-500">Manage team members and permissions</p>
            </div>
          </div>
          {canManageUsers && (
            <Link
              href="/dashboard/invite"
              className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              <UserPlus className="w-4 h-4" />
              Invite User
            </Link>
          )}
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200">
            <h2 className="text-lg font-semibold text-gray-900">Team Members</h2>
            {canManageUsers && (
              <p className="text-sm text-gray-500 mt-1">Click on a user to manage their location access</p>
            )}
          </div>
          <div className="divide-y divide-gray-200">
            {users.length === 0 ? (
              <div className="px-6 py-8 text-center text-gray-500">
                No team members yet
              </div>
            ) : (
              users.map((user) => (
                <div 
                  key={user._id} 
                  className={`px-6 py-4 flex items-center justify-between ${canManageUsers ? "cursor-pointer hover:bg-gray-50" : ""}`}
                  onClick={() => handleUserClick(user._id)}
                >
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-full bg-blue-600 flex items-center justify-center">
                      <span className="text-white font-medium">
                        {user.email?.charAt(0)?.toUpperCase() || "U"}
                      </span>
                    </div>
                    <div>
                      <p className="font-medium text-gray-900">{user.email}</p>
                      <div className="flex items-center gap-2 text-sm text-gray-500">
                        <span>Joined {new Date(user.createdAt).toLocaleDateString()}</span>
                        {user.shopIds && user.shopIds.length > 0 && (
                          <>
                            <span>•</span>
                            <span className="flex items-center gap-1">
                              <MapPin className="w-3 h-3" />
                              {user.shopIds.length + 1} location{user.shopIds.length > 0 ? "s" : ""}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className={`px-3 py-1 rounded-full text-xs font-medium ${roleColors[user.role] || roleColors.viewer}`}>
                      {user.role}
                    </span>
                    {canManageUsers && user.role !== "owner" && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRemoveUser(user._id);
                        }}
                        className="p-2 text-gray-400 hover:text-red-600 transition-colors"
                        title="Remove user"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {invites.length > 0 && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-900">Pending Invites</h2>
            </div>
            <div className="divide-y divide-gray-200">
              {invites.map((invite) => (
                <div key={invite._id} className="px-6 py-4 flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center">
                      <Mail className="w-5 h-5 text-gray-500" />
                    </div>
                    <div>
                      <p className="font-medium text-gray-900">{invite.emailLower}</p>
                      <p className="text-sm text-gray-500">
                        Expires {new Date(invite.expiresAt).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`px-3 py-1 rounded-full text-xs font-medium ${roleColors[invite.role] || roleColors.viewer}`}>
                      {invite.role}
                    </span>
                    {canManageUsers && (
                      <>
                        <button
                          onClick={() => handleResendInvite(invite._id)}
                          disabled={resendingInvite === invite._id}
                          className="p-2 text-gray-400 hover:text-blue-600 transition-colors disabled:opacity-50"
                          title="Resend invite"
                        >
                          {resendingInvite === invite._id ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <RefreshCw className="w-4 h-4" />
                          )}
                        </button>
                        <button
                          onClick={() => handleCancelInvite(invite._id)}
                          className="p-2 text-gray-400 hover:text-red-600 transition-colors"
                          title="Cancel invite"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="bg-blue-50 rounded-xl p-6 border border-blue-100">
          <h3 className="font-semibold text-blue-900 mb-2">Role Permissions</h3>
          <ul className="space-y-2 text-sm text-blue-800">
            <li><strong>Owner:</strong> Full access, can manage users and billing</li>
            <li><strong>Manager:</strong> Can manage vehicles and view all data</li>
            <li><strong>User:</strong> Can view and update vehicle recommendations</li>
            <li><strong>Viewer:</strong> Read-only access to vehicle data</li>
          </ul>
        </div>
      </div>

      {selectedUser && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full max-h-[80vh] overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Edit Location Access</h2>
                <p className="text-sm text-gray-500">{selectedUser.email}</p>
              </div>
              <button
                onClick={() => setSelectedUser(null)}
                className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="p-6 space-y-4 max-h-[50vh] overflow-y-auto">
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
                  <p className="text-xs text-gray-500 mt-1">Primary location cannot be changed</p>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Additional Location Access
                </label>
                <p className="text-xs text-gray-500 mb-3">
                  Select locations this user can also access
                </p>
                <div className="space-y-2 max-h-[200px] overflow-y-auto">
                  {allShops
                    .filter(shop => String(shop.shopId) !== String(selectedUser.shopId))
                    .map(shop => (
                      <label
                        key={shop.shopId}
                        className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 hover:bg-gray-50 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={selectedShopIds.includes(String(shop.shopId))}
                          onChange={() => toggleShopSelection(String(shop.shopId))}
                          className="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
                        />
                        <div>
                          <div className="font-medium text-gray-900">{shop.name}</div>
                          {shop.location && (
                            <div className="text-xs text-gray-500">{shop.location}</div>
                          )}
                        </div>
                      </label>
                    ))}
                  {allShops.filter(shop => String(shop.shopId) !== String(selectedUser.shopId)).length === 0 && (
                    <p className="text-sm text-gray-500 text-center py-4">
                      No other locations available
                    </p>
                  )}
                </div>
              </div>

              {allShops.length > 1 && (
                <div className="pt-2 border-t border-gray-200">
                  <div className="flex items-start gap-3 p-3 bg-blue-50 rounded-lg">
                    <History className="w-5 h-5 text-blue-600 mt-0.5" />
                    <div>
                      <p className="text-sm font-medium text-blue-900">Job History Priority</p>
                      <p className="text-xs text-blue-700 mt-1">
                        Users can set their preferred location order for job history search results in{" "}
                        <Link href="/dashboard/settings/job-history" className="underline font-medium">
                          Settings &gt; Preferences &gt; Job History
                        </Link>
                      </p>
                      {selectedUser.preferences?.jobHistory?.enabled && (
                        <p className="text-xs text-blue-600 mt-1">
                          This user has custom location priority enabled
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-end gap-3">
              <button
                onClick={() => setSelectedUser(null)}
                className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveLocations}
                disabled={saving}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
