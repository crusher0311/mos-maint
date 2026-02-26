"use client";

import { useState, useEffect, useMemo } from "react";
import { Save, Loader2, Search, Check, X, ArrowUpDown, Filter } from "lucide-react";

interface OEMItem {
  name: string;
  category: string;
}

interface Mapping {
  oemName: string;
  carfaxName: string;
  category?: string;
}

export default function ServiceMappingsPage() {
  const [oemNames, setOemNames] = useState<OEMItem[]>([]);
  const [carfaxNames, setCarfaxNames] = useState<string[]>([]);
  const [mappings, setMappings] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterMode, setFilterMode] = useState<"all" | "mapped" | "unmapped">("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [notification, setNotification] = useState<{ message: string; type: "success" | "error" } | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    if (notification) {
      const timer = setTimeout(() => setNotification(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [notification]);

  async function loadData() {
    setLoading(true);
    try {
      const [oemRes, carfaxRes, mappingsRes] = await Promise.all([
        fetch("/api/platform-admin/service-mappings/oem-names"),
        fetch("/api/platform-admin/service-mappings/carfax-names"),
        fetch("/api/platform-admin/service-mappings")
      ]);

      const oemData = await oemRes.json();
      const carfaxData = await carfaxRes.json();
      const mappingsData = await mappingsRes.json();

      if (oemData.ok) setOemNames(oemData.names || []);
      if (carfaxData.ok) setCarfaxNames(carfaxData.names || []);
      if (mappingsData.ok) {
        const map: Record<string, string> = {};
        for (const m of mappingsData.mappings || []) {
          map[m.oemName] = m.carfaxName;
        }
        setMappings(map);
      }
    } catch (err) {
      console.error("Error loading data:", err);
      setNotification({ message: "Failed to load data", type: "error" });
    } finally {
      setLoading(false);
    }
  }

  async function saveMapping(oemName: string, carfaxName: string) {
    setSaving(oemName);
    try {
      if (!carfaxName) {
        const res = await fetch("/api/platform-admin/service-mappings", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ oemName })
        });
        const data = await res.json();
        if (data.ok) {
          setMappings(prev => {
            const next = { ...prev };
            delete next[oemName];
            return next;
          });
          setNotification({ message: `Mapping removed for "${oemName}"`, type: "success" });
        }
      } else {
        const res = await fetch("/api/platform-admin/service-mappings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ oemName, carfaxName })
        });
        const data = await res.json();
        if (data.ok) {
          setMappings(prev => ({ ...prev, [oemName]: carfaxName }));
          setNotification({ message: `Mapped "${oemName}" → "${carfaxName}"`, type: "success" });
        }
      }
    } catch (err) {
      console.error("Error saving mapping:", err);
      setNotification({ message: "Failed to save mapping", type: "error" });
    } finally {
      setSaving(null);
    }
  }

  const categories = useMemo(() => {
    const cats = new Set(oemNames.map(n => n.category));
    return Array.from(cats).sort();
  }, [oemNames]);

  const filteredItems = useMemo(() => {
    return oemNames.filter(item => {
      if (searchTerm && !item.name.toLowerCase().includes(searchTerm.toLowerCase())) return false;
      if (categoryFilter !== "all" && item.category !== categoryFilter) return false;
      if (filterMode === "mapped" && !mappings[item.name]) return false;
      if (filterMode === "unmapped" && mappings[item.name]) return false;
      return true;
    });
  }, [oemNames, searchTerm, categoryFilter, filterMode, mappings]);

  const mappedCount = oemNames.filter(n => mappings[n.name]).length;
  const totalCount = oemNames.length;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
        <span className="ml-3 text-gray-600">Loading service data...</span>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {notification && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-lg shadow-lg text-white text-sm ${
          notification.type === "success" ? "bg-green-600" : "bg-red-600"
        }`}>
          {notification.message}
        </div>
      )}

      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">OEM → CARFAX Service Mappings</h1>
        <p className="mt-1 text-sm text-gray-500">
          Link OEM maintenance item names to their CARFAX service equivalents. 
          This allows the plan to accurately match CARFAX service history against OEM recommendations.
        </p>
        <div className="mt-2 flex items-center gap-4">
          <span className="text-sm font-medium text-gray-700">
            {mappedCount} of {totalCount} mapped
          </span>
          <div className="flex-1 max-w-xs bg-gray-200 rounded-full h-2">
            <div 
              className="bg-blue-500 h-2 rounded-full transition-all" 
              style={{ width: `${totalCount > 0 ? (mappedCount / totalCount) * 100 : 0}%` }}
            />
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
        <div className="p-4 border-b border-gray-200 space-y-3">
          <div className="flex items-center gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search OEM service names..."
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
            <select
              value={categoryFilter}
              onChange={e => setCategoryFilter(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
            >
              <option value="all">All Categories</option>
              {categories.map(cat => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>
            <div className="flex items-center border border-gray-300 rounded-lg overflow-hidden">
              {(["all", "unmapped", "mapped"] as const).map(mode => (
                <button
                  key={mode}
                  onClick={() => setFilterMode(mode)}
                  className={`px-3 py-2 text-sm capitalize ${
                    filterMode === mode
                      ? "bg-blue-500 text-white"
                      : "bg-white text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>
          <div className="text-xs text-gray-500">
            Showing {filteredItems.length} of {totalCount} items
          </div>
        </div>

        <div className="divide-y divide-gray-100 max-h-[calc(100vh-320px)] overflow-y-auto">
          {filteredItems.map(item => (
            <MappingRow
              key={item.name}
              oemItem={item}
              carfaxNames={carfaxNames}
              currentMapping={mappings[item.name] || ""}
              saving={saving === item.name}
              onSave={(carfaxName) => saveMapping(item.name, carfaxName)}
            />
          ))}
          {filteredItems.length === 0 && (
            <div className="p-8 text-center text-gray-500 text-sm">
              No items match your filters
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MappingRow({ 
  oemItem, 
  carfaxNames, 
  currentMapping, 
  saving, 
  onSave 
}: { 
  oemItem: OEMItem;
  carfaxNames: string[];
  currentMapping: string;
  saving: boolean;
  onSave: (carfaxName: string) => void;
}) {
  const [value, setValue] = useState(currentMapping);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const hasChanged = value !== currentMapping;

  useEffect(() => {
    setValue(currentMapping);
  }, [currentMapping]);

  const filtered = useMemo(() => {
    if (!value) return carfaxNames.slice(0, 20);
    const lower = value.toLowerCase();
    return carfaxNames.filter(n => n.toLowerCase().includes(lower)).slice(0, 20);
  }, [value, carfaxNames]);

  return (
    <div className="flex items-center gap-4 px-4 py-3 hover:bg-gray-50">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-gray-900 truncate">{oemItem.name}</div>
        <div className="text-xs text-gray-400">{oemItem.category}</div>
      </div>
      <div className="text-gray-400 text-sm">→</div>
      <div className="relative flex-1">
        <input
          type="text"
          placeholder="Type or select CARFAX name..."
          value={value}
          onChange={e => { setValue(e.target.value); setShowSuggestions(true); }}
          onFocus={() => setShowSuggestions(true)}
          onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
          className={`w-full px-3 py-1.5 border rounded-lg text-sm focus:ring-2 focus:ring-blue-500 ${
            currentMapping ? "border-green-300 bg-green-50" : "border-gray-300"
          }`}
        />
        {showSuggestions && filtered.length > 0 && (
          <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-10 max-h-48 overflow-y-auto">
            {filtered.map(name => (
              <button
                key={name}
                onMouseDown={(e) => { e.preventDefault(); setValue(name); setShowSuggestions(false); }}
                className="w-full text-left px-3 py-2 text-sm hover:bg-blue-50 hover:text-blue-700"
              >
                {name}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center gap-1 w-20">
        {hasChanged && (
          <>
            <button
              onClick={() => onSave(value)}
              disabled={saving}
              className="p-1.5 rounded-lg bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50"
              title="Save mapping"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            </button>
            <button
              onClick={() => setValue(currentMapping)}
              className="p-1.5 rounded-lg bg-gray-100 text-gray-500 hover:bg-gray-200"
              title="Cancel"
            >
              <X className="w-4 h-4" />
            </button>
          </>
        )}
        {!hasChanged && currentMapping && (
          <span className="text-xs text-green-600 font-medium">Mapped</span>
        )}
      </div>
    </div>
  );
}
