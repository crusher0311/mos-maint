"use client";

import { useState, useEffect, useCallback } from "react";
import { Plus, GripVertical, DollarSign, Calendar, User, Search, Filter, X } from "lucide-react";
import Link from "next/link";

interface Stage {
  id: string;
  name: string;
  color: string;
  sortOrder: number;
  probability: number;
  isWon: boolean;
  isLost: boolean;
}

interface Deal {
  id: string;
  title: string;
  stageId: string;
  value: string;
  probability: number;
  expectedCloseDate: string | null;
  contactName: string | null;
  contactEmail: string | null;
  priority: string;
  assignedTo: string | null;
  createdAt: string;
}

export default function SalesPipelinePage() {
  const [stages, setStages] = useState<Stage[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [showNewDeal, setShowNewDeal] = useState(false);
  const [newDeal, setNewDeal] = useState({ title: "", stageId: "", value: "", contactName: "", contactEmail: "", priority: "medium" });
  const [dragDealId, setDragDealId] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [stagesRes, dealsRes] = await Promise.all([
        fetch("/api/platform-admin/sales-pipeline/stages"),
        fetch("/api/platform-admin/sales-pipeline/deals"),
      ]);
      const stagesData = await stagesRes.json();
      const dealsData = await dealsRes.json();
      if (stagesData.ok) setStages(stagesData.stages);
      if (dealsData.ok) setDeals(dealsData.deals);
    } catch (e) {
      console.error("Error loading pipeline data:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const createDeal = async () => {
    if (!newDeal.title || !newDeal.stageId) return;
    try {
      const res = await fetch("/api/platform-admin/sales-pipeline/deals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newDeal),
      });
      const data = await res.json();
      if (data.ok) {
        setDeals([...deals, data.deal]);
        setNewDeal({ title: "", stageId: "", value: "", contactName: "", contactEmail: "", priority: "medium" });
        setShowNewDeal(false);
      }
    } catch (e) {
      console.error("Error creating deal:", e);
    }
  };

  const moveDeal = async (dealId: string, newStageId: string) => {
    setDeals(deals.map(d => d.id === dealId ? { ...d, stageId: newStageId } : d));
    try {
      await fetch("/api/platform-admin/sales-pipeline/deals", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: dealId, stageId: newStageId }),
      });
    } catch (e) {
      console.error("Error moving deal:", e);
      loadData();
    }
  };

  const filteredDeals = deals.filter(d =>
    !searchTerm || d.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
    d.contactName?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const totalValue = deals.reduce((sum, d) => sum + parseFloat(d.value || "0"), 0);

  const handleDragStart = (dealId: string) => setDragDealId(dealId);
  const handleDragOver = (e: React.DragEvent) => e.preventDefault();
  const handleDrop = (stageId: string) => {
    if (dragDealId) {
      moveDeal(dragDealId, stageId);
      setDragDealId(null);
    }
  };

  const priorityColors: Record<string, string> = {
    high: "bg-red-100 text-red-700",
    medium: "bg-yellow-100 text-yellow-700",
    low: "bg-green-100 text-green-700",
  };

  return (
    <>
    <div className="flex-1 flex flex-col overflow-hidden">
        <header className="bg-white border-b px-4 md:px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div>
                <h1 className="text-xl md:text-2xl font-bold text-gray-900">Sales Pipeline</h1>
                <p className="text-sm text-gray-500">{deals.length} deals &middot; ${totalValue.toLocaleString()} total value</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Link href="/platform-admin/sales-pipeline/stages" className="px-3 py-2 text-sm border rounded-lg hover:bg-gray-50 transition-colors">Configure Stages</Link>
              <button onClick={() => setShowNewDeal(true)} className="flex items-center gap-2 px-4 py-2 bg-[#3c81c3] text-white rounded-lg hover:bg-[#2d6da8] transition-colors text-sm">
                <Plus className="w-4 h-4" /> New Deal
              </button>
            </div>
          </div>
          <div className="mt-3 relative max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input type="text" placeholder="Search deals..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-4 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
          </div>
        </header>

        <div className="flex-1 overflow-x-auto p-4 md:p-6">
          {loading ? (
            <div className="flex items-center justify-center h-64"><div className="animate-spin w-8 h-8 border-4 border-[#3c81c3] border-t-transparent rounded-full" /></div>
          ) : stages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-gray-500">
              <p className="text-lg font-medium">No funnel stages configured</p>
              <p className="text-sm mt-1">Set up your sales pipeline stages to get started.</p>
              <Link href="/platform-admin/sales-pipeline/stages" className="mt-4 px-4 py-2 bg-[#3c81c3] text-white rounded-lg text-sm">Configure Stages</Link>
            </div>
          ) : (
            <div className="flex gap-4 h-full min-w-max">
              {stages.map(stage => {
                const stageDeals = filteredDeals.filter(d => d.stageId === stage.id);
                const stageValue = stageDeals.reduce((sum, d) => sum + parseFloat(d.value || "0"), 0);
                return (
                  <div key={stage.id} className="w-72 flex-shrink-0 flex flex-col bg-gray-100 rounded-xl"
                    onDragOver={handleDragOver} onDrop={() => handleDrop(stage.id)}>
                    <div className="px-4 py-3 border-b border-gray-200">
                      <div className="flex items-center gap-2">
                        <div className="w-3 h-3 rounded-full" style={{ backgroundColor: stage.color }} />
                        <h3 className="font-semibold text-sm text-gray-900">{stage.name}</h3>
                        <span className="ml-auto text-xs bg-gray-200 text-gray-600 px-2 py-0.5 rounded-full">{stageDeals.length}</span>
                      </div>
                      <p className="text-xs text-gray-500 mt-1">${stageValue.toLocaleString()} &middot; {stage.probability}% prob</p>
                    </div>
                    <div className="flex-1 p-2 space-y-2 overflow-y-auto max-h-[calc(100vh-260px)]">
                      {stageDeals.map(deal => (
                        <Link key={deal.id} href={`/platform-admin/sales-pipeline/deals/${deal.id}`}
                          draggable onDragStart={() => handleDragStart(deal.id)}
                          className="block bg-white rounded-lg p-3 shadow-sm border hover:shadow-md transition-shadow cursor-grab active:cursor-grabbing">
                          <div className="flex items-start justify-between">
                            <h4 className="font-medium text-sm text-gray-900 line-clamp-2">{deal.title}</h4>
                            <GripVertical className="w-4 h-4 text-gray-300 flex-shrink-0" />
                          </div>
                          {deal.value && parseFloat(deal.value) > 0 && (
                            <div className="flex items-center gap-1 mt-2 text-xs text-gray-600">
                              <DollarSign className="w-3 h-3" />
                              <span>${parseFloat(deal.value).toLocaleString()}</span>
                            </div>
                          )}
                          <div className="flex items-center gap-2 mt-2 flex-wrap">
                            {deal.contactName && (
                              <div className="flex items-center gap-1 text-xs text-gray-500">
                                <User className="w-3 h-3" />{deal.contactName}
                              </div>
                            )}
                            {deal.expectedCloseDate && (
                              <div className="flex items-center gap-1 text-xs text-gray-500">
                                <Calendar className="w-3 h-3" />{new Date(deal.expectedCloseDate).toLocaleDateString()}
                              </div>
                            )}
                          </div>
                          <div className="mt-2">
                            <span className={`text-xs px-2 py-0.5 rounded-full ${priorityColors[deal.priority] || "bg-gray-100 text-gray-600"}`}>
                              {deal.priority}
                            </span>
                          </div>
                        </Link>
                      ))}
                      {stageDeals.length === 0 && (
                        <div className="text-center py-8 text-xs text-gray-400">Drop deals here</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {showNewDeal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold">New Deal</h2>
              <button onClick={() => setShowNewDeal(false)} className="p-1 hover:bg-gray-100 rounded"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Title *</label>
                <input type="text" value={newDeal.title} onChange={e => setNewDeal({ ...newDeal, title: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Stage *</label>
                <select value={newDeal.stageId} onChange={e => setNewDeal({ ...newDeal, stageId: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30">
                  <option value="">Select stage...</option>
                  {stages.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Value ($)</label>
                <input type="number" value={newDeal.value} onChange={e => setNewDeal({ ...newDeal, value: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Contact Name</label>
                <input type="text" value={newDeal.contactName} onChange={e => setNewDeal({ ...newDeal, contactName: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Priority</label>
                <select value={newDeal.priority} onChange={e => setNewDeal({ ...newDeal, priority: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30">
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </div>
              <div className="flex gap-2 pt-2">
                <button onClick={() => setShowNewDeal(false)} className="flex-1 px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">Cancel</button>
                <button onClick={createDeal} disabled={!newDeal.title || !newDeal.stageId}
                  className="flex-1 px-4 py-2 bg-[#3c81c3] text-white rounded-lg text-sm hover:bg-[#2d6da8] disabled:opacity-50">Create Deal</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
