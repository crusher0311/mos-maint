"use client";

import { useState, useEffect } from "react";
import { Plus, Trash2, Loader2, X, Link2, Users } from "lucide-react";

interface ContentAssignment {
  id: string;
  contentType: string;
  contentId: string;
  userTypeId: string | null;
  assignAll: boolean | null;
  createdAt: string;
}

interface UserType {
  id: string;
  name: string;
}

interface ContentItem {
  id: string;
  name: string;
  type: string;
}

export default function ContentAssignmentsPage() {
  const [assignments, setAssignments] = useState<ContentAssignment[]>([]);
  const [userTypes, setUserTypes] = useState<UserType[]>([]);
  const [contentItems, setContentItems] = useState<ContentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ contentType: "tour", contentId: "", userTypeId: "", assignAll: false });

  const loadData = async () => {
    setLoading(true);
    try {
      const [assignmentsRes, userTypesRes, toursRes, guidesRes, bannersRes] = await Promise.all([
        fetch("/api/platform-admin/content-assignments"),
        fetch("/api/platform-admin/crm/user-types"),
        fetch("/api/platform-admin/tours"),
        fetch("/api/platform-admin/guides"),
        fetch("/api/platform-admin/banners"),
      ]);

      const assignmentsData = await assignmentsRes.json();
      const userTypesData = await userTypesRes.json();
      const toursData = await toursRes.json();
      const guidesData = await guidesRes.json();
      const bannersData = await bannersRes.json();

      if (assignmentsData.ok) setAssignments(assignmentsData.assignments);
      if (userTypesData.ok) setUserTypes(userTypesData.userTypes || []);

      const items: ContentItem[] = [];
      if (toursData.ok) toursData.tours.forEach((t: any) => items.push({ id: t.id, name: t.name, type: "tour" }));
      if (guidesData.ok) guidesData.guides.forEach((g: any) => items.push({ id: g.id, name: g.title, type: "guide" }));
      if (bannersData.ok) bannersData.banners.forEach((b: any) => items.push({ id: b.id, name: b.title, type: "banner" }));
      setContentItems(items);
    } catch (error) {
      console.error("Error loading data:", error);
    }
    setLoading(false);
  };

  useEffect(() => { loadData(); }, []);

  const handleCreate = async () => {
    setSaving(true);
    try {
      const payload: any = { contentType: form.contentType, contentId: form.contentId, assignAll: form.assignAll };
      if (form.userTypeId && !form.assignAll) payload.userTypeId = form.userTypeId;
      const res = await fetch("/api/platform-admin/content-assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if ((await res.json()).ok) {
        setShowModal(false);
        setForm({ contentType: "tour", contentId: "", userTypeId: "", assignAll: false });
        loadData();
      }
    } catch (error) {
      console.error("Error creating assignment:", error);
    }
    setSaving(false);
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Remove this assignment?")) return;
    try {
      await fetch("/api/platform-admin/content-assignments", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      loadData();
    } catch (error) {
      console.error("Error deleting assignment:", error);
    }
  };

  const getContentName = (type: string, id: string) => {
    const item = contentItems.find(i => i.id === id && i.type === type);
    return item?.name || id;
  };

  const getUserTypeName = (id: string | null) => {
    if (!id) return "—";
    const ut = userTypes.find(u => u.id === id);
    return ut?.name || id;
  };

  const filteredContentItems = contentItems.filter(i => i.type === form.contentType);

  const typeLabels: Record<string, string> = { tour: "Tour", guide: "Guide", banner: "Banner" };

  if (loading) {
    return <div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 animate-spin text-blue-600" /></div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Content Assignments</h1>
          <p className="text-gray-500 mt-1">Assign tours, guides, and banners to user types</p>
        </div>
        <button onClick={() => setShowModal(true)} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">
          <Plus className="w-4 h-4" /> New Assignment
        </button>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Content Type</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Content</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Assigned To</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Created</th>
              <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Actions</th>
            </tr>
          </thead>
          <tbody>
            {assignments.map(assignment => (
              <tr key={assignment.id} className="border-b hover:bg-gray-50">
                <td className="px-4 py-3">
                  <span className="px-2 py-0.5 text-xs rounded-full bg-blue-100 text-blue-700">{typeLabels[assignment.contentType] || assignment.contentType}</span>
                </td>
                <td className="px-4 py-3 font-medium text-gray-900">{getContentName(assignment.contentType, assignment.contentId)}</td>
                <td className="px-4 py-3 text-sm">
                  {assignment.assignAll ? (
                    <span className="flex items-center gap-1 text-green-700"><Users className="w-4 h-4" /> All Users</span>
                  ) : (
                    <span className="text-gray-700">{getUserTypeName(assignment.userTypeId)}</span>
                  )}
                </td>
                <td className="px-4 py-3 text-sm text-gray-500">{new Date(assignment.createdAt).toLocaleDateString()}</td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => handleDelete(assignment.id)} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded"><Trash2 className="w-4 h-4" /></button>
                </td>
              </tr>
            ))}
            {assignments.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-12 text-center text-gray-400">No content assignments yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">New Content Assignment</h2>
              <button onClick={() => setShowModal(false)} className="p-1 hover:bg-gray-100 rounded"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Content Type</label>
                <select value={form.contentType} onChange={(e) => setForm({ ...form, contentType: e.target.value, contentId: "" })} className="w-full border border-gray-300 rounded-lg px-3 py-2">
                  <option value="tour">Tour</option>
                  <option value="guide">Guide</option>
                  <option value="banner">Banner</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Content Item</label>
                <select value={form.contentId} onChange={(e) => setForm({ ...form, contentId: e.target.value })} className="w-full border border-gray-300 rounded-lg px-3 py-2">
                  <option value="">Select...</option>
                  {filteredContentItems.map(item => (
                    <option key={item.id} value={item.id}>{item.name}</option>
                  ))}
                </select>
              </div>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={form.assignAll} onChange={(e) => setForm({ ...form, assignAll: e.target.checked })} className="rounded" />
                <span className="text-sm text-gray-700">Assign to all users</span>
              </label>
              {!form.assignAll && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">User Type</label>
                  <select value={form.userTypeId} onChange={(e) => setForm({ ...form, userTypeId: e.target.value })} className="w-full border border-gray-300 rounded-lg px-3 py-2">
                    <option value="">Select user type...</option>
                    {userTypes.map(ut => (
                      <option key={ut.id} value={ut.id}>{ut.name}</option>
                    ))}
                  </select>
                </div>
              )}
              <div className="flex justify-end gap-3 pt-2">
                <button onClick={() => setShowModal(false)} className="px-4 py-2 text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
                <button onClick={handleCreate} disabled={saving || !form.contentId || (!form.assignAll && !form.userTypeId)} className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : "Create Assignment"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
