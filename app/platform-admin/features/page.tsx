"use client";

import { useState, useEffect } from "react";
import { 
  Package, 
  Plus, 
  Edit2, 
  Trash2, 
  GripVertical, 
  Save, 
  X, 
  Loader2,
  Check,
  AlertCircle,
  Wrench,
  Search,
  Tag,
  Calendar,
  RefreshCw,
  Droplet,
  AlertTriangle,
  Database,
  MessageSquare,
  FileText,
  Chrome,
  DollarSign
} from "lucide-react";

interface PlatformFeature {
  _id: string;
  order: number;
  name: string;
  slug: string;
  description: string;
  category: "core" | "addon" | "bundled";
  status: "active" | "inactive";
  icon: string;
  compatibleSMS: string[];
  includedInTiers: string[];
  stripeProductId?: string;
  stripePriceId?: string;
  pricePerMonth?: number;
  requiresFeature?: string;
  bundledWith?: string;
  bundledFeatures?: string[];
}

const ICON_MAP: Record<string, any> = {
  Package, Wrench, Search, Tag, Calendar, RefreshCw, Droplet, AlertTriangle, Database, MessageSquare, FileText, Chrome, DollarSign
};

const SMS_OPTIONS = [
  { value: "stand-alone", label: "Stand Alone" },
  { value: "tekmetric", label: "Tekmetric" },
  { value: "protractor", label: "Protractor" },
  { value: "autoflow", label: "AutoFlow" },
  { value: "shopware", label: "Shop-Ware" },
  { value: "shopmonkey", label: "Shop Monkey" }
];

const TIER_OPTIONS = [
  { value: "starter", label: "Starter" },
  { value: "plus", label: "Plus" },
  { value: "elite", label: "Elite" },
  { value: "enterprise", label: "Enterprise" }
];

const ICON_OPTIONS = [
  "Package", "Wrench", "Search", "Tag", "Calendar", "RefreshCw", "Droplet", "AlertTriangle", "Database", "MessageSquare", "FileText", "Chrome", "DollarSign"
];

export default function FeaturesManagementPage() {
  const [features, setFeatures] = useState<PlatformFeature[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [editingFeature, setEditingFeature] = useState<PlatformFeature | null>(null);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);

  const [formData, setFormData] = useState({
    name: "",
    slug: "",
    description: "",
    category: "core" as "core" | "addon" | "bundled",
    status: "active" as "active" | "inactive",
    icon: "Package",
    compatibleSMS: [] as string[],
    includedInTiers: [] as string[],
    stripeProductId: "",
    stripePriceId: "",
    pricePerMonth: "",
    requiresFeature: "",
    bundledWith: ""
  });

  useEffect(() => {
    loadFeatures();
    checkSuperAdmin();
  }, []);

  const checkSuperAdmin = async () => {
    try {
      const res = await fetch("/api/user/profile");
      const data = await res.json();
      if (data.ok) {
        const superAdmins = ["brandoncrusha@gmail.com", "brandoncrusha+1@gmail.com"];
        setIsSuperAdmin(superAdmins.includes(data.user.email));
      }
    } catch (err) {
      console.error("Error checking super admin:", err);
    }
  };

  const loadFeatures = async () => {
    try {
      const res = await fetch("/api/platform-admin/features");
      const data = await res.json();
      if (data.ok) {
        setFeatures(data.features);
      }
    } catch (err) {
      console.error("Error loading features:", err);
    } finally {
      setLoading(false);
    }
  };

  const seedFeatures = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/platform-admin/features/seed", { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        setMessage({ type: "success", text: data.message });
        loadFeatures();
      } else {
        setMessage({ type: "error", text: data.error });
      }
    } catch (err) {
      setMessage({ type: "error", text: "Failed to seed features" });
    } finally {
      setSaving(false);
    }
  };

  const openModal = (feature?: PlatformFeature) => {
    if (feature) {
      setEditingFeature(feature);
      setFormData({
        name: feature.name,
        slug: feature.slug,
        description: feature.description,
        category: feature.category,
        status: feature.status,
        icon: feature.icon,
        compatibleSMS: feature.compatibleSMS,
        includedInTiers: feature.includedInTiers,
        stripeProductId: feature.stripeProductId || "",
        stripePriceId: feature.stripePriceId || "",
        pricePerMonth: feature.pricePerMonth?.toString() || "",
        requiresFeature: feature.requiresFeature || "",
        bundledWith: feature.bundledWith || ""
      });
    } else {
      setEditingFeature(null);
      setFormData({
        name: "",
        slug: "",
        description: "",
        category: "core",
        status: "active",
        icon: "Package",
        compatibleSMS: [],
        includedInTiers: [],
        stripeProductId: "",
        stripePriceId: "",
        pricePerMonth: "",
        requiresFeature: "",
        bundledWith: ""
      });
    }
    setShowModal(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);

    try {
      const payload = {
        ...formData,
        pricePerMonth: formData.pricePerMonth ? parseFloat(formData.pricePerMonth) : undefined,
        ...(editingFeature ? { id: editingFeature._id } : {})
      };

      const res = await fetch("/api/platform-admin/features", {
        method: editingFeature ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (data.ok) {
        setMessage({ type: "success", text: editingFeature ? "Feature updated!" : "Feature created!" });
        setShowModal(false);
        loadFeatures();
      } else {
        setMessage({ type: "error", text: data.error });
      }
    } catch (err) {
      setMessage({ type: "error", text: "Failed to save feature" });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (feature: PlatformFeature) => {
    if (!confirm(`Are you sure you want to delete "${feature.name}"?`)) return;

    try {
      const res = await fetch(`/api/platform-admin/features?id=${feature._id}`, { method: "DELETE" });
      const data = await res.json();
      if (data.ok) {
        setMessage({ type: "success", text: "Feature deleted!" });
        loadFeatures();
      } else {
        setMessage({ type: "error", text: data.error });
      }
    } catch (err) {
      setMessage({ type: "error", text: "Failed to delete feature" });
    }
  };

  const handleDragStart = (index: number) => {
    setDraggedIndex(index);
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === index) return;

    const newFeatures = [...features];
    const draggedItem = newFeatures[draggedIndex];
    newFeatures.splice(draggedIndex, 1);
    newFeatures.splice(index, 0, draggedItem);
    setFeatures(newFeatures);
    setDraggedIndex(index);
  };

  const handleDragEnd = async () => {
    setDraggedIndex(null);
    
    const orderedIds = features.map(f => f._id);
    try {
      await fetch("/api/platform-admin/features/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderedIds })
      });
    } catch (err) {
      console.error("Error saving order:", err);
    }
  };

  const toggleArrayValue = (field: "compatibleSMS" | "includedInTiers", value: string) => {
    setFormData(prev => ({
      ...prev,
      [field]: prev[field].includes(value)
        ? prev[field].filter(v => v !== value)
        : [...prev[field], value]
    }));
  };

  const getIconComponent = (iconName: string) => {
    const IconComponent = ICON_MAP[iconName] || Package;
    return <IconComponent className="w-4 h-4" />;
  };

  if (loading) {
    return (
      <div className="p-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-1/4"></div>
          <div className="h-64 bg-gray-200 rounded-lg"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Features Management</h1>
          <p className="text-gray-600">Manage platform features. Drag and drop to reorder how features appear to customers.</p>
        </div>
        <div className="flex gap-2">
          {features.length === 0 && (
            <button
              onClick={seedFeatures}
              disabled={saving}
              className="px-4 py-2 bg-[rgba(60,129,195,0.75)] text-white rounded-lg hover:bg-[#3c81c3] disabled:opacity-50 flex items-center gap-2"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Database className="w-4 h-4" />}
              Seed Default Features
            </button>
          )}
          <button
            onClick={() => openModal()}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            Create Feature
          </button>
        </div>
      </div>

      {message && (
        <div className={`px-4 py-3 rounded-lg text-sm flex items-center gap-2 ${
          message.type === "success" 
            ? "bg-green-50 text-green-700 border border-green-200" 
            : "bg-red-50 text-red-700 border border-red-200"
        }`}>
          {message.type === "success" ? <Check className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
          {message.text}
          <button onClick={() => setMessage(null)} className="ml-auto">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50 border-b border-gray-100">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Order</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Name</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Slug</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Description</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Category</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Status</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Compatible SMS</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Actions</th>
            </tr>
          </thead>
          <tbody>
            {features.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-gray-500">
                  <Package className="w-12 h-12 mx-auto mb-4 opacity-50" />
                  <p className="font-medium">No features configured</p>
                  <p className="text-sm">Click "Seed Default Features" to add the standard feature set, or create features manually.</p>
                </td>
              </tr>
            ) : (
              features.map((feature, index) => (
                <tr
                  key={feature._id}
                  draggable
                  onDragStart={() => handleDragStart(index)}
                  onDragOver={(e) => handleDragOver(e, index)}
                  onDragEnd={handleDragEnd}
                  className={`border-b border-gray-100 hover:bg-gray-50 cursor-move ${
                    draggedIndex === index ? "bg-blue-50" : ""
                  }`}
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 text-gray-400">
                      <GripVertical className="w-4 h-4" />
                      <span className="text-gray-600">{feature.order}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {getIconComponent(feature.icon)}
                      <span className="font-medium text-gray-900">{feature.name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500 font-mono">{feature.slug}</td>
                  <td className="px-4 py-3 text-sm text-gray-500 max-w-xs truncate">{feature.description}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-1 text-xs font-medium rounded ${
                      feature.category === "core" 
                        ? "bg-blue-100 text-blue-700" 
                        : feature.category === "bundled"
                        ? "bg-amber-100 text-amber-700"
                        : "bg-gray-100 text-gray-700"
                    }`}>
                      {feature.category === "core" ? "Core" : feature.category === "bundled" ? "Bundled" : "Add-on"}
                    </span>
                    {feature.requiresFeature && (
                      <span className="ml-1 text-xs text-gray-500">→ {feature.requiresFeature}</span>
                    )}
                    {feature.bundledWith && (
                      <span className="ml-1 text-xs text-gray-500">⊂ {feature.bundledWith}</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-1 text-xs font-medium rounded ${
                      feature.status === "active" 
                        ? "bg-green-100 text-green-700" 
                        : "bg-red-100 text-red-700"
                    }`}>
                      {feature.status}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {feature.compatibleSMS.length === 0 ? (
                        <span className="text-xs text-gray-400">None</span>
                      ) : (
                        feature.compatibleSMS.map(sms => (
                          <span key={sms} className="px-2 py-0.5 text-xs bg-[rgba(60,129,195,0.15)] text-[#3c81c3] rounded">
                            {sms}
                          </span>
                        ))
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => openModal(feature)}
                        className="text-blue-600 hover:text-blue-500"
                      >
                        Edit
                      </button>
                      {isSuperAdmin && (
                        <button
                          onClick={() => handleDelete(feature)}
                          className="text-red-600 hover:text-red-500"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-auto">
            <div className="p-4 border-b border-gray-200 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-gray-900">
                {editingFeature ? "Edit Feature" : "Create Feature"}
              </h2>
              <button onClick={() => setShowModal(false)} className="p-2 hover:bg-gray-100 rounded-lg">
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Name *</label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Slug *</label>
                  <input
                    type="text"
                    value={formData.slug}
                    onChange={(e) => setFormData({ ...formData, slug: e.target.value.toLowerCase().replace(/\s+/g, "_") })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg font-mono"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  rows={2}
                />
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
                  <select
                    value={formData.category}
                    onChange={(e) => setFormData({ ...formData, category: e.target.value as "core" | "addon" | "bundled" })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  >
                    <option value="core">Core (Purchasable)</option>
                    <option value="addon">Add-on (Requires Feature)</option>
                    <option value="bundled">Bundled (Included With)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
                  <select
                    value={formData.status}
                    onChange={(e) => setFormData({ ...formData, status: e.target.value as "active" | "inactive" })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  >
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Icon</label>
                  <select
                    value={formData.icon}
                    onChange={(e) => setFormData({ ...formData, icon: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  >
                    {ICON_OPTIONS.map(icon => (
                      <option key={icon} value={icon}>{icon}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Compatible SMS Integrations</label>
                <div className="flex flex-wrap gap-2">
                  {SMS_OPTIONS.map(sms => (
                    <button
                      key={sms.value}
                      type="button"
                      onClick={() => toggleArrayValue("compatibleSMS", sms.value)}
                      className={`px-3 py-1.5 text-sm rounded-lg border ${
                        formData.compatibleSMS.includes(sms.value)
                          ? "bg-[rgba(60,129,195,0.75)] text-white border-[#3c81c3]"
                          : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
                      }`}
                    >
                      {sms.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Included in Tiers</label>
                <div className="flex flex-wrap gap-2">
                  {TIER_OPTIONS.map(tier => (
                    <button
                      key={tier.value}
                      type="button"
                      onClick={() => toggleArrayValue("includedInTiers", tier.value)}
                      className={`px-3 py-1.5 text-sm rounded-lg border ${
                        formData.includedInTiers.includes(tier.value)
                          ? "bg-blue-600 text-white border-blue-600"
                          : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
                      }`}
                    >
                      {tier.label}
                    </button>
                  ))}
                </div>
              </div>

              {formData.category === "addon" && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Requires Feature (slug)</label>
                  <input
                    type="text"
                    value={formData.requiresFeature}
                    onChange={(e) => setFormData({ ...formData, requiresFeature: e.target.value })}
                    placeholder="e.g., oil_sticker"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  />
                  <p className="text-xs text-gray-500 mt-1">This add-on is only available when the specified feature is active</p>
                </div>
              )}

              {formData.category === "bundled" && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Bundled With (slug)</label>
                  <input
                    type="text"
                    value={formData.bundledWith}
                    onChange={(e) => setFormData({ ...formData, bundledWith: e.target.value })}
                    placeholder="e.g., maintenance"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  />
                  <p className="text-xs text-gray-500 mt-1">This feature is automatically included when the specified feature is purchased</p>
                </div>
              )}

              <div className="grid grid-cols-3 gap-4 pt-4 border-t border-gray-200">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Stripe Product ID</label>
                  <input
                    type="text"
                    value={formData.stripeProductId}
                    onChange={(e) => setFormData({ ...formData, stripeProductId: e.target.value })}
                    placeholder="prod_..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg font-mono text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Stripe Price ID</label>
                  <input
                    type="text"
                    value={formData.stripePriceId}
                    onChange={(e) => setFormData({ ...formData, stripePriceId: e.target.value })}
                    placeholder="price_..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg font-mono text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Price/Month ($)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={formData.pricePerMonth}
                    onChange={(e) => setFormData({ ...formData, pricePerMonth: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-3 pt-4">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving || !formData.name || !formData.slug}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
                >
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  {editingFeature ? "Update Feature" : "Create Feature"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
