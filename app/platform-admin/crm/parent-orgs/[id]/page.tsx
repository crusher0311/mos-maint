"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Edit2, Archive, Loader2, Mail, Phone, Globe, Users } from "lucide-react";
import BrandingEditor from "@/components/crm/BrandingEditor";

interface ParentOrg {
  id: string;
  name: string;
  slug: string;
  agencyId: string;
  contactEmail: string | null;
  contactPhone: string | null;
  website: string | null;
  status: string;
  createdAt: string;
  archivedAt: string | null;
}

interface Account {
  id: string;
  name: string;
  slug: string;
  status: string;
}

export default function ParentOrgDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [org, setOrg] = useState<ParentOrg | null>(null);
  const [childAccounts, setChildAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ name: "", slug: "", contactEmail: "", contactPhone: "", website: "" });

  useEffect(() => { loadData(); }, [id]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [orgRes, acctsRes] = await Promise.all([
        fetch(`/api/platform-admin/crm/parent-orgs/${id}`),
        fetch(`/api/platform-admin/crm/accounts?parentOrgId=${id}`),
      ]);
      const orgData = await orgRes.json();
      const acctsData = await acctsRes.json();

      if (orgData.ok && orgData.parentOrg) {
        setOrg(orgData.parentOrg);
        setForm({
          name: orgData.parentOrg.name,
          slug: orgData.parentOrg.slug,
          contactEmail: orgData.parentOrg.contactEmail || "",
          contactPhone: orgData.parentOrg.contactPhone || "",
          website: orgData.parentOrg.website || "",
        });
      }
      if (acctsData.ok) setChildAccounts(acctsData.accounts || []);
    } catch (err) {
      console.error("Error loading parent org:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!form.name || !form.slug) { setError("Name and slug are required"); return; }
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/platform-admin/crm/parent-orgs/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || "Failed to save"); return; }
      setOrg(data.parentOrg);
      setEditing(false);
    } catch { setError("Network error"); } finally { setSaving(false); }
  };

  const handleArchive = async () => {
    if (!confirm("Archive this parent organization?")) return;
    try {
      await fetch(`/api/platform-admin/crm/parent-orgs/${id}`, { method: "DELETE" });
      router.push("/platform-admin/crm/parent-orgs");
    } catch (err) { console.error(err); }
  };

  if (loading) {
    return <div className="flex justify-center py-24"><Loader2 className="w-8 h-8 animate-spin text-[#3c81c3]" /></div>;
  }

  if (!org) {
    return (
      <div className="p-6">
        <button onClick={() => router.push("/platform-admin/crm/parent-orgs")} className="flex items-center gap-2 text-[#3c81c3] hover:underline mb-4">
          <ArrowLeft className="w-4 h-4" /> Back to Parent Orgs
        </button>
        <p className="text-gray-500">Parent organization not found.</p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div className="flex items-center gap-3">
        <button onClick={() => router.push("/platform-admin/crm/parent-orgs")} className="p-1.5 hover:bg-gray-100 rounded-lg">
          <ArrowLeft className="w-5 h-5 text-gray-500" />
        </button>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-gray-900">{org.name}</h1>
          <p className="text-sm text-gray-500">{org.slug}</p>
        </div>
        <span className={`px-2.5 py-1 rounded text-xs font-medium ${org.status === "Active" ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-700"}`}>
          {org.status}
        </span>
        <button onClick={() => setEditing(!editing)} className="p-2 text-gray-400 hover:text-[#3c81c3] hover:bg-gray-100 rounded-lg"><Edit2 className="w-4 h-4" /></button>
        <button onClick={handleArchive} className="p-2 text-gray-400 hover:text-red-500 hover:bg-gray-100 rounded-lg"><Archive className="w-4 h-4" /></button>
      </div>

      {editing && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-4">
          <h3 className="text-lg font-semibold text-gray-900">Edit Details</h3>
          {error && <div className="p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">{error}</div>}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] focus:border-transparent" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Slug</label>
              <input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] focus:border-transparent" />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
              <input type="email" value={form.contactEmail} onChange={(e) => setForm({ ...form, contactEmail: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] focus:border-transparent" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
              <input value={form.contactPhone} onChange={(e) => setForm({ ...form, contactPhone: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] focus:border-transparent" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Website</label>
              <input value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] focus:border-transparent" />
            </div>
          </div>
          <div className="flex justify-end gap-3">
            <button onClick={() => setEditing(false)} className="px-4 py-2 text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
            <button onClick={handleSave} disabled={saving} className="px-4 py-2 bg-[#3c81c3] text-white rounded-lg hover:bg-[#2d6aa3] disabled:opacity-50 flex items-center gap-2">
              {saving && <Loader2 className="w-4 h-4 animate-spin" />} Save Changes
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
          <div className="text-sm text-gray-500 mb-1">Contact Email</div>
          <div className="flex items-center gap-2 text-gray-900"><Mail className="w-4 h-4 text-gray-400" />{org.contactEmail || "Not set"}</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
          <div className="text-sm text-gray-500 mb-1">Contact Phone</div>
          <div className="flex items-center gap-2 text-gray-900"><Phone className="w-4 h-4 text-gray-400" />{org.contactPhone || "Not set"}</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
          <div className="text-sm text-gray-500 mb-1">Website</div>
          <div className="flex items-center gap-2 text-gray-900"><Globe className="w-4 h-4 text-gray-400" />{org.website ? <a href={org.website} target="_blank" rel="noopener noreferrer" className="text-[#3c81c3] hover:underline">{org.website}</a> : "Not set"}</div>
        </div>
      </div>

      {childAccounts.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
            <h3 className="font-semibold text-gray-900 flex items-center gap-2"><Users className="w-4 h-4" /> Accounts ({childAccounts.length})</h3>
          </div>
          <div className="divide-y divide-gray-200">
            {childAccounts.map((acct) => (
              <div key={acct.id} className="px-4 py-3 flex items-center justify-between hover:bg-gray-50 cursor-pointer" onClick={() => router.push(`/platform-admin/crm/accounts/${acct.id}`)}>
                <div>
                  <div className="font-medium text-gray-900">{acct.name}</div>
                  <div className="text-xs text-gray-500">{acct.slug}</div>
                </div>
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${acct.status === "Active" ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-700"}`}>{acct.status}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
        <BrandingEditor entityType="parent_org" entityId={id} entityName={org.name} />
      </div>

      <div className="text-xs text-gray-400">
        Created: {new Date(org.createdAt).toLocaleString()}
      </div>
    </div>
  );
}
