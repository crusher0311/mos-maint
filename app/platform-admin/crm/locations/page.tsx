"use client";

import { useState, useEffect, useCallback } from "react";
import { MapPin, Plus, Search, Edit2, Archive, X, RefreshCw } from "lucide-react";

interface Location {
  id: string;
  name: string;
  accountId: string;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone: string | null;
  timezone: string | null;
  smsNumber: string | null;
  linkedShopId: number | null;
  createdAt: string;
  archivedAt: string | null;
}

interface Account {
  id: string;
  name: string;
}

export default function LocationsPage() {
  const [locations, setLocations] = useState<Location[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterAccount, setFilterAccount] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Location | null>(null);
  const [form, setForm] = useState({
    name: "", accountId: "", address: "", city: "", state: "", zip: "",
    phone: "", timezone: "America/Chicago", smsNumber: "", linkedShopId: "",
  });

  const fetchLocations = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (filterAccount) params.set("accountId", filterAccount);
      const res = await fetch(`/api/platform-admin/crm/locations?${params}`);
      const data = await res.json();
      if (data.ok) setLocations(data.locations);
    } catch (e) { console.error(e); }
    setLoading(false);
  }, [search, filterAccount]);

  const fetchAccounts = useCallback(async () => {
    try {
      const res = await fetch("/api/platform-admin/crm/accounts");
      const data = await res.json();
      if (data.ok) setAccounts(data.accounts);
    } catch (e) { console.error(e); }
  }, []);

  useEffect(() => { fetchLocations(); }, [fetchLocations]);
  useEffect(() => { fetchAccounts(); }, [fetchAccounts]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const method = editing ? "PUT" : "POST";
    const payload: any = { ...form };
    if (editing) payload.id = editing.id;
    if (payload.linkedShopId) payload.linkedShopId = parseInt(payload.linkedShopId);
    else delete payload.linkedShopId;
    const res = await fetch("/api/platform-admin/crm/locations", {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.ok) { setShowForm(false); setEditing(null); fetchLocations(); }
  };

  const handleArchive = async (id: string) => {
    if (!confirm("Archive this location?")) return;
    await fetch(`/api/platform-admin/crm/locations?id=${id}`, { method: "DELETE" });
    fetchLocations();
  };

  const openEdit = (loc: Location) => {
    setEditing(loc);
    setForm({
      name: loc.name, accountId: loc.accountId, address: loc.address || "",
      city: loc.city || "", state: loc.state || "", zip: loc.zip || "",
      phone: loc.phone || "", timezone: loc.timezone || "America/Chicago",
      smsNumber: loc.smsNumber || "", linkedShopId: loc.linkedShopId?.toString() || "",
    });
    setShowForm(true);
  };

  const openCreate = () => {
    setEditing(null);
    setForm({ name: "", accountId: "", address: "", city: "", state: "", zip: "", phone: "", timezone: "America/Chicago", smsNumber: "", linkedShopId: "" });
    setShowForm(true);
  };

  const getAccountName = (id: string) => accounts.find(a => a.id === id)?.name || "—";

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <MapPin className="w-7 h-7 text-blue-600" /> Locations
          </h1>
          <p className="text-gray-500 mt-1">Physical shop locations tied to accounts</p>
        </div>
        <button onClick={openCreate} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">
          <Plus className="w-4 h-4" /> Add Location
        </button>
      </div>

      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input type="text" placeholder="Search locations..." value={search} onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
        </div>
        <select value={filterAccount} onChange={(e) => setFilterAccount(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm">
          <option value="">All Accounts</option>
          {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <button onClick={fetchLocations} className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg">
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading locations...</div>
      ) : locations.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-xl border border-gray-200">
          <MapPin className="w-12 h-12 mx-auto text-gray-300 mb-3" />
          <p className="text-gray-500 font-medium">No locations yet</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Location</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Account</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Address</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Shop ID</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {locations.map((loc) => (
                <tr key={loc.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900">{loc.name}</div>
                    {loc.phone && <div className="text-xs text-gray-400">{loc.phone}</div>}
                  </td>
                  <td className="px-4 py-3 text-gray-500">{getAccountName(loc.accountId)}</td>
                  <td className="px-4 py-3 text-gray-500 text-xs">
                    {[loc.address, loc.city, loc.state, loc.zip].filter(Boolean).join(", ") || "—"}
                  </td>
                  <td className="px-4 py-3 text-gray-500 font-mono text-xs">{loc.linkedShopId || "—"}</td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => openEdit(loc)} className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded">
                      <Edit2 className="w-4 h-4" />
                    </button>
                    <button onClick={() => handleArchive(loc.id)} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded ml-1">
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
          <div className="bg-white rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-5 border-b">
              <h2 className="text-lg font-semibold">{editing ? "Edit Location" : "New Location"}</h2>
              <button onClick={() => { setShowForm(false); setEditing(null); }} className="p-1 hover:bg-gray-100 rounded-lg">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="p-5 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                  <input type="text" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Account</label>
                  <select required value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
                    <option value="">Select account</option>
                    {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Address</label>
                <input type="text" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">City</label>
                  <input type="text" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">State</label>
                  <input type="text" value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" maxLength={2} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">ZIP</label>
                  <input type="text" value={form.zip} onChange={(e) => setForm({ ...form, zip: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
                  <input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Shop ID</label>
                  <input type="number" value={form.linkedShopId} onChange={(e) => setForm({ ...form, linkedShopId: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                </div>
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => { setShowForm(false); setEditing(null); }}
                  className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg text-sm">Cancel</button>
                <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm">
                  {editing ? "Save Changes" : "Create Location"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
