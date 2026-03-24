"use client";

import { useState, useEffect, useCallback } from "react";
import { PlatformAdminSidebar } from "@/components/ui/PlatformAdminSidebar";
import { Menu, Plus, Search, X, Package, DollarSign } from "lucide-react";

interface Product {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  category: string | null;
  price: string | null;
  isActive: boolean;
  imageUrl: string | null;
  sortOrder: number;
  createdAt: string;
}

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [showMobileMenu, setShowMobileMenu] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [editing, setEditing] = useState<Partial<Product> | null>(null);
  const [isNew, setIsNew] = useState(false);

  const loadProducts = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (searchTerm) params.set("search", searchTerm);
      const res = await fetch(`/api/platform-admin/products?${params}`);
      const data = await res.json();
      if (data.ok) setProducts(data.products);
    } catch (e) {
      console.error("Error loading products:", e);
    } finally {
      setLoading(false);
    }
  }, [searchTerm]);

  useEffect(() => { loadProducts(); }, [loadProducts]);

  const saveProduct = async () => {
    if (!editing?.name || !editing?.slug) return;
    try {
      const method = isNew ? "POST" : "PUT";
      const res = await fetch("/api/platform-admin/products", {
        method, headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editing),
      });
      const data = await res.json();
      if (data.ok) {
        if (isNew) setProducts([...products, data.product]);
        else setProducts(products.map(p => p.id === data.product.id ? data.product : p));
        setEditing(null); setIsNew(false);
      } else {
        alert(data.error);
      }
    } catch (e) {
      console.error("Error saving product:", e);
    }
  };

  const deleteProduct = async (id: string) => {
    if (!confirm("Archive this product?")) return;
    try {
      await fetch(`/api/platform-admin/products?id=${id}`, { method: "DELETE" });
      setProducts(products.filter(p => p.id !== id));
    } catch (e) {
      console.error("Error deleting product:", e);
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
                <h1 className="text-xl md:text-2xl font-bold text-gray-900">Products</h1>
                <p className="text-sm text-gray-500">{products.length} products</p>
              </div>
            </div>
            <button onClick={() => { setEditing({ name: "", slug: "", category: "", isActive: true, sortOrder: products.length }); setIsNew(true); }}
              className="flex items-center gap-2 px-4 py-2 bg-[#3c81c3] text-white rounded-lg hover:bg-[#2d6da8] text-sm">
              <Plus className="w-4 h-4" /> New Product
            </button>
          </div>
          <div className="mt-3 relative max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input type="text" placeholder="Search products..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-4 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
          </div>
        </header>

        <div className="p-4 md:p-6">
          {loading ? (
            <div className="flex items-center justify-center h-64"><div className="animate-spin w-8 h-8 border-4 border-[#3c81c3] border-t-transparent rounded-full" /></div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {products.map(product => (
                <div key={product.id} className="bg-white rounded-xl border p-4 hover:shadow-sm transition-shadow">
                  <div className="flex items-start gap-3">
                    <div className="w-12 h-12 rounded-lg bg-[#3c81c3]/10 flex items-center justify-center flex-shrink-0">
                      <Package className="w-6 h-6 text-[#3c81c3]" />
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="font-medium text-gray-900">{product.name}</h3>
                        {!product.isActive && <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full">Inactive</span>}
                      </div>
                      <p className="text-xs text-gray-500 font-mono">{product.slug}</p>
                      {product.category && <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full mt-1 inline-block">{product.category}</span>}
                      {product.description && <p className="text-sm text-gray-500 mt-2 line-clamp-2">{product.description}</p>}
                      {product.price && (
                        <p className="text-lg font-bold text-gray-900 mt-2 flex items-center gap-1">
                          <DollarSign className="w-4 h-4" />{parseFloat(product.price).toFixed(2)}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="mt-3 flex gap-2">
                    <button onClick={() => { setEditing(product); setIsNew(false); }} className="text-xs text-[#3c81c3] hover:underline">Edit</button>
                    <button onClick={() => deleteProduct(product.id)} className="text-xs text-red-500 hover:underline">Archive</button>
                  </div>
                </div>
              ))}
              {products.length === 0 && (
                <div className="col-span-full text-center py-12 text-gray-500">
                  <p className="text-lg font-medium">No products yet</p>
                  <p className="text-sm mt-1">Add products to your catalog.</p>
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
              <h2 className="text-lg font-bold">{isNew ? "New Product" : "Edit Product"}</h2>
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
                  <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
                  <input type="text" value={editing.category || ""} onChange={e => setEditing({ ...editing, category: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Price</label>
                  <input type="number" step="0.01" value={editing.price || ""} onChange={e => setEditing({ ...editing, price: e.target.value || null })}
                    className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#3c81c3]/30" />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={editing.isActive ?? true} onChange={e => setEditing({ ...editing, isActive: e.target.checked })} className="rounded" /> Active
              </label>
              <div className="flex gap-2 pt-2">
                <button onClick={() => { setEditing(null); setIsNew(false); }} className="flex-1 px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">Cancel</button>
                <button onClick={saveProduct} disabled={!editing.name || !editing.slug}
                  className="flex-1 px-4 py-2 bg-[#3c81c3] text-white rounded-lg text-sm hover:bg-[#2d6da8] disabled:opacity-50">Save</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
