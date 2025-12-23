"use client";

import { useState, useEffect } from "react";
import { Users, Plus, Mail, Shield, Trash2, Loader2, UserPlus } from "lucide-react";
import Link from "next/link";

interface ShopUser {
  _id: string;
  email: string;
  role: string;
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

export default function UsersSettingsPage() {
  const [users, setUsers] = useState<ShopUser[]>([]);
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentUserRole, setCurrentUserRole] = useState<string>("");

  useEffect(() => {
    fetchUsers();
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

  const canManageUsers = currentUserRole === "owner" || currentUserRole === "admin";

  const roleColors: Record<string, string> = {
    owner: "bg-purple-100 text-purple-800",
    admin: "bg-red-100 text-red-800",
    manager: "bg-blue-100 text-blue-800",
    staff: "bg-green-100 text-green-800",
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
          </div>
          <div className="divide-y divide-gray-200">
            {users.length === 0 ? (
              <div className="px-6 py-8 text-center text-gray-500">
                No team members yet
              </div>
            ) : (
              users.map((user) => (
                <div key={user._id} className="px-6 py-4 flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-full bg-blue-600 flex items-center justify-center">
                      <span className="text-white font-medium">
                        {user.email?.charAt(0)?.toUpperCase() || "U"}
                      </span>
                    </div>
                    <div>
                      <p className="font-medium text-gray-900">{user.email}</p>
                      <p className="text-sm text-gray-500">
                        Joined {new Date(user.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className={`px-3 py-1 rounded-full text-xs font-medium ${roleColors[user.role] || roleColors.viewer}`}>
                      {user.role}
                    </span>
                    {canManageUsers && user.role !== "owner" && (
                      <button
                        onClick={() => handleRemoveUser(user._id)}
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
                  <div className="flex items-center gap-4">
                    <span className={`px-3 py-1 rounded-full text-xs font-medium ${roleColors[invite.role] || roleColors.viewer}`}>
                      {invite.role}
                    </span>
                    {canManageUsers && (
                      <button
                        onClick={() => handleCancelInvite(invite._id)}
                        className="p-2 text-gray-400 hover:text-red-600 transition-colors"
                        title="Cancel invite"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
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
            <li><strong>Staff:</strong> Can view and update vehicle recommendations</li>
            <li><strong>Viewer:</strong> Read-only access to vehicle data</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
