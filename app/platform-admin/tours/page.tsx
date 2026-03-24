"use client";

import { useState, useEffect } from "react";
import { Plus, Pencil, Trash2, Loader2, X, Navigation, ChevronDown, ChevronRight } from "lucide-react";

interface TourStep {
  title: string;
  content: string;
  target?: string;
  placement?: string;
}

interface Tour {
  id: string;
  name: string;
  description: string | null;
  targetPage: string | null;
  status: string;
  steps: TourStep[];
  sortOrder: number;
}

export default function ToursPage() {
  const [toursList, setToursList] = useState<Tour[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Tour | null>(null);
  const [saving, setSaving] = useState(false);
  const [expandedTour, setExpandedTour] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "", description: "", targetPage: "", status: "draft", steps: [] as TourStep[], sortOrder: 0,
  });

  const loadTours = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/platform-admin/tours");
      const data = await res.json();
      if (data.ok) setToursList(data.tours);
    } catch (error) {
      console.error("Error loading tours:", error);
    }
    setLoading(false);
  };

  useEffect(() => { loadTours(); }, []);

  const openCreate = () => {
    setEditing(null);
    setForm({ name: "", description: "", targetPage: "", status: "draft", steps: [], sortOrder: toursList.length });
    setShowModal(true);
  };

  const openEdit = (tour: Tour) => {
    setEditing(tour);
    setForm({
      name: tour.name, description: tour.description || "", targetPage: tour.targetPage || "",
      status: tour.status, steps: tour.steps || [], sortOrder: tour.sortOrder,
    });
    setShowModal(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const url = editing ? `/api/platform-admin/tours/${editing.id}` : "/api/platform-admin/tours";
      const method = editing ? "PATCH" : "POST";
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      if ((await res.json()).ok) {
        setShowModal(false);
        loadTours();
      }
    } catch (error) {
      console.error("Error saving tour:", error);
    }
    setSaving(false);
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Archive this tour?")) return;
    try {
      await fetch(`/api/platform-admin/tours/${id}`, { method: "DELETE" });
      loadTours();
    } catch (error) {
      console.error("Error deleting tour:", error);
    }
  };

  const addStep = () => {
    setForm({ ...form, steps: [...form.steps, { title: "", content: "", target: "", placement: "bottom" }] });
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
          <h1 className="text-2xl font-bold text-gray-900">Tours</h1>
          <p className="text-gray-500 mt-1">Create guided product tours for users</p>
        </div>
        <button onClick={openCreate} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">
          <Plus className="w-4 h-4" /> New Tour
        </button>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        {toursList.map(tour => (
          <div key={tour.id} className="border-b last:border-b-0">
            <div className="flex items-center justify-between px-4 py-3 hover:bg-gray-50 cursor-pointer" onClick={() => setExpandedTour(expandedTour === tour.id ? null : tour.id)}>
              <div className="flex items-center gap-3">
                <Navigation className="w-5 h-5 text-blue-500" />
                <div>
                  <h3 className="font-medium text-gray-900">{tour.name}</h3>
                  {tour.description && <p className="text-sm text-gray-500">{tour.description}</p>}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className={`px-2 py-0.5 text-xs rounded-full ${statusColors[tour.status] || statusColors.draft}`}>{tour.status}</span>
                <span className="text-xs text-gray-400">{(tour.steps || []).length} steps</span>
                <button onClick={(e) => { e.stopPropagation(); openEdit(tour); }} className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded"><Pencil className="w-4 h-4" /></button>
                <button onClick={(e) => { e.stopPropagation(); handleDelete(tour.id); }} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded"><Trash2 className="w-4 h-4" /></button>
                {expandedTour === tour.id ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}
              </div>
            </div>
            {expandedTour === tour.id && (tour.steps || []).length > 0 && (
              <div className="bg-gray-50 px-4 py-3 border-t">
                <ol className="space-y-2">
                  {(tour.steps || []).map((step, i) => (
                    <li key={i} className="flex items-start gap-3 bg-white px-3 py-2 rounded border border-gray-200">
                      <span className="flex-shrink-0 w-6 h-6 flex items-center justify-center bg-blue-100 text-blue-700 text-xs font-bold rounded-full">{i + 1}</span>
                      <div>
                        <p className="text-sm font-medium">{step.title}</p>
                        <p className="text-xs text-gray-500">{step.content}</p>
                        {step.target && <p className="text-xs text-gray-400 mt-1">Target: {step.target}</p>}
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        ))}
        {toursList.length === 0 && (
          <div className="px-4 py-12 text-center text-gray-400">No tours yet. Create your first product tour.</div>
        )}
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">{editing ? "Edit Tour" : "New Tour"}</h2>
              <button onClick={() => setShowModal(false)} className="p-1 hover:bg-gray-100 rounded"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                  <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full border border-gray-300 rounded-lg px-3 py-2" required />
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
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="w-full border border-gray-300 rounded-lg px-3 py-2" rows={2} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Target Page (URL path)</label>
                <input value={form.targetPage} onChange={(e) => setForm({ ...form, targetPage: e.target.value })} className="w-full border border-gray-300 rounded-lg px-3 py-2" placeholder="/dashboard" />
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-sm font-medium text-gray-700">Tour Steps</label>
                  <button onClick={addStep} className="text-sm text-blue-600 hover:text-blue-700 font-medium">+ Add Step</button>
                </div>
                <div className="space-y-3">
                  {form.steps.map((step, i) => (
                    <div key={i} className="bg-gray-50 rounded-lg p-3 border border-gray-200">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-semibold text-gray-500">Step {i + 1}</span>
                        <button onClick={() => removeStep(i)} className="text-xs text-red-500 hover:text-red-600">Remove</button>
                      </div>
                      <div className="grid grid-cols-2 gap-2 mb-2">
                        <input value={step.title} onChange={(e) => updateStep(i, "title", e.target.value)} className="border border-gray-300 rounded px-2 py-1.5 text-sm" placeholder="Step title" />
                        <input value={step.target || ""} onChange={(e) => updateStep(i, "target", e.target.value)} className="border border-gray-300 rounded px-2 py-1.5 text-sm" placeholder="CSS selector (e.g. #btn)" />
                      </div>
                      <textarea value={step.content} onChange={(e) => updateStep(i, "content", e.target.value)} className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm" rows={2} placeholder="Step content..." />
                    </div>
                  ))}
                </div>
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
