"use client";

import { useState, useEffect, useCallback } from "react";
import { Network, Plus, Search, Edit2, Archive, X, RefreshCw } from "lucide-react";

interface ParentOrg {
  id: string;
  name: string;
  status: string;
  agencyId: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  notes: string | null;
  createdAt: string;
}

interface Agency {
  id: string;
  name: string;
}

export default function ParentOrgsPage() {
  const [orgs, setOrgs] = useState<ParentOrg[]>([]);
  const [agencies, setAgencies] = useState<Agency[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterAgency, setFilterAgency] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<ParentOrg | null>(null);
  const [form, setForm] = useState({
    name: "", agencyId: "", contactName: "", contactEmail: "", contactPhone: "", notes: "",
  });

  const fetchOrgs = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (filterAgency) params.set("agencyId", filterAgency);
      const res = await fetch(`/api/platform-admin/crm/parent-orgs?${params}`);
      const data = await res.json();
      if (data.ok) setOrgs(data.organizations);
    } catch (e) { console.error(e); }
    setLoading(false);
  }, [search, filterAgency]);

  const fetchAgencies = useCallback(async () => {
    try {
      const res = await fetch("/api/platform-admin/crm/agencies");
      const data = await res.json();
      if (data.ok) setAgencies(data.agencies);
    } catch (e) { console.error(e); }
  }, []);

  useEffect(() => { fetchOrgs(); }, [fetchOrgs]);
  useEffect(() => { fetchAgencies(); }, [fetchAgencies]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const method = editing ? "PUT" : "POST";
    const body = editing ? { id: editing.id, ...form } : form;
    if (!body.agencyId) delete (body as any).agencyId;
    const res = await fetch("/api/platform-admin/crm/parent-orgs", {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.ok) { setShowForm(false); setEditing(null); fetchOrgs(); }
  };

  const handleArchive = async (id: string) => {
    if (!confirm("Archive this organization?")) return;
    await fetch(`/api/platform-admin/crm/parent-orgs?id=${id}`, { method: "DELETE" });
    fetchOrgs();
  };

  const openEdit = (org: ParentOrg) => {
    setEditing(org);
    setForm({
      name: org.name, agencyId: org.agencyId || "",
      contactName: org.contactName || "", contactEmail: org.contactEmail || "",
      contactPhone: org.contactPhone || "", notes: org.notes || "",
    });
    setShowForm(true);
  };

  const openCreate = () => {
    setEditing(null);
    setForm({ name: "", agencyId: "", contactName: "", contactEmail: "", contactPhone: "", notes: "" });
    setShowForm(true);
  };

  const getAgencyName = (id: string | null) => agencies.find(a => a.id === id)?.name || "—";

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Network className="w-7 h-7 text-blue-600" /> Parent Organizations
          </h1>
          <p className="text-gray-500 mt-1">Multi-location groups and franchises</p>
        </div>
        <button onClick={openCreate} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">
          <Plus className="w-4 h-4" /> Add Organization
        </button>
      </div>

      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input type="text" placeholder="Search organizations..." value={search} onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
        </div>
        <select value={filterAgency} onChange={(e) => setFilterAgency(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm">
          <option value="">All Agencies</option>
          {agencies.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <button onClick={fetchOrgs} className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg">
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading organizations...</div>
      ) : orgs.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-xl border border-gray-200">
          <Network className="w-12 h-12 mx-auto text-gray-300 mb-3" />
          <p className="text-gray-500 font-medium">No parent organizations yet</p>
          <p className="text-gray-400 text-sm mt-1">Group accounts under parent organizations</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Organization</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Agency</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Contact</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {orgs.map((org) => (
                <tr key={org.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">{org.name}</td>
                  <td className="px-4 py-3 text-gray-500">{getAgencyName(org.agencyId)}</td>
                  <td className="px-4 py-3 text-gray-500">
                    {org.contactName && <div>{org.contactName}</div>}
                    {org.contactEmail && <div className="text-xs text-gray-400">{org.contactEmail}</div>}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                      org.status === "Active" ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-600"
                    }`}>{org.status}</span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => openEdit(org)} className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded">
                      <Edit2 className="w-4 h-4" />
                    </button>
                    <button onClick={() => handleArchive(org.id)} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded ml-1">
                      <Archive className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-lg">
            <div className="flex items-center justify-between p-5 border-b">
              <h2 className="text-lg font-semibold">{editing ? "Edit Organization" : "New Organization"}</h2>
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
                <label className="block text-sm font-medium text-gray-700 mb-1">Agency</label>
                <select value={form.agencyId} onChange={(e) => setForm({ ...form, agencyId: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
                  <option value="">No agency</option>
                  {agencies.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Contact Name</label>
                  <input type="text" value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Contact Email</label>
                  <input type="email" value={form.contactEmail} onChange={(e) => setForm({ ...form, contactEmail: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => { setShowForm(false); setEditing(null); }}
                  className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg text-sm">Cancel</button>
                <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm">
                  {editing ? "Save Changes" : "Create Organization"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
