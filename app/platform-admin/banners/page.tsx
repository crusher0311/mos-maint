"use client";

import { useState, useEffect } from "react";
import { Plus, Pencil, Trash2, Loader2, X, Flag, AlertTriangle, Info, CheckCircle2 } from "lucide-react";

interface Banner {
  id: string;
  title: string;
  message: string;
  type: string;
  linkUrl: string | null;
  linkText: string | null;
  status: string;
  startsAt: string | null;
  endsAt: string | null;
  sortOrder: number;
}

export default function BannersPage() {
  const [bannersList, setBannersList] = useState<Banner[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Banner | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    title: "", message: "", type: "info", linkUrl: "", linkText: "", status: "draft", startsAt: "", endsAt: "", sortOrder: 0,
  });

  const loadBanners = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/platform-admin/banners");
      const data = await res.json();
      if (data.ok) setBannersList(data.banners);
    } catch (error) {
      console.error("Error loading banners:", error);
    }
    setLoading(false);
  };

  useEffect(() => { loadBanners(); }, []);

  const openCreate = () => {
    setEditing(null);
    setForm({ title: "", message: "", type: "info", linkUrl: "", linkText: "", status: "draft", startsAt: "", endsAt: "", sortOrder: bannersList.length });
    setShowModal(true);
  };

  const openEdit = (banner: Banner) => {
    setEditing(banner);
    setForm({
      title: banner.title, message: banner.message, type: banner.type, linkUrl: banner.linkUrl || "",
      linkText: banner.linkText || "", status: banner.status,
      startsAt: banner.startsAt ? banner.startsAt.split("T")[0] : "",
      endsAt: banner.endsAt ? banner.endsAt.split("T")[0] : "",
      sortOrder: banner.sortOrder,
    });
    setShowModal(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload: any = { ...form };
      if (payload.startsAt) payload.startsAt = new Date(payload.startsAt).toISOString();
      else delete payload.startsAt;
      if (payload.endsAt) payload.endsAt = new Date(payload.endsAt).toISOString();
      else delete payload.endsAt;
      if (!payload.linkUrl) delete payload.linkUrl;
      if (!payload.linkText) delete payload.linkText;

      const url = editing ? `/api/platform-admin/banners/${editing.id}` : "/api/platform-admin/banners";
      const method = editing ? "PATCH" : "POST";
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if ((await res.json()).ok) {
        setShowModal(false);
        loadBanners();
      }
    } catch (error) {
      console.error("Error saving banner:", error);
    }
    setSaving(false);
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Archive this banner?")) return;
    try {
      await fetch(`/api/platform-admin/banners/${id}`, { method: "DELETE" });
      loadBanners();
    } catch (error) {
      console.error("Error deleting banner:", error);
    }
  };

  const typeIcons: Record<string, any> = {
    info: Info,
    warning: AlertTriangle,
    success: CheckCircle2,
    error: AlertTriangle,
  };

  const typeColors: Record<string, string> = {
    info: "bg-blue-50 border-blue-200 text-blue-800",
    warning: "bg-yellow-50 border-yellow-200 text-yellow-800",
    success: "bg-green-50 border-green-200 text-green-800",
    error: "bg-red-50 border-red-200 text-red-800",
  };

  const statusColors: Record<string, string> = {
    draft: "bg-gray-100 text-gray-700",
    active: "bg-green-100 text-green-700",
    inactive: "bg-red-100 text-red-700",
  };

  if (loading) {
    return <div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 animate-spin text-blue-600" /></div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Banners</h1>
          <p className="text-gray-500 mt-1">Manage in-app banners shown to users</p>
        </div>
        <button onClick={openCreate} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">
          <Plus className="w-4 h-4" /> New Banner
        </button>
      </div>

      <div className="space-y-3">
        {bannersList.map(banner => {
          const TypeIcon = typeIcons[banner.type] || Info;
          return (
            <div key={banner.id} className={`rounded-lg border p-4 ${typeColors[banner.type] || typeColors.info}`}>
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-3">
                  <TypeIcon className="w-5 h-5 mt-0.5 flex-shrink-0" />
                  <div>
                    <h3 className="font-medium">{banner.title}</h3>
                    <p className="text-sm mt-1 opacity-80">{banner.message}</p>
                    {banner.linkUrl && (
                      <p className="text-xs mt-1 opacity-60">Link: {banner.linkText || banner.linkUrl}</p>
                    )}
                    <div className="flex items-center gap-2 mt-2">
                      <span className={`px-2 py-0.5 text-xs rounded-full ${statusColors[banner.status] || statusColors.draft}`}>{banner.status}</span>
                      {banner.startsAt && <span className="text-xs opacity-60">From: {new Date(banner.startsAt).toLocaleDateString()}</span>}
                      {banner.endsAt && <span className="text-xs opacity-60">Until: {new Date(banner.endsAt).toLocaleDateString()}</span>}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={() => openEdit(banner)} className="p-1.5 hover:bg-white/50 rounded"><Pencil className="w-4 h-4" /></button>
                  <button onClick={() => handleDelete(banner.id)} className="p-1.5 hover:bg-white/50 rounded"><Trash2 className="w-4 h-4" /></button>
                </div>
              </div>
            </div>
          );
        })}
        {bannersList.length === 0 && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 px-4 py-12 text-center text-gray-400">No banners yet. Create your first banner.</div>
        )}
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">{editing ? "Edit Banner" : "New Banner"}</h2>
              <button onClick={() => setShowModal(false)} className="p-1 hover:bg-gray-100 rounded"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
                <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className="w-full border border-gray-300 rounded-lg px-3 py-2" required />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Message</label>
                <textarea value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} className="w-full border border-gray-300 rounded-lg px-3 py-2" rows={3} required />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
                  <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className="w-full border border-gray-300 rounded-lg px-3 py-2">
                    <option value="info">Info</option>
                    <option value="warning">Warning</option>
                    <option value="success">Success</option>
                    <option value="error">Error</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
                  <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} className="w-full border border-gray-300 rounded-lg px-3 py-2">
                    <option value="draft">Draft</option>
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Link URL</label>
                  <input value={form.linkUrl} onChange={(e) => setForm({ ...form, linkUrl: e.target.value })} className="w-full border border-gray-300 rounded-lg px-3 py-2" placeholder="https://..." />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Link Text</label>
                  <input value={form.linkText} onChange={(e) => setForm({ ...form, linkText: e.target.value })} className="w-full border border-gray-300 rounded-lg px-3 py-2" placeholder="Learn more" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Starts At</label>
                  <input type="date" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} className="w-full border border-gray-300 rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Ends At</label>
                  <input type="date" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} className="w-full border border-gray-300 rounded-lg px-3 py-2" />
                </div>
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button onClick={() => setShowModal(false)} className="px-4 py-2 text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
                <button onClick={handleSave} disabled={saving || !form.title || !form.message} className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
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
