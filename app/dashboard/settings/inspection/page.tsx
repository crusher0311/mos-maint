"use client";

import { useState, useEffect } from "react";
import { ClipboardCheck, Save, Loader2, Plus, Trash2, AlertCircle } from "lucide-react";

interface InspectionItem {
  id: string;
  name: string;
  category: string;
  triggerService: string;
  enabled: boolean;
}

const defaultCategories = [
  "Brakes",
  "Suspension",
  "Steering",
  "Tires",
  "Fluids",
  "Filters",
  "Belts & Hoses",
  "Electrical",
  "HVAC",
  "Body & Interior",
];

const defaultInspectionItems: InspectionItem[] = [
  { id: "1", name: "Brake Pads Low", category: "Brakes", triggerService: "Brake Pad Replacement", enabled: true },
  { id: "2", name: "Rotor Wear", category: "Brakes", triggerService: "Rotor Replacement", enabled: true },
  { id: "3", name: "Tire Tread Low", category: "Tires", triggerService: "Tire Replacement", enabled: true },
  { id: "4", name: "Air Filter Dirty", category: "Filters", triggerService: "Air Filter Replacement", enabled: true },
  { id: "5", name: "Cabin Filter Dirty", category: "Filters", triggerService: "Cabin Air Filter Replacement", enabled: true },
  { id: "6", name: "Battery Weak", category: "Electrical", triggerService: "Battery Replacement", enabled: true },
  { id: "7", name: "Wiper Blades Worn", category: "Body & Interior", triggerService: "Wiper Blade Replacement", enabled: true },
];

export default function InspectionSettingsPage() {
  const [items, setItems] = useState<InspectionItem[]>(defaultInspectionItems);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newItem, setNewItem] = useState({ name: "", category: "Brakes", triggerService: "" });

  useEffect(() => {
    fetchSettings();
  }, []);

  async function fetchSettings() {
    try {
      const res = await fetch("/api/settings/inspection");
      if (res.ok) {
        const data = await res.json();
        if (data.items?.length) {
          setItems(data.items);
        }
      }
    } catch (err) {
      console.error("Failed to fetch inspection settings:", err);
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      await fetch("/api/settings/inspection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
    } catch (err) {
      console.error("Failed to save inspection settings:", err);
    } finally {
      setSaving(false);
    }
  }

  function toggleItem(id: string) {
    setItems(items.map(item => 
      item.id === id ? { ...item, enabled: !item.enabled } : item
    ));
  }

  function removeItem(id: string) {
    setItems(items.filter(item => item.id !== id));
  }

  function addItem() {
    if (!newItem.name || !newItem.triggerService) return;
    const item: InspectionItem = {
      id: Date.now().toString(),
      ...newItem,
      enabled: true,
    };
    setItems([...items, item]);
    setNewItem({ name: "", category: "Brakes", triggerService: "" });
    setShowAddForm(false);
  }

  const groupedItems = items.reduce((acc, item) => {
    if (!acc[item.category]) acc[item.category] = [];
    acc[item.category].push(item);
    return acc;
  }, {} as Record<string, InspectionItem[]>);

  if (loading) {
    return (
      <div className="flex-1 p-8">
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 p-8 overflow-auto">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-100 rounded-lg">
              <ClipboardCheck className="w-6 h-6 text-blue-600" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Inspection Maintenance</h1>
              <p className="text-sm text-gray-500">Map DVI findings to service recommendations</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowAddForm(true)}
              className="inline-flex items-center gap-2 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
            >
              <Plus className="w-4 h-4" />
              Add Mapping
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save Changes
            </button>
          </div>
        </div>

        <div className="bg-blue-50 rounded-xl p-4 border border-blue-100">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-blue-800">
              When these inspection findings are detected in a DVI report, the corresponding service will automatically appear in the vehicle's maintenance recommendations.
            </p>
          </div>
        </div>

        {showAddForm && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Add New Mapping</h3>
            <div className="grid gap-4 md:grid-cols-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Finding Name</label>
                <input
                  type="text"
                  value={newItem.name}
                  onChange={(e) => setNewItem({ ...newItem, name: e.target.value })}
                  placeholder="e.g., Brake Pads Low"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
                <select
                  value={newItem.category}
                  onChange={(e) => setNewItem({ ...newItem, category: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  {defaultCategories.map(cat => (
                    <option key={cat} value={cat}>{cat}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Trigger Service</label>
                <input
                  type="text"
                  value={newItem.triggerService}
                  onChange={(e) => setNewItem({ ...newItem, triggerService: e.target.value })}
                  placeholder="e.g., Brake Pad Replacement"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-4">
              <button
                onClick={() => setShowAddForm(false)}
                className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={addItem}
                disabled={!newItem.name || !newItem.triggerService}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                Add Mapping
              </button>
            </div>
          </div>
        )}

        {Object.entries(groupedItems).map(([category, categoryItems]) => (
          <div key={category} className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200 bg-gray-50">
              <h2 className="text-lg font-semibold text-gray-900">{category}</h2>
            </div>
            <div className="divide-y divide-gray-200">
              {categoryItems.map((item) => (
                <div key={item.id} className="px-6 py-4 flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <button
                      onClick={() => toggleItem(item.id)}
                      className={`w-10 h-6 rounded-full transition-colors ${
                        item.enabled ? "bg-blue-600" : "bg-gray-300"
                      }`}
                    >
                      <div className={`w-4 h-4 rounded-full bg-white shadow transform transition-transform ${
                        item.enabled ? "translate-x-5" : "translate-x-1"
                      }`} />
                    </button>
                    <div>
                      <p className="font-medium text-gray-900">{item.name}</p>
                      <p className="text-sm text-gray-500">Triggers: {item.triggerService}</p>
                    </div>
                  </div>
                  <button
                    onClick={() => removeItem(item.id)}
                    className="p-2 text-gray-400 hover:text-red-600 transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
