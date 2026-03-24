"use client";

import { useState, useEffect, use } from "react";
import { ArrowLeft, Save, DollarSign, Calendar, User, Mail, Phone, Plus, Clock } from "lucide-react";
import Link from "next/link";

interface Deal {
  id: string;
  title: string;
  stageId: string;
  value: string;
  probability: number;
  expectedCloseDate: string | null;
  actualCloseDate: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  source: string | null;
  notes: string | null;
  assignedTo: string | null;
  priority: string;
  tags: string[];
  activities: Array<{ date: string; type: string; note: string; user?: string }>;
  createdAt: string;
  updatedAt: string;
}

interface Stage {
  id: string;
  name: string;
  color: string;
}

export default function DealDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [deal, setDeal] = useState<Deal | null>(null);
  const [stages, setStages] = useState<Stage[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newActivity, setNewActivity] = useState({ type: "note", note: "" });

  useEffect(() => {
    const load = async () => {
      try {
        const [dealRes, stagesRes] = await Promise.all([
          fetch(`/api/platform-admin/sales-pipeline/deals/${id}`),
          fetch("/api/platform-admin/sales-pipeline/stages"),
        ]);
        const dealData = await dealRes.json();
        const stagesData = await stagesRes.json();
        if (dealData.ok) setDeal(dealData.deal);
        if (stagesData.ok) setStages(stagesData.stages);
      } catch (e) {
        console.error("Error loading deal:", e);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [id]);

  const saveDeal = async () => {
    if (!deal) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/platform-admin/sales-pipeline/deals/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(deal),
      });
      const data = await res.json();
      if (data.ok) setDeal(data.deal);
    } catch (e) {
      console.error("Error saving deal:", e);
    } finally {
      setSaving(false);
    }
  };

  const addActivity = async () => {
    if (!deal || !newActivity.note) return;
    const activity = { ...newActivity, date: new Date().toISOString() };
    const updatedActivities = [...(deal.activities || []), activity];
    setDeal({ ...deal, activities: updatedActivities });
    setNewActivity({ type: "note", note: "" });
    try {
      await fetch(`/api/platform-admin/sales-pipeline/deals/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activities: updatedActivities }),
      });
    } catch (e) {
      console.error("Error adding activity:", e);
    }
  };

  const updateField = (field: string, value: any) => {
    if (deal) setDeal({ ...deal, [field]: value });
  };

  const currentStage = stages.find(s => s.id === deal?.stageId);

  return (
    <div className="flex-1 overflow-y-auto">
        <header className="bg-white border-b px-4 md:px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Link href="/platform-admin/sales-pipeline" className="p-2 hover:bg-gray-100 rounded-lg"><ArrowLeft className="w-5 h-5" /></Link>
              <div>
                <h1 className="text-xl font-bold text-gray-900">{deal?.title || "Deal Detail"}</h1>
                {currentStage && (
                  <div className="flex items-center gap-2 mt-1">
                    <div className="w-2 h-2 rounded-full" style={{ backgroundColor: currentStage.color }} />
                    <span className="text-sm text-gray-500">{currentStage.name}</span>
                  </div>
                )}
              </div>
            </div>
            <button onClick={saveDeal} disabled={saving}
              className="flex items-center gap-2 px-4 py-2 bg-[#3c81c3] text-white rounded-lg hover:bg-[#2d6da8] text-sm disabled:opacity-50">
              <Save className="w-4 h-4" /> {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </header>

        {loading ? (
          <div className="flex items-center justify-center h-64"><div className="animate-spin w-8 h-8 border-4 border-[#3c81c3] border-t-transparent rounded-full" /></div>
        ) : !deal ? (
          <div className="flex flex-col items-center justify-center h-64 text-gray-500">Deal not found</div>
        ) : (
          <div className="p-4 md:p-6 max-w-5xl mx-auto space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="bg-white rounded-xl border p-6 space-y-4">
                <h2 className="font-semibold text-gray-900">Deal Information</h2>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
                  <input type="text" value={deal.title} onChange={e => updateField("title", e.target.value)}
                    className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Stage</label>
                  <select value={deal.stageId} onChange={e => updateField("stageId", e.target.value)}
                    className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30">
                    {stages.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Value ($)</label>
                    <input type="number" value={deal.value} onChange={e => updateField("value", e.target.value)}
                      className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Probability (%)</label>
                    <input type="number" value={deal.probability} onChange={e => updateField("probability", parseInt(e.target.value) || 0)}
                      className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" min="0" max="100" />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Expected Close</label>
                    <input type="date" value={deal.expectedCloseDate ? deal.expectedCloseDate.split("T")[0] : ""}
                      onChange={e => updateField("expectedCloseDate", e.target.value || null)}
                      className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Priority</label>
                    <select value={deal.priority} onChange={e => updateField("priority", e.target.value)}
                      className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30">
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Source</label>
                  <input type="text" value={deal.source || ""} onChange={e => updateField("source", e.target.value)}
                    className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" placeholder="e.g. Website, Referral, Cold call" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Assigned To</label>
                  <input type="text" value={deal.assignedTo || ""} onChange={e => updateField("assignedTo", e.target.value)}
                    className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
                </div>
              </div>

              <div className="space-y-6">
                <div className="bg-white rounded-xl border p-6 space-y-4">
                  <h2 className="font-semibold text-gray-900">Contact</h2>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                    <input type="text" value={deal.contactName || ""} onChange={e => updateField("contactName", e.target.value)}
                      className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                    <input type="email" value={deal.contactEmail || ""} onChange={e => updateField("contactEmail", e.target.value)}
                      className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
                    <input type="tel" value={deal.contactPhone || ""} onChange={e => updateField("contactPhone", e.target.value)}
                      className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
                  </div>
                </div>

                <div className="bg-white rounded-xl border p-6">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                  <textarea value={deal.notes || ""} onChange={e => updateField("notes", e.target.value)} rows={4}
                    className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
                </div>
              </div>
            </div>

            <div className="bg-white rounded-xl border p-6">
              <h2 className="font-semibold text-gray-900 mb-4">Activity Timeline</h2>
              <div className="flex gap-2 mb-4">
                <select value={newActivity.type} onChange={e => setNewActivity({ ...newActivity, type: e.target.value })}
                  className="px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30">
                  <option value="note">Note</option>
                  <option value="call">Call</option>
                  <option value="email">Email</option>
                  <option value="meeting">Meeting</option>
                  <option value="task">Task</option>
                </select>
                <input type="text" value={newActivity.note} onChange={e => setNewActivity({ ...newActivity, note: e.target.value })}
                  placeholder="Add activity..."
                  className="flex-1 px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
                <button onClick={addActivity} disabled={!newActivity.note}
                  className="px-4 py-2 bg-[#3c81c3] text-white rounded-lg text-sm hover:bg-[#2d6da8] disabled:opacity-50">
                  <Plus className="w-4 h-4" />
                </button>
              </div>
              <div className="space-y-3">
                {(deal.activities || []).slice().reverse().map((act, i) => (
                  <div key={i} className="flex gap-3 p-3 bg-gray-50 rounded-lg">
                    <div className="w-8 h-8 rounded-full bg-[#3c81c3]/10 flex items-center justify-center flex-shrink-0">
                      <Clock className="w-4 h-4 text-[#3c81c3]" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium px-2 py-0.5 bg-gray-200 rounded-full capitalize">{act.type}</span>
                        <span className="text-xs text-gray-500">{new Date(act.date).toLocaleString()}</span>
                      </div>
                      <p className="text-sm text-gray-700 mt-1">{act.note}</p>
                    </div>
                  </div>
                ))}
                {(!deal.activities || deal.activities.length === 0) && (
                  <p className="text-sm text-gray-400 text-center py-4">No activities yet</p>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
  );
}
