"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Edit2, Archive, Loader2, Phone } from "lucide-react";
import BrandingEditor from "@/components/crm/BrandingEditor";

interface Location {
  id: string;
  name: string;
  accountId: string;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
  phone: string | null;
  timezone: string | null;
  status: string;
  createdAt: string;
  archivedAt: string | null;
}

export default function LocationDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [location, setLocation] = useState<Location | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ name: "", address: "", city: "", state: "", zip: "", country: "", phone: "", timezone: "" });

  useEffect(() => { loadData(); }, [id]);

  const loadData = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/platform-admin/crm/locations/${id}`);
      const data = await res.json();
      if (data.ok && data.location) {
        setLocation(data.location);
        setForm({
          name: data.location.name,
          address: data.location.address || "",
          city: data.location.city || "",
          state: data.location.state || "",
          zip: data.location.zip || "",
          country: data.location.country || "",
          phone: data.location.phone || "",
          timezone: data.location.timezone || "",
        });
      }
    } catch (err) {
      console.error("Error loading location:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!form.name) { setError("Name is required"); return; }
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/platform-admin/crm/locations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || "Failed to save"); return; }
      setLocation(data.location);
      setEditing(false);
    } catch { setError("Network error"); } finally { setSaving(false); }
  };

  const handleArchive = async () => {
    if (!confirm("Archive this location?")) return;
    try {
      await fetch(`/api/platform-admin/crm/locations/${id}`, { method: "DELETE" });
      router.push("/platform-admin/crm/locations");
    } catch (err) { console.error(err); }
  };

  if (loading) {
    return <div className="flex justify-center py-24"><Loader2 className="w-8 h-8 animate-spin text-[#3c81c3]" /></div>;
  }

  if (!location) {
    return (
      <div className="p-6">
        <button onClick={() => router.push("/platform-admin/crm/locations")} className="flex items-center gap-2 text-[#3c81c3] hover:underline mb-4">
          <ArrowLeft className="w-4 h-4" /> Back to Locations
        </button>
        <p className="text-gray-500">Location not found.</p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div className="flex items-center gap-3">
        <button onClick={() => router.push("/platform-admin/crm/locations")} className="p-1.5 hover:bg-gray-100 rounded-lg">
          <ArrowLeft className="w-5 h-5 text-gray-500" />
        </button>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-gray-900">{location.name}</h1>
          <p className="text-sm text-gray-500">{[location.city, location.state].filter(Boolean).join(", ")}</p>
        </div>
        <span className={`px-2.5 py-1 rounded text-xs font-medium ${location.status === "Active" ? "bg-green-100 text-green-700" : location.status === "Inactive" ? "bg-yellow-100 text-yellow-700" : "bg-gray-100 text-gray-700"}`}>
          {location.status}
        </span>
        <button onClick={() => setEditing(!editing)} className="p-2 text-gray-400 hover:text-[#3c81c3] hover:bg-gray-100 rounded-lg"><Edit2 className="w-4 h-4" /></button>
        <button onClick={handleArchive} className="p-2 text-gray-400 hover:text-red-500 hover:bg-gray-100 rounded-lg"><Archive className="w-4 h-4" /></button>
      </div>

      {editing && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-4">
          <h3 className="text-lg font-semibold text-gray-900">Edit Location Details</h3>
          {error && <div className="p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">{error}</div>}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] focus:border-transparent" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Address</label>
            <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] focus:border-transparent" />
          </div>
          <div className="grid grid-cols-4 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">City</label>
              <input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] focus:border-transparent" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">State</label>
              <input value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] focus:border-transparent" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">ZIP</label>
              <input value={form.zip} onChange={(e) => setForm({ ...form, zip: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] focus:border-transparent" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Country</label>
              <input value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] focus:border-transparent" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
              <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] focus:border-transparent" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Timezone</label>
              <input value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} placeholder="America/New_York" className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] focus:border-transparent" />
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

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
          <div className="text-sm text-gray-500 mb-1">Full Address</div>
          <div className="text-gray-900">
            {location.address && <div>{location.address}</div>}
            <div>{[location.city, location.state, location.zip].filter(Boolean).join(", ")}</div>
            {location.country && <div>{location.country}</div>}
          </div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
          <div className="text-sm text-gray-500 mb-1">Contact & Timezone</div>
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-gray-900"><Phone className="w-4 h-4 text-gray-400" />{location.phone || "Not set"}</div>
            <div className="text-sm text-gray-600">{location.timezone || "No timezone set"}</div>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
        <BrandingEditor entityType="location" entityId={id} entityName={location.name} />
      </div>

      <div className="text-xs text-gray-400">
        Created: {new Date(location.createdAt).toLocaleString()}
      </div>
    </div>
  );
}
