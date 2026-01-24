"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Key, Plus, Trash2, Copy, AlertCircle, Loader2 } from "lucide-react";

interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  permissions: string[];
  rateLimit: number;
  isActive: boolean;
  usageCount: number;
  lastUsedAt?: string;
  createdAt: string;
  createdBy: string;
  expiresAt?: string;
}

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [availablePermissions, setAvailablePermissions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newKeyResult, setNewKeyResult] = useState<{ key: string; keyPrefix: string } | null>(null);
  const [formData, setFormData] = useState({
    name: "",
    permissions: [] as string[],
    rateLimit: 100,
  });

  useEffect(() => {
    fetchKeys();
  }, []);

  async function fetchKeys() {
    try {
      const res = await fetch("/api/settings/api-keys");
      const data = await res.json();
      if (data.keys) {
        setKeys(data.keys);
        setAvailablePermissions(data.availablePermissions || []);
      }
    } catch (err) {
      console.error("Failed to fetch API keys:", err);
    } finally {
      setLoading(false);
    }
  }

  async function createKey() {
    try {
      const res = await fetch("/api/settings/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });
      const data = await res.json();
      if (data.success) {
        setNewKeyResult({ key: data.key, keyPrefix: data.keyPrefix });
        setFormData({ name: "", permissions: [], rateLimit: 100 });
        fetchKeys();
      } else {
        alert(data.error || "Failed to create key");
      }
    } catch (err) {
      console.error("Failed to create key:", err);
    }
  }

  async function revokeKey(keyId: string) {
    if (!confirm("Are you sure you want to revoke this API key? This cannot be undone.")) {
      return;
    }
    try {
      const res = await fetch(`/api/settings/api-keys?keyId=${keyId}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (data.success) {
        fetchKeys();
      } else {
        alert(data.error || "Failed to revoke key");
      }
    } catch (err) {
      console.error("Failed to revoke key:", err);
    }
  }

  function togglePermission(perm: string) {
    setFormData(prev => ({
      ...prev,
      permissions: prev.permissions.includes(perm)
        ? prev.permissions.filter(p => p !== perm)
        : [...prev.permissions, perm],
    }));
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
    alert("Copied to clipboard!");
  }

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
        <span className="ml-2">Loading...</span>
      </div>
    );
  }

  return (
    <div>
      <div className="p-6 max-w-6xl mx-auto">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">API Keys</h1>
            <p className="text-gray-600 mt-1">
              Manage API keys for external integrations
            </p>
          </div>
          <button
            onClick={() => setShowCreateModal(true)}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            Create API Key
          </button>
        </div>

        {newKeyResult && (
          <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-lg">
            <h3 className="font-semibold text-green-800 mb-2">New API Key Created!</h3>
            <p className="text-sm text-green-700 mb-2">
              Copy this key now. You won't be able to see it again.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 p-2 bg-white border rounded font-mono text-sm break-all">
                {newKeyResult.key}
              </code>
              <button
                onClick={() => copyToClipboard(newKeyResult.key)}
                className="px-3 py-2 bg-green-600 text-white rounded hover:bg-green-700"
              >
                Copy
              </button>
            </div>
            <button
              onClick={() => setNewKeyResult(null)}
              className="mt-2 text-sm text-green-600 hover:underline"
            >
              Dismiss
            </button>
          </div>
        )}

        <div className="bg-white rounded-lg shadow overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Key Prefix</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Permissions</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Usage</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {keys.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-center text-gray-500">
                    No API keys yet. Create one to get started.
                  </td>
                </tr>
              ) : (
                keys.map((key) => (
                  <tr key={key.id}>
                    <td className="px-6 py-4">
                      <div className="font-medium text-gray-900">{key.name}</div>
                      <div className="text-sm text-gray-500">
                        Created {new Date(key.createdAt).toLocaleDateString()}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <code className="text-sm bg-gray-100 px-2 py-1 rounded">
                        {key.keyPrefix}...
                      </code>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex flex-wrap gap-1">
                        {key.permissions.slice(0, 2).map((perm) => (
                          <span
                            key={perm}
                            className="text-xs bg-blue-100 text-blue-800 px-2 py-0.5 rounded"
                          >
                            {perm.split(":")[0]}
                          </span>
                        ))}
                        {key.permissions.length > 2 && (
                          <span className="text-xs text-gray-500">
                            +{key.permissions.length - 2} more
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-600">
                      {key.usageCount} calls
                      {key.lastUsedAt && (
                        <div className="text-xs text-gray-400">
                          Last: {new Date(key.lastUsedAt).toLocaleDateString()}
                        </div>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      <span
                        className={`px-2 py-1 text-xs rounded-full ${
                          key.isActive
                            ? "bg-green-100 text-green-800"
                            : "bg-red-100 text-red-800"
                        }`}
                      >
                        {key.isActive ? "Active" : "Revoked"}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      {key.isActive && (
                        <button
                          onClick={() => revokeKey(key.id)}
                          className="text-red-600 hover:text-red-800 text-sm"
                        >
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="mt-8 bg-gray-50 rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-4">API Documentation</h2>
          <div className="space-y-4 text-sm">
            <div>
              <h3 className="font-medium">Authentication</h3>
              <p className="text-gray-600">
                Include your API key in the request header:
              </p>
              <code className="block mt-1 p-2 bg-white border rounded">
                Authorization: Bearer mos_your_api_key_here
              </code>
            </div>
            <div>
              <h3 className="font-medium">Available Endpoints</h3>
              <ul className="mt-2 space-y-2 text-gray-600">
                <li><code className="bg-white px-1">POST /api/external/appointments</code> - Create appointment</li>
                <li><code className="bg-white px-1">GET /api/external/appointments</code> - List appointments</li>
                <li><code className="bg-white px-1">POST /api/external/stickers</code> - Generate sticker</li>
                <li><code className="bg-white px-1">POST /api/external/keytags</code> - Generate keytag</li>
                <li><code className="bg-white px-1">GET /api/external/vehicles/:vin</code> - Get vehicle info</li>
                <li><code className="bg-white px-1">GET /api/external/vehicles/:vin/maintenance</code> - Get maintenance schedule</li>
                <li><code className="bg-white px-1">GET /api/external/recommendations/:vin</code> - Get recommendations</li>
              </ul>
            </div>
          </div>
        </div>

        {showCreateModal && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
              <h2 className="text-xl font-semibold mb-4">Create API Key</h2>
              
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Name
                  </label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    className="w-full border rounded-lg px-3 py-2"
                    placeholder="e.g., CRM Integration"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Rate Limit (requests/minute)
                  </label>
                  <input
                    type="number"
                    value={formData.rateLimit}
                    onChange={(e) => setFormData({ ...formData, rateLimit: Number(e.target.value) })}
                    className="w-full border rounded-lg px-3 py-2"
                    min={1}
                    max={1000}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Permissions
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    {availablePermissions.map((perm) => (
                      <label key={perm} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={formData.permissions.includes(perm)}
                          onChange={() => togglePermission(perm)}
                          className="rounded"
                        />
                        <span className="text-sm">{perm}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>

              <div className="flex justify-end gap-3 mt-6">
                <button
                  onClick={() => {
                    setShowCreateModal(false);
                    setFormData({ name: "", permissions: [], rateLimit: 100 });
                  }}
                  className="px-4 py-2 border rounded-lg hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    createKey();
                    setShowCreateModal(false);
                  }}
                  disabled={!formData.name || formData.permissions.length === 0}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                >
                  Create Key
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
