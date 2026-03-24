"use client";

import { useState, useEffect, useCallback } from "react";
import { Plus, GripVertical, Pencil, Trash2, X, ArrowLeft, Check } from "lucide-react";
import Link from "next/link";

interface Stage {
  id: string;
  name: string;
  description: string | null;
  color: string;
  sortOrder: number;
  probability: number;
  isDefault: boolean;
  isWon: boolean;
  isLost: boolean;
}

export default function FunnelStagesPage() {
  const [stages, setStages] = useState<Stage[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingStage, setEditingStage] = useState<Partial<Stage> | null>(null);
  const [isNew, setIsNew] = useState(false);

  const loadStages = useCallback(async () => {
    try {
      const res = await fetch("/api/platform-admin/sales-pipeline/stages");
      const data = await res.json();
      if (data.ok) setStages(data.stages);
    } catch (e) {
      console.error("Error loading stages:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadStages(); }, [loadStages]);

  const saveStage = async () => {
    if (!editingStage?.name) return;
    try {
      if (isNew) {
        const res = await fetch("/api/platform-admin/sales-pipeline/stages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...editingStage, sortOrder: stages.length }),
        });
        const data = await res.json();
        if (data.ok) setStages([...stages, data.stage]);
      } else {
        const res = await fetch("/api/platform-admin/sales-pipeline/stages", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(editingStage),
        });
        const data = await res.json();
        if (data.ok) setStages(stages.map(s => s.id === data.stage.id ? data.stage : s));
      }
      setEditingStage(null);
      setIsNew(false);
    } catch (e) {
      console.error("Error saving stage:", e);
    }
  };

  const deleteStage = async (id: string) => {
    if (!confirm("Archive this stage? Deals in this stage won't be deleted.")) return;
    try {
      await fetch(`/api/platform-admin/sales-pipeline/stages?id=${id}`, { method: "DELETE" });
      setStages(stages.filter(s => s.id !== id));
    } catch (e) {
      console.error("Error deleting stage:", e);
    }
  };

  const openNew = () => {
    setEditingStage({ name: "", description: "", color: "#3c81c3", probability: 0, isDefault: false, isWon: false, isLost: false });
    setIsNew(true);
  };

  const openEdit = (stage: Stage) => {
    setEditingStage({ ...stage });
    setIsNew(false);
  };

  return (
    <>
    <div className="flex-1 overflow-y-auto">
        <header className="bg-white border-b px-4 md:px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Link href="/platform-admin/sales-pipeline" className="p-2 hover:bg-gray-100 rounded-lg"><ArrowLeft className="w-5 h-5" /></Link>
              <div>
                <h1 className="text-xl md:text-2xl font-bold text-gray-900">Funnel Stages</h1>
                <p className="text-sm text-gray-500">Configure your sales pipeline stages</p>
              </div>
            </div>
            <button onClick={openNew} className="flex items-center gap-2 px-4 py-2 bg-[#3c81c3] text-white rounded-lg hover:bg-[#2d6da8] transition-colors text-sm">
              <Plus className="w-4 h-4" /> Add Stage
            </button>
          </div>
        </header>

        <div className="p-4 md:p-6 max-w-3xl mx-auto">
          {loading ? (
            <div className="flex items-center justify-center h-64"><div className="animate-spin w-8 h-8 border-4 border-[#3c81c3] border-t-transparent rounded-full" /></div>
          ) : (
            <div className="space-y-2">
              {stages.map((stage) => (
                <div key={stage.id} className="bg-white rounded-xl border p-4 flex items-center gap-4">
                  <GripVertical className="w-5 h-5 text-gray-300 cursor-grab" />
                  <div className="w-4 h-4 rounded-full flex-shrink-0" style={{ backgroundColor: stage.color }} />
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="font-medium text-gray-900">{stage.name}</h3>
                      {stage.isDefault && <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">Default</span>}
                      {stage.isWon && <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">Won</span>}
                      {stage.isLost && <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full">Lost</span>}
                    </div>
                    <p className="text-sm text-gray-500">{stage.probability}% probability {stage.description ? `- ${stage.description}` : ""}</p>
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={() => openEdit(stage)} className="p-2 hover:bg-gray-100 rounded-lg"><Pencil className="w-4 h-4 text-gray-500" /></button>
                    <button onClick={() => deleteStage(stage.id)} className="p-2 hover:bg-red-50 rounded-lg"><Trash2 className="w-4 h-4 text-red-500" /></button>
                  </div>
                </div>
              ))}
              {stages.length === 0 && (
                <div className="text-center py-12 text-gray-500">
                  <p className="text-lg font-medium">No stages yet</p>
                  <p className="text-sm mt-1">Add stages to build your sales funnel.</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {editingStage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold">{isNew ? "New Stage" : "Edit Stage"}</h2>
              <button onClick={() => { setEditingStage(null); setIsNew(false); }} className="p-1 hover:bg-gray-100 rounded"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Name *</label>
                <input type="text" value={editingStage.name || ""} onChange={e => setEditingStage({ ...editingStage, name: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <input type="text" value={editingStage.description || ""} onChange={e => setEditingStage({ ...editingStage, description: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Color</label>
                  <input type="color" value={editingStage.color || "#3c81c3"} onChange={e => setEditingStage({ ...editingStage, color: e.target.value })}
                    className="w-full h-10 border rounded-lg cursor-pointer" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Probability (%)</label>
                  <input type="number" value={editingStage.probability || 0} onChange={e => setEditingStage({ ...editingStage, probability: parseInt(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" min="0" max="100" />
                </div>
              </div>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={editingStage.isDefault || false} onChange={e => setEditingStage({ ...editingStage, isDefault: e.target.checked })} className="rounded" /> Default
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={editingStage.isWon || false} onChange={e => setEditingStage({ ...editingStage, isWon: e.target.checked, isLost: false })} className="rounded" /> Won Stage
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={editingStage.isLost || false} onChange={e => setEditingStage({ ...editingStage, isLost: e.target.checked, isWon: false })} className="rounded" /> Lost Stage
                </label>
              </div>
              <div className="flex gap-2 pt-2">
                <button onClick={() => { setEditingStage(null); setIsNew(false); }} className="flex-1 px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">Cancel</button>
                <button onClick={saveStage} disabled={!editingStage.name}
                  className="flex-1 px-4 py-2 bg-[#3c81c3] text-white rounded-lg text-sm hover:bg-[#2d6da8] disabled:opacity-50">Save</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
