"use client";

import { useState, useEffect } from "react";
import { Plus, Pencil, Trash2, Loader2, X, BookOpen, ChevronDown, ChevronRight } from "lucide-react";

interface GuideStep {
  title: string;
  content: string;
  imageUrl?: string;
}

interface Guide {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
  status: string;
  steps: GuideStep[];
  sortOrder: number;
}

export default function GuidesPage() {
  const [guides, setGuides] = useState<Guide[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Guide | null>(null);
  const [saving, setSaving] = useState(false);
  const [expandedGuide, setExpandedGuide] = useState<string | null>(null);
  const [form, setForm] = useState({
    title: "", description: "", category: "", status: "draft", steps: [] as GuideStep[], sortOrder: 0,
  });

  const loadGuides = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/platform-admin/guides");
      const data = await res.json();
      if (data.ok) setGuides(data.guides);
    } catch (error) {
      console.error("Error loading guides:", error);
    }
    setLoading(false);
  };

  useEffect(() => { loadGuides(); }, []);

  const openCreate = () => {
    setEditing(null);
    setForm({ title: "", description: "", category: "", status: "draft", steps: [], sortOrder: guides.length });
    setShowModal(true);
  };

  const openEdit = (guide: Guide) => {
    setEditing(guide);
    setForm({
      title: guide.title, description: guide.description || "", category: guide.category || "",
      status: guide.status, steps: guide.steps || [], sortOrder: guide.sortOrder,
    });
    setShowModal(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const url = editing ? `/api/platform-admin/guides/${editing.id}` : "/api/platform-admin/guides";
      const method = editing ? "PATCH" : "POST";
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      if ((await res.json()).ok) {
        setShowModal(false);
        loadGuides();
      }
    } catch (error) {
      console.error("Error saving guide:", error);
    }
    setSaving(false);
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Archive this guide?")) return;
    try {
      await fetch(`/api/platform-admin/guides/${id}`, { method: "DELETE" });
      loadGuides();
    } catch (error) {
      console.error("Error deleting guide:", error);
    }
  };

  const addStep = () => {
    setForm({ ...form, steps: [...form.steps, { title: "", content: "", imageUrl: "" }] });
  };

  const updateStep = (index: number, field: string, value: string) => {
    const newSteps = [...form.steps];
    (newSteps[index] as any)[field] = value;
    setForm({ ...form, steps: newSteps });
  };

  const removeStep = (index: number) => {
    setForm({ ...form, steps: form.steps.filter((_, i) => i !== index) });
  };

  const statusColors: Record<string, string> = {
    draft: "bg-gray-100 text-gray-700",
    published: "bg-green-100 text-green-700",
    archived: "bg-red-100 text-red-700",
  };

  if (loading) {
    return <div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 animate-spin text-blue-600" /></div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Onboarding Guides</h1>
          <p className="text-gray-500 mt-1">Create step-by-step guides for user onboarding</p>
        </div>
        <button onClick={openCreate} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">
          <Plus className="w-4 h-4" /> New Guide
        </button>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        {guides.map(guide => (
          <div key={guide.id} className="border-b last:border-b-0">
            <div className="flex items-center justify-between px-4 py-3 hover:bg-gray-50 cursor-pointer" onClick={() => setExpandedGuide(expandedGuide === guide.id ? null : guide.id)}>
              <div className="flex items-center gap-3">
                <BookOpen className="w-5 h-5 text-purple-500" />
                <div>
                  <h3 className="font-medium text-gray-900">{guide.title}</h3>
                  <div className="flex items-center gap-2">
                    {guide.description && <p className="text-sm text-gray-500">{guide.description}</p>}
                    {guide.category && <span className="text-xs bg-purple-50 text-purple-600 px-2 py-0.5 rounded">{guide.category}</span>}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className={`px-2 py-0.5 text-xs rounded-full ${statusColors[guide.status] || statusColors.draft}`}>{guide.status}</span>
                <span className="text-xs text-gray-400">{(guide.steps || []).length} steps</span>
                <button onClick={(e) => { e.stopPropagation(); openEdit(guide); }} className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded"><Pencil className="w-4 h-4" /></button>
                <button onClick={(e) => { e.stopPropagation(); handleDelete(guide.id); }} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded"><Trash2 className="w-4 h-4" /></button>
                {expandedGuide === guide.id ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}
              </div>
            </div>
            {expandedGuide === guide.id && (guide.steps || []).length > 0 && (
              <div className="bg-gray-50 px-4 py-3 border-t">
                <ol className="space-y-2">
                  {(guide.steps || []).map((step, i) => (
                    <li key={i} className="flex items-start gap-3 bg-white px-3 py-2 rounded border border-gray-200">
                      <span className="flex-shrink-0 w-6 h-6 flex items-center justify-center bg-purple-100 text-purple-700 text-xs font-bold rounded-full">{i + 1}</span>
                      <div>
                        <p className="text-sm font-medium">{step.title}</p>
                        <p className="text-xs text-gray-500">{step.content}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        ))}
        {guides.length === 0 && (
          <div className="px-4 py-12 text-center text-gray-400">No guides yet. Create your first onboarding guide.</div>
        )}
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">{editing ? "Edit Guide" : "New Guide"}</h2>
              <button onClick={() => setShowModal(false)} className="p-1 hover:bg-gray-100 rounded"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
                  <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className="w-full border border-gray-300 rounded-lg px-3 py-2" required />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
                  <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} className="w-full border border-gray-300 rounded-lg px-3 py-2">
                    <option value="draft">Draft</option>
                    <option value="published">Published</option>
                    <option value="archived">Archived</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="w-full border border-gray-300 rounded-lg px-3 py-2" rows={2} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
                <input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="w-full border border-gray-300 rounded-lg px-3 py-2" placeholder="e.g. Getting Started, Advanced" />
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-sm font-medium text-gray-700">Guide Steps</label>
                  <button onClick={addStep} className="text-sm text-blue-600 hover:text-blue-700 font-medium">+ Add Step</button>
                </div>
                <div className="space-y-3">
                  {form.steps.map((step, i) => (
                    <div key={i} className="bg-gray-50 rounded-lg p-3 border border-gray-200">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-semibold text-gray-500">Step {i + 1}</span>
                        <button onClick={() => removeStep(i)} className="text-xs text-red-500 hover:text-red-600">Remove</button>
                      </div>
                      <input value={step.title} onChange={(e) => updateStep(i, "title", e.target.value)} className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm mb-2" placeholder="Step title" />
                      <textarea value={step.content} onChange={(e) => updateStep(i, "content", e.target.value)} className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm mb-2" rows={2} placeholder="Step content..." />
                      <input value={step.imageUrl || ""} onChange={(e) => updateStep(i, "imageUrl", e.target.value)} className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm" placeholder="Image URL (optional)" />
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button onClick={() => setShowModal(false)} className="px-4 py-2 text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
                <button onClick={handleSave} disabled={saving || !form.title} className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
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
