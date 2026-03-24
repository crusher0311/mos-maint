"use client";

import { useState, useEffect, useCallback } from "react";
import { PlatformAdminSidebar } from "@/components/ui/PlatformAdminSidebar";
import { Menu, Plus, Search, X, CreditCard, Star, Check } from "lucide-react";

interface Plan {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  monthlyPrice: string;
  annualPrice: string | null;
  setupFee: string | null;
  trialDays: number;
  isActive: boolean;
  isPopular: boolean;
  sortOrder: number;
  stripePriceIdMonthly: string | null;
  stripePriceIdAnnual: string | null;
  createdAt: string;
}

export default function PricingPlansPage() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [showMobileMenu, setShowMobileMenu] = useState(false);
  const [editing, setEditing] = useState<Partial<Plan> | null>(null);
  const [isNew, setIsNew] = useState(false);

  const loadPlans = useCallback(async () => {
    try {
      const res = await fetch("/api/platform-admin/pricing-plans");
      const data = await res.json();
      if (data.ok) setPlans(data.plans);
    } catch (e) {
      console.error("Error loading plans:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadPlans(); }, [loadPlans]);

  const savePlan = async () => {
    if (!editing?.name || !editing?.slug || !editing?.monthlyPrice) return;
    try {
      const method = isNew ? "POST" : "PUT";
      const res = await fetch("/api/platform-admin/pricing-plans", {
        method, headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editing),
      });
      const data = await res.json();
      if (data.ok) {
        if (isNew) setPlans([...plans, data.plan]);
        else setPlans(plans.map(p => p.id === data.plan.id ? data.plan : p));
        setEditing(null); setIsNew(false);
      } else {
        alert(data.error);
      }
    } catch (e) {
      console.error("Error saving plan:", e);
    }
  };

  const deletePlan = async (id: string) => {
    if (!confirm("Archive this pricing plan?")) return;
    try {
      await fetch(`/api/platform-admin/pricing-plans?id=${id}`, { method: "DELETE" });
      setPlans(plans.filter(p => p.id !== id));
    } catch (e) {
      console.error("Error deleting plan:", e);
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
                <h1 className="text-xl md:text-2xl font-bold text-gray-900">Pricing Plans</h1>
                <p className="text-sm text-gray-500">{plans.length} plans</p>
              </div>
            </div>
            <button onClick={() => { setEditing({ name: "", slug: "", monthlyPrice: "", isActive: true, isPopular: false, trialDays: 0, sortOrder: plans.length }); setIsNew(true); }}
              className="flex items-center gap-2 px-4 py-2 bg-[#3c81c3] text-white rounded-lg hover:bg-[#2d6da8] text-sm">
              <Plus className="w-4 h-4" /> New Plan
            </button>
          </div>
        </header>

        <div className="p-4 md:p-6">
          {loading ? (
            <div className="flex items-center justify-center h-64"><div className="animate-spin w-8 h-8 border-4 border-[#3c81c3] border-t-transparent rounded-full" /></div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {plans.map(plan => (
                <div key={plan.id} className={`bg-white rounded-xl border-2 p-6 relative ${plan.isPopular ? "border-[#3c81c3]" : "border-gray-200"}`}>
                  {plan.isPopular && (
                    <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-[#3c81c3] text-white text-xs px-3 py-1 rounded-full flex items-center gap-1">
                      <Star className="w-3 h-3" /> Popular
                    </div>
                  )}
                  <div className="text-center mb-4">
                    <h3 className="text-lg font-bold text-gray-900">{plan.name}</h3>
                    <p className="text-sm text-gray-500">{plan.slug}</p>
                    {!plan.isActive && <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full mt-1 inline-block">Inactive</span>}
                  </div>
                  <div className="text-center mb-4">
                    <p className="text-3xl font-bold text-gray-900">${parseFloat(plan.monthlyPrice).toFixed(2)}<span className="text-sm font-normal text-gray-500">/mo</span></p>
                    {plan.annualPrice && <p className="text-sm text-gray-500">${parseFloat(plan.annualPrice).toFixed(2)}/yr</p>}
                    {plan.setupFee && parseFloat(plan.setupFee) > 0 && <p className="text-xs text-gray-400 mt-1">${plan.setupFee} setup fee</p>}
                    {plan.trialDays > 0 && <p className="text-xs text-green-600 mt-1">{plan.trialDays}-day free trial</p>}
                  </div>
                  {plan.description && <p className="text-sm text-gray-500 text-center mb-4">{plan.description}</p>}
                  <div className="flex gap-2 justify-center">
                    <button onClick={() => { setEditing(plan); setIsNew(false); }} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">Edit</button>
                    <button onClick={() => deletePlan(plan.id)} className="px-4 py-2 text-red-500 border border-red-200 rounded-lg text-sm hover:bg-red-50">Archive</button>
                  </div>
                </div>
              ))}
              {plans.length === 0 && (
                <div className="col-span-full text-center py-12 text-gray-500">
                  <p className="text-lg font-medium">No pricing plans yet</p>
                  <p className="text-sm mt-1">Create pricing plans for your services.</p>
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
              <h2 className="text-lg font-bold">{isNew ? "New Plan" : "Edit Plan"}</h2>
              <button onClick={() => { setEditing(null); setIsNew(false); }} className="p-1 hover:bg-gray-100 rounded"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Name *</label>
                <input type="text" value={editing.name || ""} onChange={e => setEditing({ ...editing, name: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Slug *</label>
                <input type="text" value={editing.slug || ""} onChange={e => setEditing({ ...editing, slug: e.target.value.toLowerCase().replace(/\s+/g, "-") })}
                  className="w-full px-3 py-2 border rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <textarea value={editing.description || ""} onChange={e => setEditing({ ...editing, description: e.target.value })} rows={2}
                  className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Monthly Price *</label>
                  <input type="number" step="0.01" value={editing.monthlyPrice || ""} onChange={e => setEditing({ ...editing, monthlyPrice: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Annual Price</label>
                  <input type="number" step="0.01" value={editing.annualPrice || ""} onChange={e => setEditing({ ...editing, annualPrice: e.target.value || null })}
                    className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Setup Fee</label>
                  <input type="number" step="0.01" value={editing.setupFee || ""} onChange={e => setEditing({ ...editing, setupFee: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Trial Days</label>
                  <input type="number" value={editing.trialDays || 0} onChange={e => setEditing({ ...editing, trialDays: parseInt(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
                </div>
              </div>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={editing.isActive ?? true} onChange={e => setEditing({ ...editing, isActive: e.target.checked })} className="rounded" /> Active
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={editing.isPopular ?? false} onChange={e => setEditing({ ...editing, isPopular: e.target.checked })} className="rounded" /> Popular
                </label>
              </div>
              <div className="flex gap-2 pt-2">
                <button onClick={() => { setEditing(null); setIsNew(false); }} className="flex-1 px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">Cancel</button>
                <button onClick={savePlan} disabled={!editing.name || !editing.slug || !editing.monthlyPrice}
                  className="flex-1 px-4 py-2 bg-[#3c81c3] text-white rounded-lg text-sm hover:bg-[#2d6da8] disabled:opacity-50">Save</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
