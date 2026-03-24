"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Building2,
  Plus,
  Search,
  Edit2,
  Archive,
  Globe,
  Mail,
  Phone,
  Palette,
  X,
  RefreshCw,
} from "lucide-react";

interface Agency {
  id: string;
  name: string;
  slug: string;
  type: string;
  status: string;
  contactEmail: string | null;
  contactPhone: string | null;
  primaryColor: string | null;
  logo: string | null;
  corporateWebsite: string | null;
  commissionRate: string | null;
  createdAt: string;
}

export default function AgenciesPage() {
  const [agencies, setAgencies] = useState<Agency[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Agency | null>(null);
  const [form, setForm] = useState({
    name: "", slug: "", type: "marketing", contactEmail: "", contactPhone: "",
    primaryColor: "#3c81c3", corporateWebsite: "", commissionRate: "10.00",
  });

  const fetchAgencies = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/platform-admin/crm/agencies?search=${encodeURIComponent(search)}`);
      const data = await res.json();
      if (data.ok) setAgencies(data.agencies);
    } catch (e) { console.error(e); }
    setLoading(false);
  }, [search]);

  useEffect(() => { fetchAgencies(); }, [fetchAgencies]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const method = editing ? "PUT" : "POST";
    const body = editing ? { id: editing.id, ...form } : form;
    const res = await fetch("/api/platform-admin/crm/agencies", {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.ok) { setShowForm(false); setEditing(null); fetchAgencies(); }
  };

  const handleArchive = async (id: string) => {
    if (!confirm("Archive this agency?")) return;
    await fetch(`/api/platform-admin/crm/agencies?id=${id}`, { method: "DELETE" });
    fetchAgencies();
  };

  const openEdit = (agency: Agency) => {
    setEditing(agency);
    setForm({
      name: agency.name, slug: agency.slug, type: agency.type,
      contactEmail: agency.contactEmail || "", contactPhone: agency.contactPhone || "",
      primaryColor: agency.primaryColor || "#3c81c3", corporateWebsite: agency.corporateWebsite || "",
      commissionRate: agency.commissionRate || "10.00",
    });
    setShowForm(true);
  };

  const openCreate = () => {
    setEditing(null);
    setForm({ name: "", slug: "", type: "marketing", contactEmail: "", contactPhone: "", primaryColor: "#3c81c3", corporateWebsite: "", commissionRate: "10.00" });
    setShowForm(true);
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Building2 className="w-7 h-7 text-blue-600" /> Agencies
          </h1>
          <p className="text-gray-500 mt-1">White-label reseller partners</p>
        </div>
        <button onClick={openCreate} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">
          <Plus className="w-4 h-4" /> Add Agency
        </button>
      </div>

      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input type="text" placeholder="Search agencies..." value={search} onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
        </div>
        <button onClick={fetchAgencies} className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg">
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading agencies...</div>
      ) : agencies.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-xl border border-gray-200">
          <Building2 className="w-12 h-12 mx-auto text-gray-300 mb-3" />
          <p className="text-gray-500 font-medium">No agencies yet</p>
          <p className="text-gray-400 text-sm mt-1">Create your first white-label agency partner</p>
        </div>
      ) : (
        <div className="grid gap-4">
          {agencies.map((agency) => (
            <div key={agency.id} className="bg-white rounded-xl border border-gray-200 p-5 hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-lg flex items-center justify-center text-white font-bold text-lg"
                    style={{ backgroundColor: agency.primaryColor || "#3c81c3" }}>
                    {agency.name.charAt(0)}
                  </div>
                  <div>
                    <h3 className="font-semibold text-gray-900">{agency.name}</h3>
                    <p className="text-sm text-gray-500">/{agency.slug}</p>
                    <div className="flex items-center gap-3 mt-1 text-xs text-gray-400">
                      <span className={`px-2 py-0.5 rounded-full font-medium ${
                        agency.status === "Active" ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-600"
                      }`}>{agency.status}</span>
                      <span className="capitalize">{agency.type}</span>
                      {agency.commissionRate && <span>{agency.commissionRate}% commission</span>}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {agency.contactEmail && (
                    <span className="text-xs text-gray-400 flex items-center gap-1">
                      <Mail className="w-3 h-3" /> {agency.contactEmail}
                    </span>
                  )}
                  <button onClick={() => openEdit(agency)} className="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg">
                    <Edit2 className="w-4 h-4" />
                  </button>
                  <button onClick={() => handleArchive(agency.id)} className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg">
                    <Archive className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-5 border-b">
              <h2 className="text-lg font-semibold">{editing ? "Edit Agency" : "New Agency"}</h2>
              <button onClick={() => { setShowForm(false); setEditing(null); }} className="p-1 hover:bg-gray-100 rounded-lg">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="p-5 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                <input type="text" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Slug</label>
                <input type="text" required value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500" placeholder="unique-slug" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
                  <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
                    <option value="marketing">Marketing</option>
                    <option value="coaching">Coaching</option>
                    <option value="enterprise">Enterprise</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Commission %</label>
                  <input type="number" step="0.01" value={form.commissionRate} onChange={(e) => setForm({ ...form, commissionRate: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                  <input type="email" value={form.contactEmail} onChange={(e) => setForm({ ...form, contactEmail: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
                  <input type="tel" value={form.contactPhone} onChange={(e) => setForm({ ...form, contactPhone: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Brand Color</label>
                  <div className="flex items-center gap-2">
                    <input type="color" value={form.primaryColor} onChange={(e) => setForm({ ...form, primaryColor: e.target.value })}
                      className="w-10 h-10 rounded border cursor-pointer" />
                    <input type="text" value={form.primaryColor} onChange={(e) => setForm({ ...form, primaryColor: e.target.value })}
                      className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Website</label>
                  <input type="url" value={form.corporateWebsite} onChange={(e) => setForm({ ...form, corporateWebsite: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" placeholder="https://" />
                </div>
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => { setShowForm(false); setEditing(null); }}
                  className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg text-sm">Cancel</button>
                <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm">
                  {editing ? "Save Changes" : "Create Agency"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
