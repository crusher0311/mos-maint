"use client";

import { useState, useEffect, useCallback } from "react";
import { Plus, Search, X, Ticket, Percent, DollarSign, Calendar } from "lucide-react";

interface Coupon {
  id: string;
  code: string;
  name: string;
  description: string | null;
  discountType: string;
  discountValue: string;
  minPurchase: string | null;
  maxUses: number | null;
  usedCount: number;
  validFrom: string | null;
  validUntil: string | null;
  isActive: boolean;
  createdAt: string;
}

export default function CouponsPage() {
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [editing, setEditing] = useState<Partial<Coupon> | null>(null);
  const [isNew, setIsNew] = useState(false);

  const loadCoupons = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (searchTerm) params.set("search", searchTerm);
      const res = await fetch(`/api/platform-admin/coupons?${params}`);
      const data = await res.json();
      if (data.ok) setCoupons(data.coupons);
    } catch (e) {
      console.error("Error loading coupons:", e);
    } finally {
      setLoading(false);
    }
  }, [searchTerm]);

  useEffect(() => { loadCoupons(); }, [loadCoupons]);

  const saveCoupon = async () => {
    if (!editing?.code || !editing?.name) return;
    try {
      const method = isNew ? "POST" : "PUT";
      const res = await fetch("/api/platform-admin/coupons", {
        method, headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editing),
      });
      const data = await res.json();
      if (data.ok) {
        if (isNew) setCoupons([data.coupon, ...coupons]);
        else setCoupons(coupons.map(c => c.id === data.coupon.id ? data.coupon : c));
        setEditing(null); setIsNew(false);
      } else {
        alert(data.error);
      }
    } catch (e) {
      console.error("Error saving coupon:", e);
    }
  };

  const deleteCoupon = async (id: string) => {
    if (!confirm("Archive this coupon?")) return;
    try {
      await fetch(`/api/platform-admin/coupons?id=${id}`, { method: "DELETE" });
      setCoupons(coupons.filter(c => c.id !== id));
    } catch (e) {
      console.error("Error deleting coupon:", e);
    }
  };

  const isExpired = (coupon: Coupon) => coupon.validUntil && new Date(coupon.validUntil) < new Date();
  const isMaxedOut = (coupon: Coupon) => coupon.maxUses && coupon.usedCount >= coupon.maxUses;

  return (
    <>
    <div className="flex-1 overflow-y-auto">
        <header className="bg-white border-b px-4 md:px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div>
                <h1 className="text-xl md:text-2xl font-bold text-gray-900">Coupons</h1>
                <p className="text-sm text-gray-500">{coupons.length} coupons</p>
              </div>
            </div>
            <button onClick={() => { setEditing({ code: "", name: "", discountType: "percentage", discountValue: "10", isActive: true }); setIsNew(true); }}
              className="flex items-center gap-2 px-4 py-2 bg-[#3c81c3] text-white rounded-lg hover:bg-[#2d6da8] text-sm">
              <Plus className="w-4 h-4" /> New Coupon
            </button>
          </div>
          <div className="mt-3 relative max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input type="text" placeholder="Search coupons..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-4 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
          </div>
        </header>

        <div className="p-4 md:p-6">
          {loading ? (
            <div className="flex items-center justify-center h-64"><div className="animate-spin w-8 h-8 border-4 border-[#3c81c3] border-t-transparent rounded-full" /></div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {coupons.map(coupon => (
                <div key={coupon.id} className="bg-white rounded-xl border p-4 hover:shadow-sm transition-shadow">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-10 h-10 rounded-lg bg-[#3c81c3]/10 flex items-center justify-center">
                        <Ticket className="w-5 h-5 text-[#3c81c3]" />
                      </div>
                      <div>
                        <h3 className="font-mono font-bold text-gray-900">{coupon.code}</h3>
                        <p className="text-sm text-gray-500">{coupon.name}</p>
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      {coupon.isActive && !isExpired(coupon) && !isMaxedOut(coupon) ? (
                        <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">Active</span>
                      ) : (
                        <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full">
                          {isExpired(coupon) ? "Expired" : isMaxedOut(coupon) ? "Maxed Out" : "Inactive"}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="mt-3 flex items-center gap-3">
                    <div className="flex items-center gap-1 text-lg font-bold text-[#3c81c3]">
                      {coupon.discountType === "percentage" ? <Percent className="w-4 h-4" /> : <DollarSign className="w-4 h-4" />}
                      {coupon.discountValue}{coupon.discountType === "percentage" ? "%" : ""}
                    </div>
                    <span className="text-sm text-gray-500">off</span>
                  </div>
                  <div className="mt-2 flex items-center justify-between text-xs text-gray-500">
                    <span>Used {coupon.usedCount}{coupon.maxUses ? `/${coupon.maxUses}` : ""} times</span>
                    {coupon.validUntil && (
                      <span className="flex items-center gap-1"><Calendar className="w-3 h-3" />Expires {new Date(coupon.validUntil).toLocaleDateString()}</span>
                    )}
                  </div>
                  <div className="mt-3 flex gap-2">
                    <button onClick={() => { setEditing(coupon); setIsNew(false); }} className="text-xs text-[#3c81c3] hover:underline">Edit</button>
                    <button onClick={() => deleteCoupon(coupon.id)} className="text-xs text-red-500 hover:underline">Archive</button>
                  </div>
                </div>
              ))}
              {coupons.length === 0 && (
                <div className="col-span-full text-center py-12 text-gray-500">
                  <p className="text-lg font-medium">No coupons yet</p>
                  <p className="text-sm mt-1">Create your first coupon to offer discounts.</p>
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
              <h2 className="text-lg font-bold">{isNew ? "New Coupon" : "Edit Coupon"}</h2>
              <button onClick={() => { setEditing(null); setIsNew(false); }} className="p-1 hover:bg-gray-100 rounded"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Code *</label>
                <input type="text" value={editing.code || ""} onChange={e => setEditing({ ...editing, code: e.target.value.toUpperCase() })}
                  className="w-full px-3 py-2 border rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" placeholder="e.g. SAVE20" />
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
                <label className="block text-sm font-medium text-gray-700 mb-1">Max Uses (leave empty for unlimited)</label>
                <input type="number" value={editing.maxUses || ""} onChange={e => setEditing({ ...editing, maxUses: parseInt(e.target.value) || null })}
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
                <button onClick={saveCoupon} disabled={!editing.code || !editing.name}
                  className="flex-1 px-4 py-2 bg-[#3c81c3] text-white rounded-lg text-sm hover:bg-[#2d6da8] disabled:opacity-50">Save</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
