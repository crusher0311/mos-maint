"use client";

import { useState, useEffect } from "react";
import { Plus, Pencil, Trash2, Loader2, X, ListChecks } from "lucide-react";

interface Step {
  id: string;
  name: string;
  description: string | null;
  sortOrder: number;
}

interface Checklist {
  id: string;
  name: string;
  description: string | null;
  sortOrder: number;
}

export default function OnboardingStepsPage() {
  const [steps, setSteps] = useState<Step[]>([]);
  const [checklists, setChecklists] = useState<Checklist[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Step | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", sortOrder: 0 });
  const [expandedStep, setExpandedStep] = useState<string | null>(null);
  const [stepChecklists, setStepChecklists] = useState<any[]>([]);
  const [showChecklistModal, setShowChecklistModal] = useState(false);
  const [selectedChecklistId, setSelectedChecklistId] = useState("");

  const loadData = async () => {
    setLoading(true);
    try {
      const [stepsRes, checklistsRes] = await Promise.all([
        fetch("/api/platform-admin/onboarding/steps"),
        fetch("/api/platform-admin/onboarding/checklists"),
      ]);
      const stepsData = await stepsRes.json();
      const checklistsData = await checklistsRes.json();
      if (stepsData.ok) setSteps(stepsData.steps);
      if (checklistsData.ok) setChecklists(checklistsData.checklists);
    } catch (error) {
      console.error("Error loading data:", error);
    }
    setLoading(false);
  };

  useEffect(() => { loadData(); }, []);

  const loadStepChecklists = async (stepId: string) => {
    try {
      const res = await fetch(`/api/platform-admin/onboarding/steps/${stepId}`);
      const data = await res.json();
      if (data.ok) setStepChecklists(data.stepChecklists || []);
    } catch (error) {
      console.error("Error loading step checklists:", error);
    }
  };

  const handleExpandStep = async (stepId: string) => {
    if (expandedStep === stepId) {
      setExpandedStep(null);
      return;
    }
    setExpandedStep(stepId);
    await loadStepChecklists(stepId);
  };

  const openCreate = () => {
    setEditing(null);
    setForm({ name: "", description: "", sortOrder: steps.length });
    setShowModal(true);
  };

  const openEdit = (step: Step) => {
    setEditing(step);
    setForm({ name: step.name, description: step.description || "", sortOrder: step.sortOrder });
    setShowModal(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const url = editing ? `/api/platform-admin/onboarding/steps/${editing.id}` : "/api/platform-admin/onboarding/steps";
      const method = editing ? "PATCH" : "POST";
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      if ((await res.json()).ok) {
        setShowModal(false);
        loadData();
      }
    } catch (error) {
      console.error("Error saving step:", error);
    }
    setSaving(false);
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Archive this step?")) return;
    try {
      await fetch(`/api/platform-admin/onboarding/steps/${id}`, { method: "DELETE" });
      loadData();
    } catch (error) {
      console.error("Error deleting step:", error);
    }
  };

  const handleAddChecklist = async () => {
    if (!expandedStep || !selectedChecklistId) return;
    try {
      const res = await fetch("/api/platform-admin/onboarding/step-checklists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stepId: expandedStep, checklistId: selectedChecklistId, sortOrder: stepChecklists.length }),
      });
      if ((await res.json()).ok) {
        setShowChecklistModal(false);
        setSelectedChecklistId("");
        loadStepChecklists(expandedStep);
      }
    } catch (error) {
      console.error("Error adding checklist:", error);
    }
  };

  const handleRemoveChecklist = async (linkId: string) => {
    if (!expandedStep) return;
    try {
      await fetch("/api/platform-admin/onboarding/step-checklists", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: linkId }),
      });
      loadStepChecklists(expandedStep);
    } catch (error) {
      console.error("Error removing checklist:", error);
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 animate-spin text-blue-600" /></div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Onboarding Steps</h1>
          <p className="text-gray-500 mt-1">Define steps and attach checklists for onboarding stages</p>
        </div>
        <button onClick={openCreate} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">
          <Plus className="w-4 h-4" /> Add Step
        </button>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        {steps.map(step => (
          <div key={step.id} className="border-b last:border-b-0">
            <div className="flex items-center justify-between px-4 py-3 hover:bg-gray-50 cursor-pointer" onClick={() => handleExpandStep(step.id)}>
              <div className="flex items-center gap-3">
                <ListChecks className="w-5 h-5 text-gray-400" />
                <div>
                  <h3 className="font-medium text-gray-900">{step.name}</h3>
                  {step.description && <p className="text-sm text-gray-500">{step.description}</p>}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-400">Order: {step.sortOrder}</span>
                <button onClick={(e) => { e.stopPropagation(); openEdit(step); }} className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded"><Pencil className="w-4 h-4" /></button>
                <button onClick={(e) => { e.stopPropagation(); handleDelete(step.id); }} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded"><Trash2 className="w-4 h-4" /></button>
              </div>
            </div>
            {expandedStep === step.id && (
              <div className="bg-gray-50 px-4 py-3 border-t">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-sm font-medium text-gray-700">Checklists</h4>
                  <button onClick={() => setShowChecklistModal(true)} className="text-xs text-blue-600 hover:text-blue-700 font-medium">+ Add Checklist</button>
                </div>
                {stepChecklists.length === 0 ? (
                  <p className="text-sm text-gray-400">No checklists attached yet.</p>
                ) : (
                  <ul className="space-y-1">
                    {stepChecklists.map((sc: any) => (
                      <li key={sc.stepChecklist.id} className="flex items-center justify-between bg-white px-3 py-2 rounded border border-gray-200">
                        <span className="text-sm">{sc.checklist.name}</span>
                        <button onClick={() => handleRemoveChecklist(sc.stepChecklist.id)} className="text-xs text-red-500 hover:text-red-600">Remove</button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        ))}
        {steps.length === 0 && (
          <div className="px-4 py-12 text-center text-gray-400">No steps yet. Create your first onboarding step.</div>
        )}
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">{editing ? "Edit Step" : "New Step"}</h2>
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

      {showChecklistModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Add Checklist to Step</h2>
              <button onClick={() => setShowChecklistModal(false)} className="p-1 hover:bg-gray-100 rounded"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-4">
              <select value={selectedChecklistId} onChange={(e) => setSelectedChecklistId(e.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-2">
                <option value="">Select checklist...</option>
                {checklists.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              <div className="flex justify-end gap-3">
                <button onClick={() => setShowChecklistModal(false)} className="px-4 py-2 text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
                <button onClick={handleAddChecklist} disabled={!selectedChecklistId} className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">Add</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
