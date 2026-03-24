"use client";

import { useState, useEffect, useCallback } from "react";
import { Users, Plus, Edit2, Trash2, X, RefreshCw, Shield } from "lucide-react";

interface RoleType {
  id: string;
  name: string;
  description: string | null;
  sortOrder: number | null;
  createdAt: string;
}

export default function ContactRoleTypesPage() {
  const [roleTypes, setRoleTypes] = useState<RoleType[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<RoleType | null>(null);
  const [form, setForm] = useState({ name: "", description: "", sortOrder: 0 });

  const fetchRoleTypes = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/platform-admin/crm/contact-role-types");
      const data = await res.json();
      if (data.ok) setRoleTypes(data.roleTypes);
    } catch (e) { console.error(e); }
    setLoading(false);
  }, []);

  useEffect(() => { fetchRoleTypes(); }, [fetchRoleTypes]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const method = editing ? "PUT" : "POST";
    const body = editing ? { id: editing.id, ...form } : form;
    const res = await fetch("/api/platform-admin/crm/contact-role-types", {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.ok) { setShowForm(false); setEditing(null); fetchRoleTypes(); }
    else if (data.error) alert(data.error);
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this role type? It will be unlinked from any assignments.")) return;
    await fetch(`/api/platform-admin/crm/contact-role-types?id=${id}`, { method: "DELETE" });
    fetchRoleTypes();
  };

  const openEdit = (rt: RoleType) => {
    setEditing(rt);
    setForm({ name: rt.name, description: rt.description || "", sortOrder: rt.sortOrder || 0 });
    setShowForm(true);
  };

  const openCreate = () => {
    setEditing(null);
    setForm({ name: "", description: "", sortOrder: 0 });
    setShowForm(true);
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Shield className="w-7 h-7 text-blue-600" /> Contact Role Types
          </h1>
          <p className="text-gray-500 mt-1">Define roles for contact-to-entity assignments</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={fetchRoleTypes} className="p-2 text-gray-500 hover:text-gray-700 border border-gray-300 rounded-lg">
            <RefreshCw className="w-4 h-4" />
          </button>
          <button onClick={openCreate} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">
            <Plus className="w-4 h-4" /> Add Role Type
          </button>
        </div>
      </div>

      <div className="bg-white rounded-lg border overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading...</div>
        ) : roleTypes.length === 0 ? (
          <div className="p-8 text-center text-gray-500">No role types defined yet. Create one to get started.</div>
        ) : (
          <table className="w-full">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Name</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Description</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Sort Order</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {roleTypes.map((rt) => (
                <tr key={rt.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">{rt.name}</td>
                  <td className="px-4 py-3 text-sm text-gray-600">{rt.description || "—"}</td>
                  <td className="px-4 py-3 text-sm text-gray-600">{rt.sortOrder}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => openEdit(rt)} className="p-1.5 text-gray-400 hover:text-blue-600 rounded" title="Edit">
                        <Edit2 className="w-4 h-4" />
                      </button>
                      <button onClick={() => handleDelete(rt.id)} className="p-1.5 text-gray-400 hover:text-red-600 rounded" title="Delete">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
            <div className="flex items-center justify-between p-6 border-b">
              <h2 className="text-lg font-semibold">{editing ? "Edit Role Type" : "Add Role Type"}</h2>
              <button onClick={() => { setShowForm(false); setEditing(null); }} className="p-1 hover:bg-gray-100 rounded">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Name *</label>
                <input type="text" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500" placeholder="e.g. Owner, Manager, Billing Contact" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500" rows={2} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Sort Order</label>
                <input type="number" value={form.sortOrder} onChange={(e) => setForm({ ...form, sortOrder: parseInt(e.target.value) || 0 })}
                  className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500" />
              </div>
              <div className="flex justify-end gap-3 pt-4 border-t">
                <button type="button" onClick={() => { setShowForm(false); setEditing(null); }}
                  className="px-4 py-2 text-gray-700 border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">{editing ? "Save" : "Create"}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
