"use client";

import { useState, useEffect, useCallback } from "react";
import { Store, Plus, Search, Edit2, Archive, X, RefreshCw, BarChart3 } from "lucide-react";

interface Account {
  id: string;
  name: string;
  status: string;
  plan: string;
  agencyId: string | null;
  parentOrganizationId: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  ownerPhone: string | null;
  linkedShopId: number | null;
  smsNumber: string | null;
  notes: string | null;
  createdAt: string;
}

interface Stats { total: number; active: number; inactive: number; }

export default function AccountsPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [filterPlan, setFilterPlan] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [form, setForm] = useState({
    name: "", plan: "Growth", ownerName: "", ownerEmail: "", ownerPhone: "",
    linkedShopId: "", smsNumber: "", notes: "", agencyId: "", parentOrganizationId: "",
  });

  const fetchAccounts = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (filterStatus) params.set("status", filterStatus);
      if (filterPlan) params.set("plan", filterPlan);
      const res = await fetch(`/api/platform-admin/crm/accounts?${params}`);
      const data = await res.json();
      if (data.ok) { setAccounts(data.accounts); setStats(data.stats); }
    } catch (e) { console.error(e); }
    setLoading(false);
  }, [search, filterStatus, filterPlan]);

  useEffect(() => { fetchAccounts(); }, [fetchAccounts]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const method = editing ? "PUT" : "POST";
    const payload: any = { ...form };
    if (editing) payload.id = editing.id;
    if (payload.linkedShopId) payload.linkedShopId = parseInt(payload.linkedShopId);
    else delete payload.linkedShopId;
    if (!payload.agencyId) delete payload.agencyId;
    if (!payload.parentOrganizationId) delete payload.parentOrganizationId;
    const res = await fetch("/api/platform-admin/crm/accounts", {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.ok) { setShowForm(false); setEditing(null); fetchAccounts(); }
  };

  const handleArchive = async (id: string) => {
    if (!confirm("Archive this account?")) return;
    await fetch(`/api/platform-admin/crm/accounts?id=${id}`, { method: "DELETE" });
    fetchAccounts();
  };

  const openEdit = (acc: Account) => {
    setEditing(acc);
    setForm({
      name: acc.name, plan: acc.plan, ownerName: acc.ownerName || "",
      ownerEmail: acc.ownerEmail || "", ownerPhone: acc.ownerPhone || "",
      linkedShopId: acc.linkedShopId?.toString() || "", smsNumber: acc.smsNumber || "",
      notes: acc.notes || "", agencyId: acc.agencyId || "",
      parentOrganizationId: acc.parentOrganizationId || "",
    });
    setShowForm(true);
  };

  const openCreate = () => {
    setEditing(null);
    setForm({ name: "", plan: "Growth", ownerName: "", ownerEmail: "", ownerPhone: "", linkedShopId: "", smsNumber: "", notes: "", agencyId: "", parentOrganizationId: "" });
    setShowForm(true);
  };

  const planColors: Record<string, string> = {
    Starter: "bg-gray-100 text-gray-700",
    Growth: "bg-blue-100 text-blue-700",
    Premium: "bg-purple-100 text-purple-700",
    Enterprise: "bg-amber-100 text-amber-700",
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Store className="w-7 h-7 text-blue-600" /> Accounts
          </h1>
          <p className="text-gray-500 mt-1">Individual shop accounts</p>
        </div>
        <button onClick={openCreate} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">
          <Plus className="w-4 h-4" /> Add Account
        </button>
      </div>

      {stats && (
        <div className="grid grid-cols-3 gap-4 mb-6">
          {[
            { label: "Total Accounts", value: stats.total, color: "text-blue-600" },
            { label: "Active", value: stats.active, color: "text-green-600" },
            { label: "Inactive", value: stats.inactive, color: "text-gray-500" },
          ].map((s) => (
            <div key={s.label} className="bg-white rounded-xl border border-gray-200 p-4">
              <div className="text-sm text-gray-500">{s.label}</div>
              <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input type="text" placeholder="Search accounts..." value={search} onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
        </div>
        <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm">
          <option value="">All Status</option>
          <option value="Active">Active</option>
          <option value="Inactive">Inactive</option>
          <option value="Onboarding">Onboarding</option>
          <option value="Suspended">Suspended</option>
        </select>
        <select value={filterPlan} onChange={(e) => setFilterPlan(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm">
          <option value="">All Plans</option>
          <option value="Starter">Starter</option>
          <option value="Growth">Growth</option>
          <option value="Premium">Premium</option>
          <option value="Enterprise">Enterprise</option>
        </select>
        <button onClick={fetchAccounts} className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg">
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading accounts...</div>
      ) : accounts.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-xl border border-gray-200">
          <Store className="w-12 h-12 mx-auto text-gray-300 mb-3" />
          <p className="text-gray-500 font-medium">No accounts yet</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Account</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Plan</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Owner</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Shop ID</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {accounts.map((acc) => (
                <tr key={acc.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900">{acc.name}</div>
                    {acc.smsNumber && <div className="text-xs text-gray-400">{acc.smsNumber}</div>}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${planColors[acc.plan] || "bg-gray-100 text-gray-700"}`}>{acc.plan}</span>
                  </td>
                  <td className="px-4 py-3 text-gray-500">
                    {acc.ownerName && <div>{acc.ownerName}</div>}
                    {acc.ownerEmail && <div className="text-xs text-gray-400">{acc.ownerEmail}</div>}
                  </td>
                  <td className="px-4 py-3 text-gray-500 font-mono text-xs">{acc.linkedShopId || "—"}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                      acc.status === "Active" ? "bg-green-100 text-green-700" :
                      acc.status === "Onboarding" ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-600"
                    }`}>{acc.status}</span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => openEdit(acc)} className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded">
                      <Edit2 className="w-4 h-4" />
                    </button>
                    <button onClick={() => handleArchive(acc.id)} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded ml-1">
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
              <h2 className="text-lg font-semibold">{editing ? "Edit Account" : "New Account"}</h2>
              <button onClick={() => { setShowForm(false); setEditing(null); }} className="p-1 hover:bg-gray-100 rounded-lg">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="p-5 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Account Name</label>
                <input type="text" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Plan</label>
                  <select value={form.plan} onChange={(e) => setForm({ ...form, plan: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
                    <option value="Starter">Starter</option>
                    <option value="Growth">Growth</option>
                    <option value="Premium">Premium</option>
                    <option value="Enterprise">Enterprise</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Linked Shop ID</label>
                  <input type="number" value={form.linkedShopId} onChange={(e) => setForm({ ...form, linkedShopId: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" placeholder="e.g. 63" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Owner Name</label>
                  <input type="text" value={form.ownerName} onChange={(e) => setForm({ ...form, ownerName: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Owner Email</label>
                  <input type="email" value={form.ownerEmail} onChange={(e) => setForm({ ...form, ownerEmail: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Owner Phone</label>
                  <input type="tel" value={form.ownerPhone} onChange={(e) => setForm({ ...form, ownerPhone: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">SMS Number</label>
                  <input type="tel" value={form.smsNumber} onChange={(e) => setForm({ ...form, smsNumber: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" placeholder="+1..." />
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
                  {editing ? "Save Changes" : "Create Account"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
