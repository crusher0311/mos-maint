"use client";

import { useState, useEffect } from "react";
import { Plus, Pencil, Trash2, Loader2, X, CheckSquare } from "lucide-react";

interface Checklist {
  id: string;
  name: string;
  description: string | null;
  sortOrder: number;
}

export default function OnboardingChecklistsPage() {
  const [checklists, setChecklists] = useState<Checklist[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Checklist | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", sortOrder: 0 });

  const loadChecklists = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/platform-admin/onboarding/checklists");
      const data = await res.json();
      if (data.ok) setChecklists(data.checklists);
    } catch (error) {
      console.error("Error loading checklists:", error);
    }
    setLoading(false);
  };

  useEffect(() => { loadChecklists(); }, []);

  const openCreate = () => {
    setEditing(null);
    setForm({ name: "", description: "", sortOrder: checklists.length });
    setShowModal(true);
  };

  const openEdit = (checklist: Checklist) => {
    setEditing(checklist);
    setForm({ name: checklist.name, description: checklist.description || "", sortOrder: checklist.sortOrder });
    setShowModal(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const url = editing ? `/api/platform-admin/onboarding/checklists/${editing.id}` : "/api/platform-admin/onboarding/checklists";
      const method = editing ? "PATCH" : "POST";
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      if ((await res.json()).ok) {
        setShowModal(false);
        loadChecklists();
      }
    } catch (error) {
      console.error("Error saving checklist:", error);
    }
    setSaving(false);
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Archive this checklist item?")) return;
    try {
      await fetch(`/api/platform-admin/onboarding/checklists/${id}`, { method: "DELETE" });
      loadChecklists();
    } catch (error) {
      console.error("Error deleting checklist:", error);
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 animate-spin text-blue-600" /></div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Onboarding Checklists</h1>
          <p className="text-gray-500 mt-1">Define checklist items that can be attached to onboarding steps</p>
        </div>
        <button onClick={openCreate} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">
          <Plus className="w-4 h-4" /> Add Checklist Item
        </button>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Order</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Name</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Description</th>
              <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Actions</th>
            </tr>
          </thead>
          <tbody>
            {checklists.map(checklist => (
              <tr key={checklist.id} className="border-b hover:bg-gray-50">
                <td className="px-4 py-3 text-sm text-gray-500">{checklist.sortOrder}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <CheckSquare className="w-4 h-4 text-gray-400" />
                    <span className="font-medium text-gray-900">{checklist.name}</span>
                  </div>
                </td>
                <td className="px-4 py-3 text-sm text-gray-500">{checklist.description || "—"}</td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <button onClick={() => openEdit(checklist)} className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded"><Pencil className="w-4 h-4" /></button>
                    <button onClick={() => handleDelete(checklist.id)} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded"><Trash2 className="w-4 h-4" /></button>
                  </div>
                </td>
              </tr>
            ))}
            {checklists.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-12 text-center text-gray-400">No checklist items yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">{editing ? "Edit Checklist Item" : "New Checklist Item"}</h2>
              <button onClick={() => setShowModal(false)} className="p-1 hover:bg-gray-100 rounded"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full border border-gray-300 rounded-lg px-3 py-2" required />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="w-full border border-gray-300 rounded-lg px-3 py-2" rows={2} />
              </div>
              <div className="w-24">
                <label className="block text-sm font-medium text-gray-700 mb-1">Order</label>
                <input type="number" value={form.sortOrder} onChange={(e) => setForm({ ...form, sortOrder: parseInt(e.target.value) || 0 })} className="w-full border border-gray-300 rounded-lg px-3 py-2" />
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button onClick={() => setShowModal(false)} className="px-4 py-2 text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
                <button onClick={handleSave} disabled={saving || !form.name} className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : editing ? "Update" : "Create"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
