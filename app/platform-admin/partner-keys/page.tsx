"use client";

import { useState, useEffect, useCallback } from "react";
import {
  KeyRound,
  Plus,
  RefreshCw,
  Copy,
  Check,
  Shield,
  Clock,
  AlertTriangle,
  X,
  Loader2,
  Eye,
  EyeOff,
  Ban,
  RotateCcw,
} from "lucide-react";

interface PartnerKey {
  _id: string;
  partnerId: string;
  partnerName: string;
  keyPrefix: string;
  permissions: string[];
  rateLimitTier: string;
  rateLimit?: number;
  createdAt: string;
  createdBy: string;
  expiresAt?: string;
  revoked?: boolean;
  revokedAt?: string;
  revokedBy?: string;
  lastUsed?: string;
  usageCount?: number;
}

interface NewKeyResult {
  key: string;
  keyPrefix: string;
  partnerId: string;
  partnerName: string;
}

export default function PartnerKeysPage() {
  const [keys, setKeys] = useState<PartnerKey[]>([]);
  const [availablePermissions, setAvailablePermissions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newKeyResult, setNewKeyResult] = useState<NewKeyResult | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);
  const [showFullKey, setShowFullKey] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [formPartnerId, setFormPartnerId] = useState("");
  const [formPartnerName, setFormPartnerName] = useState("");
  const [formPermissions, setFormPermissions] = useState<string[]>(["*"]);
  const [formRateLimit, setFormRateLimit] = useState("");
  const [formExpiresAt, setFormExpiresAt] = useState("");
  const [formSubmitting, setFormSubmitting] = useState(false);

  const fetchKeys = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/platform-admin/partner-keys");
      if (!res.ok) {
        throw new Error(`API returned ${res.status}`);
      }
      const data = await res.json();
      if (data.success) {
        setKeys(data.partnerKeys || []);
        setAvailablePermissions(data.permissions || []);
      } else {
        throw new Error(data.error || "Unknown error");
      }
    } catch (err) {
      setError("Failed to fetch partner keys");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchKeys();
  }, [fetchKeys]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormSubmitting(true);
    setError(null);

    try {
      const res = await fetch("/api/platform-admin/partner-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          partnerId: formPartnerId.toLowerCase().replace(/\s+/g, "-"),
          partnerName: formPartnerName,
          permissions: formPermissions,
          rateLimit: formRateLimit ? Number(formRateLimit) : undefined,
          expiresAt: formExpiresAt || undefined,
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to create key");
        return;
      }

      setNewKeyResult({
        key: data.key,
        keyPrefix: data.keyPrefix,
        partnerId: data.partnerId,
        partnerName: data.partnerName,
      });
      setShowCreateModal(false);
      resetForm();
      fetchKeys();
    } catch (err) {
      setError("Failed to create partner key");
    } finally {
      setFormSubmitting(false);
    }
  };

  const handleAction = async (keyId: string, action: "revoke" | "reactivate") => {
    setActionLoading(keyId);
    try {
      const res = await fetch("/api/platform-admin/partner-keys", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keyId, action }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `Failed to ${action} key`);
        return;
      }
      fetchKeys();
    } catch (err) {
      setError(`Failed to ${action} key`);
    } finally {
      setActionLoading(null);
    }
  };

  const copyToClipboard = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 2000);
  };

  const resetForm = () => {
    setFormPartnerId("");
    setFormPartnerName("");
    setFormPermissions(["*"]);
    setFormRateLimit("");
    setFormExpiresAt("");
  };

  const togglePermission = (perm: string) => {
    if (perm === "*") {
      setFormPermissions(["*"]);
      return;
    }
    const filtered = formPermissions.filter((p) => p !== "*");
    if (filtered.includes(perm)) {
      const newPerms = filtered.filter((p) => p !== perm);
      setFormPermissions(newPerms.length === 0 ? ["*"] : newPerms);
    } else {
      setFormPermissions([...filtered, perm]);
    }
  };

  const getStatusBadge = (key: PartnerKey) => {
    if (key.revoked) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">
          <Ban className="w-3 h-3" />
          Revoked
        </span>
      );
    }
    if (key.expiresAt && new Date(key.expiresAt) < new Date()) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-700">
          <AlertTriangle className="w-3 h-3" />
          Expired
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
        <Shield className="w-3 h-3" />
        Active
      </span>
    );
  };

  const activeKeys = keys.filter((k) => !k.revoked && (!k.expiresAt || new Date(k.expiresAt) >= new Date()));
  const inactiveKeys = keys.filter((k) => k.revoked || (k.expiresAt && new Date(k.expiresAt) < new Date()));

  return (
    <div className="p-6 md:p-8 max-w-6xl mx-auto">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <KeyRound className="w-7 h-7 text-[#3c81c3]" />
            Partner API Keys
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Manage global API keys for integration partners. Partner keys are not shop-scoped — they resolve shops per-request via query parameters.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchKeys}
            disabled={loading}
            className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
          <button
            onClick={() => setShowCreateModal(true)}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors"
            style={{ backgroundColor: "#3c81c3" }}
          >
            <Plus className="w-4 h-4" />
            Create Partner Key
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-center justify-between">
          <div className="flex items-center gap-2 text-red-700 text-sm">
            <AlertTriangle className="w-4 h-4" />
            {error}
          </div>
          <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {newKeyResult && (
        <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-lg">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-green-800">
              Partner Key Created for {newKeyResult.partnerName}
            </h3>
            <button onClick={() => setNewKeyResult(null)} className="text-green-400 hover:text-green-600">
              <X className="w-4 h-4" />
            </button>
          </div>
          <p className="text-xs text-green-700 mb-3">
            Copy this key now — it will not be shown again.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 px-3 py-2 bg-white border border-green-300 rounded text-sm font-mono text-gray-900 break-all">
              {showFullKey ? newKeyResult.key : `${newKeyResult.key.slice(0, 20)}${"•".repeat(20)}`}
            </code>
            <button
              onClick={() => setShowFullKey(!showFullKey)}
              className="p-2 text-green-600 hover:bg-green-100 rounded transition-colors"
              title={showFullKey ? "Hide" : "Reveal"}
            >
              {showFullKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
            <button
              onClick={() => copyToClipboard(newKeyResult.key)}
              className="p-2 text-green-600 hover:bg-green-100 rounded transition-colors"
              title="Copy to clipboard"
            >
              {copiedKey ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-sm text-gray-500">Total Partner Keys</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">{keys.length}</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-sm text-gray-500">Active</div>
          <div className="text-2xl font-bold text-green-600 mt-1">{activeKeys.length}</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-sm text-gray-500">Revoked / Expired</div>
          <div className="text-2xl font-bold text-red-600 mt-1">{inactiveKeys.length}</div>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-[#3c81c3]" />
        </div>
      ) : keys.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-lg border border-gray-200">
          <KeyRound className="w-12 h-12 text-gray-300 mx-auto mb-3" />
          <h3 className="text-lg font-medium text-gray-900">No partner keys yet</h3>
          <p className="text-sm text-gray-500 mt-1">Create a partner key for integration partners like AppFueled.</p>
          <button
            onClick={() => setShowCreateModal(true)}
            className="mt-4 inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors"
            style={{ backgroundColor: "#3c81c3" }}
          >
            <Plus className="w-4 h-4" />
            Create Partner Key
          </button>
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider px-4 py-3">Partner</th>
                  <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider px-4 py-3">Key Prefix</th>
                  <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider px-4 py-3">Status</th>
                  <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider px-4 py-3">Permissions</th>
                  <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider px-4 py-3">Rate Limit</th>
                  <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider px-4 py-3">Created</th>
                  <th className="text-right text-xs font-medium text-gray-500 uppercase tracking-wider px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {keys.map((key) => (
                  <tr key={key._id} className={`hover:bg-gray-50 transition-colors ${key.revoked ? "opacity-60" : ""}`}>
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900 text-sm">{key.partnerName}</div>
                      <div className="text-xs text-gray-500">{key.partnerId}</div>
                    </td>
                    <td className="px-4 py-3">
                      <code className="text-xs font-mono bg-gray-100 px-2 py-1 rounded text-gray-700">
                        {key.keyPrefix}...
                      </code>
                    </td>
                    <td className="px-4 py-3">{getStatusBadge(key)}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {(key.permissions || ["*"]).map((p) => (
                          <span
                            key={p}
                            className="inline-block px-1.5 py-0.5 text-xs rounded bg-blue-50 text-blue-700 font-mono"
                          >
                            {p}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">
                      {key.rateLimit ? `${key.rateLimit}/min` : key.rateLimitTier || "enterprise"}
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-sm text-gray-600">
                        {new Date(key.createdAt).toLocaleDateString()}
                      </div>
                      <div className="text-xs text-gray-400">{key.createdBy}</div>
                      {key.expiresAt && (
                        <div className="text-xs text-gray-400 flex items-center gap-1 mt-0.5">
                          <Clock className="w-3 h-3" />
                          Expires {new Date(key.expiresAt).toLocaleDateString()}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {key.revoked ? (
                        <button
                          onClick={() => handleAction(key._id, "reactivate")}
                          disabled={actionLoading === key._id}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded-lg hover:bg-green-100 transition-colors disabled:opacity-50"
                        >
                          {actionLoading === key._id ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <RotateCcw className="w-3 h-3" />
                          )}
                          Reactivate
                        </button>
                      ) : (
                        <button
                          onClick={() => handleAction(key._id, "revoke")}
                          disabled={actionLoading === key._id}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 transition-colors disabled:opacity-50"
                        >
                          {actionLoading === key._id ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <Ban className="w-3 h-3" />
                          )}
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showCreateModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-5 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                <KeyRound className="w-5 h-5 text-[#3c81c3]" />
                Create Partner Key
              </h2>
              <button
                onClick={() => { setShowCreateModal(false); resetForm(); }}
                className="p-1 text-gray-400 hover:text-gray-600 rounded"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreate} className="p-5 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Partner ID</label>
                <input
                  type="text"
                  value={formPartnerId}
                  onChange={(e) => setFormPartnerId(e.target.value)}
                  placeholder="e.g., appfueled"
                  required
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#3c81c3] focus:border-transparent outline-none"
                />
                <p className="text-xs text-gray-400 mt-1">Lowercase identifier, no spaces</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Partner Name</label>
                <input
                  type="text"
                  value={formPartnerName}
                  onChange={(e) => setFormPartnerName(e.target.value)}
                  placeholder="e.g., AppFueled"
                  required
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#3c81c3] focus:border-transparent outline-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Permissions</label>
                <div className="space-y-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={formPermissions.includes("*")}
                      onChange={() => togglePermission("*")}
                      className="rounded border-gray-300 text-[#3c81c3] focus:ring-[#3c81c3]"
                    />
                    <span className="text-sm font-medium text-gray-700">All permissions (*)</span>
                  </label>
                  <div className="grid grid-cols-2 gap-2 pl-2">
                    {availablePermissions.map((perm) => (
                      <label key={perm} className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={formPermissions.includes("*") || formPermissions.includes(perm)}
                          disabled={formPermissions.includes("*")}
                          onChange={() => togglePermission(perm)}
                          className="rounded border-gray-300 text-[#3c81c3] focus:ring-[#3c81c3] disabled:opacity-40"
                        />
                        <span className="text-xs font-mono text-gray-600">{perm}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Custom Rate Limit (req/min)
                </label>
                <input
                  type="number"
                  value={formRateLimit}
                  onChange={(e) => setFormRateLimit(e.target.value)}
                  placeholder="Default: 1000 (enterprise tier)"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#3c81c3] focus:border-transparent outline-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Expiration Date (optional)
                </label>
                <input
                  type="date"
                  value={formExpiresAt}
                  onChange={(e) => setFormExpiresAt(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#3c81c3] focus:border-transparent outline-none"
                />
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => { setShowCreateModal(false); resetForm(); }}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={formSubmitting || !formPartnerId || !formPartnerName}
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors disabled:opacity-50"
                  style={{ backgroundColor: "#3c81c3" }}
                >
                  {formSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}
                  Create Key
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
