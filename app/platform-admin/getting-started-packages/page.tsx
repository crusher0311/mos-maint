"use client";

import { useState, useEffect, useCallback } from "react";
import { PlatformAdminSidebar } from "@/components/ui/PlatformAdminSidebar";
import { Menu, Plus, X, Package, DollarSign, Check } from "lucide-react";

interface GSPackage {
  id: string;
  name: string;
  description: string | null;
  planId: string | null;
  includedProducts: string[];
  price: string | null;
  setupFee: string | null;
  isActive: boolean;
  sortOrder: number;
  features: string[];
  createdAt: string;
}

export default function GettingStartedPackagesPage() {
  const [packages, setPackages] = useState<GSPackage[]>([]);
  const [loading, setLoading] = useState(true);
  const [showMobileMenu, setShowMobileMenu] = useState(false);
  const [editing, setEditing] = useState<Partial<GSPackage> | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [featureInput, setFeatureInput] = useState("");

  const loadPackages = useCallback(async () => {
    try {
      const res = await fetch("/api/platform-admin/getting-started-packages");
      const data = await res.json();
      if (data.ok) setPackages(data.packages);
    } catch (e) {
      console.error("Error loading packages:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadPackages(); }, [loadPackages]);

  const savePackage = async () => {
    if (!editing?.name) return;
    try {
      const method = isNew ? "POST" : "PUT";
      const res = await fetch("/api/platform-admin/getting-started-packages", {
        method, headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editing),
      });
      const data = await res.json();
      if (data.ok) {
        const pkg = data.package;
        if (isNew) setPackages([...packages, pkg]);
        else setPackages(packages.map(p => p.id === pkg.id ? pkg : p));
        setEditing(null); setIsNew(false);
      }
    } catch (e) {
      console.error("Error saving package:", e);
    }
  };

  const deletePackage = async (id: string) => {
    if (!confirm("Archive this package?")) return;
    try {
      await fetch(`/api/platform-admin/getting-started-packages?id=${id}`, { method: "DELETE" });
      setPackages(packages.filter(p => p.id !== id));
    } catch (e) {
      console.error("Error deleting package:", e);
    }
  };

  const addFeature = () => {
    if (!featureInput || !editing) return;
    setEditing({ ...editing, features: [...(editing.features || []), featureInput] });
    setFeatureInput("");
  };

  const removeFeature = (index: number) => {
    if (!editing) return;
    const features = [...(editing.features || [])];
    features.splice(index, 1);
    setEditing({ ...editing, features });
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
                <h1 className="text-xl md:text-2xl font-bold text-gray-900">Getting Started Packages</h1>
                <p className="text-sm text-gray-500">{packages.length} packages</p>
              </div>
            </div>
            <button onClick={() => { setEditing({ name: "", isActive: true, features: [], sortOrder: packages.length }); setIsNew(true); }}
              className="flex items-center gap-2 px-4 py-2 bg-[#3c81c3] text-white rounded-lg hover:bg-[#2d6da8] text-sm">
              <Plus className="w-4 h-4" /> New Package
            </button>
          </div>
        </header>

        <div className="p-4 md:p-6">
          {loading ? (
            <div className="flex items-center justify-center h-64"><div className="animate-spin w-8 h-8 border-4 border-[#3c81c3] border-t-transparent rounded-full" /></div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {packages.map(pkg => (
                <div key={pkg.id} className="bg-white rounded-xl border-2 border-gray-200 p-6">
                  <div className="flex items-center gap-2 mb-2">
                    <Package className="w-5 h-5 text-[#3c81c3]" />
                    <h3 className="font-bold text-gray-900">{pkg.name}</h3>
                    {!pkg.isActive && <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full">Inactive</span>}
                  </div>
                  {pkg.description && <p className="text-sm text-gray-500 mb-3">{pkg.description}</p>}
                  {pkg.price && (
                    <div className="mb-3">
                      <p className="text-2xl font-bold text-gray-900">${parseFloat(pkg.price).toFixed(2)}</p>
                      {pkg.setupFee && parseFloat(pkg.setupFee) > 0 && <p className="text-xs text-gray-400">+ ${pkg.setupFee} setup</p>}
                    </div>
                  )}
                  {pkg.features && pkg.features.length > 0 && (
                    <ul className="space-y-1 mb-4">
                      {pkg.features.map((f, i) => (
                        <li key={i} className="flex items-center gap-2 text-sm text-gray-600">
                          <Check className="w-4 h-4 text-green-500 flex-shrink-0" /> {f}
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="flex gap-2">
                    <button onClick={() => { setEditing(pkg); setIsNew(false); }} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50 flex-1">Edit</button>
                    <button onClick={() => deletePackage(pkg.id)} className="px-4 py-2 text-red-500 border border-red-200 rounded-lg text-sm hover:bg-red-50">Archive</button>
                  </div>
                </div>
              ))}
              {packages.length === 0 && (
                <div className="col-span-full text-center py-12 text-gray-500">
                  <p className="text-lg font-medium">No packages yet</p>
                  <p className="text-sm mt-1">Create getting started packages for new customers.</p>
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
              <h2 className="text-lg font-bold">{isNew ? "New Package" : "Edit Package"}</h2>
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
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Price</label>
                  <input type="number" step="0.01" value={editing.price || ""} onChange={e => setEditing({ ...editing, price: e.target.value || null })}
                    className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Setup Fee</label>
                  <input type="number" step="0.01" value={editing.setupFee || ""} onChange={e => setEditing({ ...editing, setupFee: e.target.value || null })}
                    className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Features</label>
                <div className="flex gap-2 mb-2">
                  <input type="text" value={featureInput} onChange={e => setFeatureInput(e.target.value)}
                    placeholder="Add feature..." onKeyDown={e => e.key === "Enter" && (e.preventDefault(), addFeature())}
                    className="flex-1 px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
                  <button onClick={addFeature} className="px-3 py-2 bg-gray-100 rounded-lg text-sm hover:bg-gray-200">Add</button>
                </div>
                <div className="space-y-1">
                  {(editing.features || []).map((f, i) => (
                    <div key={i} className="flex items-center gap-2 bg-gray-50 px-3 py-1.5 rounded-lg text-sm">
                      <Check className="w-4 h-4 text-green-500" />
                      <span className="flex-1">{f}</span>
                      <button onClick={() => removeFeature(i)} className="text-red-400 hover:text-red-600"><X className="w-3 h-3" /></button>
                    </div>
                  ))}
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={editing.isActive ?? true} onChange={e => setEditing({ ...editing, isActive: e.target.checked })} className="rounded" /> Active
              </label>
              <div className="flex gap-2 pt-2">
                <button onClick={() => { setEditing(null); setIsNew(false); }} className="flex-1 px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">Cancel</button>
                <button onClick={savePackage} disabled={!editing.name}
                  className="flex-1 px-4 py-2 bg-[#3c81c3] text-white rounded-lg text-sm hover:bg-[#2d6da8] disabled:opacity-50">Save</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
