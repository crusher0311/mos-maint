"use client";

import { useState, useEffect, useCallback } from "react";
import { Plus, Search, X, Star, Calendar, Tag } from "lucide-react";

interface Special {
  id: string;
  name: string;
  description: string | null;
  type: string;
  discountType: string | null;
  discountValue: string | null;
  imageUrl: string | null;
  startDate: string | null;
  endDate: string | null;
  isActive: boolean;
  targetAudience: string | null;
  terms: string | null;
  createdAt: string;
}

export default function SpecialsPage() {
  const [specials, setSpecials] = useState<Special[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [editing, setEditing] = useState<Partial<Special> | null>(null);
  const [isNew, setIsNew] = useState(false);

  const loadSpecials = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (searchTerm) params.set("search", searchTerm);
      const res = await fetch(`/api/platform-admin/specials?${params}`);
      const data = await res.json();
      if (data.ok) setSpecials(data.specials);
    } catch (e) {
      console.error("Error loading specials:", e);
    } finally {
      setLoading(false);
    }
  }, [searchTerm]);

  useEffect(() => { loadSpecials(); }, [loadSpecials]);

  const saveSpecial = async () => {
    if (!editing?.name) return;
    try {
      const method = isNew ? "POST" : "PUT";
      const res = await fetch("/api/platform-admin/specials", {
        method, headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editing),
      });
      const data = await res.json();
      if (data.ok) {
        if (isNew) setSpecials([data.special, ...specials]);
        else setSpecials(specials.map(s => s.id === data.special.id ? data.special : s));
        setEditing(null); setIsNew(false);
      }
    } catch (e) {
      console.error("Error saving special:", e);
    }
  };

  const deleteSpecial = async (id: string) => {
    if (!confirm("Archive this special/promotion?")) return;
    try {
      await fetch(`/api/platform-admin/specials?id=${id}`, { method: "DELETE" });
      setSpecials(specials.filter(s => s.id !== id));
    } catch (e) {
      console.error("Error deleting special:", e);
    }
  };

  const typeColors: Record<string, string> = {
    promotion: "bg-purple-100 text-purple-700",
    seasonal: "bg-orange-100 text-orange-700",
    clearance: "bg-red-100 text-red-700",
    bundle: "bg-blue-100 text-blue-700",
    loyalty: "bg-green-100 text-green-700",
  };

  return (
    <>
    <div className="flex-1 overflow-y-auto">
        <header className="bg-white border-b px-4 md:px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div>
                <h1 className="text-xl md:text-2xl font-bold text-gray-900">Specials & Promotions</h1>
                <p className="text-sm text-gray-500">{specials.length} specials</p>
              </div>
            </div>
            <button onClick={() => { setEditing({ name: "", type: "promotion", isActive: true }); setIsNew(true); }}
              className="flex items-center gap-2 px-4 py-2 bg-[#3c81c3] text-white rounded-lg hover:bg-[#2d6da8] text-sm">
              <Plus className="w-4 h-4" /> New Special
            </button>
          </div>
          <div className="mt-3 relative max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input type="text" placeholder="Search specials..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-4 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
          </div>
        </header>

        <div className="p-4 md:p-6">
          {loading ? (
            <div className="flex items-center justify-center h-64"><div className="animate-spin w-8 h-8 border-4 border-[#3c81c3] border-t-transparent rounded-full" /></div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {specials.map(special => (
                <div key={special.id} className="bg-white rounded-xl border p-4 hover:shadow-sm transition-shadow">
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <Star className="w-5 h-5 text-yellow-500" />
                      <h3 className="font-medium text-gray-900">{special.name}</h3>
                    </div>
                    <div className="flex items-center gap-1">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${typeColors[special.type] || "bg-gray-100 text-gray-700"}`}>{special.type}</span>
                      {special.isActive ? (
                        <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">Active</span>
                      ) : (
                        <span className="text-xs bg-gray-100 text-gray-700 px-2 py-0.5 rounded-full">Inactive</span>
                      )}
                    </div>
                  </div>
                  {special.description && <p className="text-sm text-gray-500 mb-2">{special.description}</p>}
                  {special.discountValue && (
                    <p className="text-lg font-bold text-[#3c81c3]">
                      {special.discountType === "percentage" ? `${special.discountValue}% off` : `$${special.discountValue} off`}
                    </p>
                  )}
                  {(special.startDate || special.endDate) && (
                    <div className="flex items-center gap-1 mt-2 text-xs text-gray-500">
                      <Calendar className="w-3 h-3" />
                      {special.startDate && new Date(special.startDate).toLocaleDateString()}
                      {special.startDate && special.endDate && " - "}
                      {special.endDate && new Date(special.endDate).toLocaleDateString()}
                    </div>
                  )}
                  <div className="mt-3 flex gap-2">
                    <button onClick={() => { setEditing(special); setIsNew(false); }} className="text-xs text-[#3c81c3] hover:underline">Edit</button>
                    <button onClick={() => deleteSpecial(special.id)} className="text-xs text-red-500 hover:underline">Archive</button>
                  </div>
                </div>
              ))}
              {specials.length === 0 && (
                <div className="col-span-full text-center py-12 text-gray-500">
                  <p className="text-lg font-medium">No specials yet</p>
                  <p className="text-sm mt-1">Create promotions to attract customers.</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold">{isNew ? "New Special" : "Edit Special"}</h2>
              <button onClick={() => { setEditing(null); setIsNew(false); }} className="p-1 hover:bg-gray-100 rounded"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Name *</label>
                <input type="text" value={editing.name || ""} onChange={e => setEditing({ ...editing, name: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <textarea value={editing.description || ""} onChange={e => setEditing({ ...editing, description: e.target.value })} rows={2}
                  className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
                <select value={editing.type || "promotion"} onChange={e => setEditing({ ...editing, type: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30">
                  <option value="promotion">Promotion</option>
                  <option value="seasonal">Seasonal</option>
                  <option value="clearance">Clearance</option>
                  <option value="bundle">Bundle</option>
                  <option value="loyalty">Loyalty</option>
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Discount Type</label>
                  <select value={editing.discountType || "percentage"} onChange={e => setEditing({ ...editing, discountType: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30">
                    <option value="percentage">Percentage</option>
                    <option value="fixed">Fixed Amount</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Discount Value</label>
                  <input type="number" value={editing.discountValue || ""} onChange={e => setEditing({ ...editing, discountValue: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Start Date</label>
                  <input type="date" value={editing.startDate ? editing.startDate.split("T")[0] : ""} onChange={e => setEditing({ ...editing, startDate: e.target.value || null })}
                    className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">End Date</label>
                  <input type="date" value={editing.endDate ? editing.endDate.split("T")[0] : ""} onChange={e => setEditing({ ...editing, endDate: e.target.value || null })}
                    className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Target Audience</label>
                <input type="text" value={editing.targetAudience || ""} onChange={e => setEditing({ ...editing, targetAudience: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Terms & Conditions</label>
                <textarea value={editing.terms || ""} onChange={e => setEditing({ ...editing, terms: e.target.value })} rows={2}
                  className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={editing.isActive ?? true} onChange={e => setEditing({ ...editing, isActive: e.target.checked })} className="rounded" /> Active
              </label>
              <div className="flex gap-2 pt-2">
                <button onClick={() => { setEditing(null); setIsNew(false); }} className="flex-1 px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">Cancel</button>
                <button onClick={saveSpecial} disabled={!editing.name}
                  className="flex-1 px-4 py-2 bg-[#3c81c3] text-white rounded-lg text-sm hover:bg-[#2d6da8] disabled:opacity-50">Save</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
