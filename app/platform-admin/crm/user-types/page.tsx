"use client";

import { useState, useEffect, useCallback } from "react";
import { Users, Plus, Edit2, Trash2, X, RefreshCw, GripVertical } from "lucide-react";

interface UserType {
  id: string;
  name: string;
  bucket: string;
  permissions: any;
  description: string | null;
  sortOrder: number;
  createdAt: string;
}

const bucketColors: Record<string, string> = {
  platform: "bg-purple-100 text-purple-700 border-purple-200",
  agency: "bg-blue-100 text-blue-700 border-blue-200",
  account: "bg-green-100 text-green-700 border-green-200",
};

const defaultPermissions = {
  dashboard: true, contacts: false, conversations: false,
  campaigns: false, billing: false, settings: false,
  reports: false, admin: false,
};

export default function UserTypesPage() {
  const [userTypes, setUserTypes] = useState<UserType[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterBucket, setFilterBucket] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<UserType | null>(null);
  const [form, setForm] = useState({
    name: "", bucket: "account", description: "", sortOrder: "0",
    permissions: { ...defaultPermissions },
  });

  const fetchUserTypes = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filterBucket) params.set("bucket", filterBucket);
      const res = await fetch(`/api/platform-admin/crm/user-types?${params}`);
      const data = await res.json();
      if (data.ok) setUserTypes(data.userTypes);
    } catch (e) { console.error(e); }
    setLoading(false);
  }, [filterBucket]);

  useEffect(() => { fetchUserTypes(); }, [fetchUserTypes]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const method = editing ? "PUT" : "POST";
    const payload: any = { ...form, sortOrder: parseInt(form.sortOrder) };
    if (editing) payload.id = editing.id;
    const res = await fetch("/api/platform-admin/crm/user-types", {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.ok) { setShowForm(false); setEditing(null); fetchUserTypes(); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this user type? This cannot be undone.")) return;
    await fetch(`/api/platform-admin/crm/user-types?id=${id}`, { method: "DELETE" });
    fetchUserTypes();
  };

  const openEdit = (ut: UserType) => {
    setEditing(ut);
    setForm({
      name: ut.name, bucket: ut.bucket, description: ut.description || "",
      sortOrder: ut.sortOrder.toString(),
      permissions: ut.permissions || { ...defaultPermissions },
    });
    setShowForm(true);
  };

  const openCreate = () => {
    setEditing(null);
    setForm({ name: "", bucket: "account", description: "", sortOrder: "0", permissions: { ...defaultPermissions } });
    setShowForm(true);
  };

  const togglePerm = (key: string) => {
    setForm({ ...form, permissions: { ...form.permissions, [key]: !form.permissions[key] } });
  };

  const grouped = {
    platform: userTypes.filter(u => u.bucket === "platform"),
    agency: userTypes.filter(u => u.bucket === "agency"),
    account: userTypes.filter(u => u.bucket === "account"),
  };

  const renderGroup = (label: string, bucket: string, items: UserType[]) => (
    <div key={bucket} className="mb-6">
      <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3 flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${bucket === "platform" ? "bg-purple-500" : bucket === "agency" ? "bg-blue-500" : "bg-green-500"}`} />
        {label} ({items.length})
      </h3>
      {items.length === 0 ? (
        <div className="text-sm text-gray-400 pl-4">No user types in this bucket</div>
      ) : (
        <div className="space-y-2">
          {items.map((ut) => (
            <div key={ut.id} className="bg-white rounded-lg border border-gray-200 p-4 flex items-center justify-between hover:shadow-sm transition-shadow">
              <div className="flex items-center gap-3">
                <GripVertical className="w-4 h-4 text-gray-300" />
                <div>
                  <div className="font-medium text-gray-900 flex items-center gap-2">
                    {ut.name}
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium border ${bucketColors[ut.bucket] || "bg-gray-100 text-gray-600"}`}>
                      {ut.bucket}
                    </span>
                  </div>
                  {ut.description && <div className="text-xs text-gray-400 mt-0.5">{ut.description}</div>}
                  {ut.permissions && (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {Object.entries(ut.permissions).filter(([, v]) => v).map(([k]) => (
                        <span key={k} className="px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded text-[10px]">{k}</span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button onClick={() => openEdit(ut)} className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded">
                  <Edit2 className="w-4 h-4" />
                </button>
                <button onClick={() => handleDelete(ut.id)} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Users className="w-7 h-7 text-blue-600" /> User Types
          </h1>
          <p className="text-gray-500 mt-1">Role definitions and permission templates</p>
        </div>
        <div className="flex items-center gap-2">
          <select value={filterBucket} onChange={(e) => setFilterBucket(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm">
            <option value="">All Buckets</option>
            <option value="platform">Platform</option>
            <option value="agency">Agency</option>
            <option value="account">Account</option>
          </select>
          <button onClick={fetchUserTypes} className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg">
            <RefreshCw className="w-4 h-4" />
          </button>
          <button onClick={openCreate} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">
            <Plus className="w-4 h-4" /> Add Type
          </button>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading user types...</div>
      ) : filterBucket ? (
        renderGroup(filterBucket.charAt(0).toUpperCase() + filterBucket.slice(1), filterBucket, userTypes)
      ) : (
        <>
          {renderGroup("Platform", "platform", grouped.platform)}
          {renderGroup("Agency", "agency", grouped.agency)}
          {renderGroup("Account", "account", grouped.account)}
        </>
      )}

      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-5 border-b">
              <h2 className="text-lg font-semibold">{editing ? "Edit User Type" : "New User Type"}</h2>
              <button onClick={() => { setShowForm(false); setEditing(null); }} className="p-1 hover:bg-gray-100 rounded-lg">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="p-5 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                <input type="text" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Bucket</label>
                  <select value={form.bucket} onChange={(e) => setForm({ ...form, bucket: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
                    <option value="platform">Platform</option>
                    <option value="agency">Agency</option>
                    <option value="account">Account</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Sort Order</label>
                  <input type="number" value={form.sortOrder} onChange={(e) => setForm({ ...form, sortOrder: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <input type="text" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Permissions</label>
                <div className="grid grid-cols-2 gap-2">
                  {Object.keys(form.permissions).map((key) => (
                    <label key={key} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-gray-50 p-1.5 rounded">
                      <input type="checkbox" checked={form.permissions[key]} onChange={() => togglePerm(key)}
                        className="rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                      <span className="capitalize">{key}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => { setShowForm(false); setEditing(null); }}
                  className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg text-sm">Cancel</button>
                <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm">
                  {editing ? "Save Changes" : "Create User Type"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
