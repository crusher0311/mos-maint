"use client";

import { useState, useEffect, useCallback } from "react";
import { PlatformAdminSidebar } from "@/components/ui/PlatformAdminSidebar";
import { Menu, Plus, Search, X, Tag, Percent, DollarSign, Calendar } from "lucide-react";

interface PromoCode {
  id: string;
  code: string;
  name: string;
  description: string | null;
  discountType: string;
  discountValue: string;
  maxRedemptions: number | null;
  redemptionCount: number;
  validFrom: string | null;
  validUntil: string | null;
  isActive: boolean;
  createdAt: string;
}

export default function PromoCodesPage() {
  const [promoCodes, setPromoCodes] = useState<PromoCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [showMobileMenu, setShowMobileMenu] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [editing, setEditing] = useState<Partial<PromoCode> | null>(null);
  const [isNew, setIsNew] = useState(false);

  const loadPromoCodes = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (searchTerm) params.set("search", searchTerm);
      const res = await fetch(`/api/platform-admin/promo-codes?${params}`);
      const data = await res.json();
      if (data.ok) setPromoCodes(data.promoCodes);
    } catch (e) {
      console.error("Error loading promo codes:", e);
    } finally {
      setLoading(false);
    }
  }, [searchTerm]);

  useEffect(() => { loadPromoCodes(); }, [loadPromoCodes]);

  const savePromoCode = async () => {
    if (!editing?.code || !editing?.name || !editing?.discountValue) return;
    try {
      const method = isNew ? "POST" : "PUT";
      const res = await fetch("/api/platform-admin/promo-codes", {
        method, headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editing),
      });
      const data = await res.json();
      if (data.ok) {
        if (isNew) setPromoCodes([data.promoCode, ...promoCodes]);
        else setPromoCodes(promoCodes.map(p => p.id === data.promoCode.id ? data.promoCode : p));
        setEditing(null); setIsNew(false);
      } else {
        alert(data.error);
      }
    } catch (e) {
      console.error("Error saving promo code:", e);
    }
  };

  const deletePromoCode = async (id: string) => {
    if (!confirm("Archive this promo code?")) return;
    try {
      await fetch(`/api/platform-admin/promo-codes?id=${id}`, { method: "DELETE" });
      setPromoCodes(promoCodes.filter(p => p.id !== id));
    } catch (e) {
      console.error("Error deleting promo code:", e);
    }
  };

  return (
    <div className="flex h-screen bg-gray-50">
      <div className="hidden md:block"><PlatformAdminSidebar /></div>
      {showMobileMenu && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowMobileMenu(false)} />
          <div className="relative w-72 h-full"><PlatformAdminSidebar isMobile onClose={() => setShowMobileMenu(false)} /></div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        <header className="bg-white border-b px-4 md:px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <button onClick={() => setShowMobileMenu(true)} className="md:hidden p-2 hover:bg-gray-100 rounded-lg"><Menu className="w-5 h-5" /></button>
              <div>
                <h1 className="text-xl md:text-2xl font-bold text-gray-900">Promo Codes</h1>
                <p className="text-sm text-gray-500">{promoCodes.length} promo codes</p>
              </div>
            </div>
            <button onClick={() => { setEditing({ code: "", name: "", discountType: "percentage", discountValue: "", isActive: true }); setIsNew(true); }}
              className="flex items-center gap-2 px-4 py-2 bg-[#3c81c3] text-white rounded-lg hover:bg-[#2d6da8] text-sm">
              <Plus className="w-4 h-4" /> New Promo Code
            </button>
          </div>
          <div className="mt-3 relative max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input type="text" placeholder="Search promo codes..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-4 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
          </div>
        </header>

        <div className="p-4 md:p-6">
          {loading ? (
            <div className="flex items-center justify-center h-64"><div className="animate-spin w-8 h-8 border-4 border-[#3c81c3] border-t-transparent rounded-full" /></div>
          ) : (
            <div className="space-y-3">
              {promoCodes.map(promo => (
                <div key={promo.id} className="bg-white rounded-xl border p-4 hover:shadow-sm transition-shadow">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-[#3c81c3]/10 flex items-center justify-center">
                        <Tag className="w-5 h-5 text-[#3c81c3]" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="font-mono font-bold text-gray-900">{promo.code}</h3>
                          {promo.isActive ? (
                            <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">Active</span>
                          ) : (
                            <span className="text-xs bg-gray-100 text-gray-700 px-2 py-0.5 rounded-full">Inactive</span>
                          )}
                        </div>
                        <p className="text-sm text-gray-500">{promo.name}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="text-right">
                        <p className="font-bold text-[#3c81c3]">
                          {promo.discountType === "percentage" ? `${promo.discountValue}%` : `$${promo.discountValue}`} off
                        </p>
                        <p className="text-xs text-gray-500">
                          {promo.redemptionCount}{promo.maxRedemptions ? `/${promo.maxRedemptions}` : ""} redeemed
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        <button onClick={() => { setEditing(promo); setIsNew(false); }} className="px-3 py-1 text-xs border rounded-lg hover:bg-gray-50">Edit</button>
                        <button onClick={() => deletePromoCode(promo.id)} className="px-3 py-1 text-xs text-red-500 border border-red-200 rounded-lg hover:bg-red-50">Archive</button>
                      </div>
                    </div>
                  </div>
                  {(promo.validFrom || promo.validUntil) && (
                    <div className="mt-2 flex items-center gap-1 text-xs text-gray-500">
                      <Calendar className="w-3 h-3" />
                      {promo.validFrom && `From ${new Date(promo.validFrom).toLocaleDateString()}`}
                      {promo.validFrom && promo.validUntil && " - "}
                      {promo.validUntil && `Until ${new Date(promo.validUntil).toLocaleDateString()}`}
                    </div>
                  )}
                </div>
              ))}
              {promoCodes.length === 0 && (
                <div className="text-center py-12 text-gray-500">
                  <p className="text-lg font-medium">No promo codes yet</p>
                  <p className="text-sm mt-1">Create promo codes for special discounts.</p>
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
              <h2 className="text-lg font-bold">{isNew ? "New Promo Code" : "Edit Promo Code"}</h2>
              <button onClick={() => { setEditing(null); setIsNew(false); }} className="p-1 hover:bg-gray-100 rounded"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Code *</label>
                <input type="text" value={editing.code || ""} onChange={e => setEditing({ ...editing, code: e.target.value.toUpperCase() })}
                  className="w-full px-3 py-2 border rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Name *</label>
                <input type="text" value={editing.name || ""} onChange={e => setEditing({ ...editing, name: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <input type="text" value={editing.description || ""} onChange={e => setEditing({ ...editing, description: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
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
                  <label className="block text-sm font-medium text-gray-700 mb-1">Discount Value *</label>
                  <input type="number" value={editing.discountValue || ""} onChange={e => setEditing({ ...editing, discountValue: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Max Redemptions (leave empty for unlimited)</label>
                <input type="number" value={editing.maxRedemptions || ""} onChange={e => setEditing({ ...editing, maxRedemptions: parseInt(e.target.value) || null })}
                  className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Valid From</label>
                  <input type="date" value={editing.validFrom ? editing.validFrom.split("T")[0] : ""} onChange={e => setEditing({ ...editing, validFrom: e.target.value || null })}
                    className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Valid Until</label>
                  <input type="date" value={editing.validUntil ? editing.validUntil.split("T")[0] : ""} onChange={e => setEditing({ ...editing, validUntil: e.target.value || null })}
                    className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={editing.isActive ?? true} onChange={e => setEditing({ ...editing, isActive: e.target.checked })} className="rounded" /> Active
              </label>
              <div className="flex gap-2 pt-2">
                <button onClick={() => { setEditing(null); setIsNew(false); }} className="flex-1 px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">Cancel</button>
                <button onClick={savePromoCode} disabled={!editing.code || !editing.name || !editing.discountValue}
                  className="flex-1 px-4 py-2 bg-[#3c81c3] text-white rounded-lg text-sm hover:bg-[#2d6da8] disabled:opacity-50">Save</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
