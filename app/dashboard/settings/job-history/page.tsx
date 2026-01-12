"use client";

import { useState, useEffect } from "react";
import { History, GripVertical, Building, Loader2, Check, ToggleLeft, ToggleRight, Filter } from "lucide-react";
import Link from "next/link";

interface Shop {
  shopId: number;
  name: string;
  location?: string;
}

interface JobHistoryPreferences {
  enabled: boolean;
  priorityShopIds: number[];
  excludeOthers: boolean;
}

export default function JobHistoryPreferencesPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [allShops, setAllShops] = useState<Shop[]>([]);
  const [preferences, setPreferences] = useState<JobHistoryPreferences>({
    enabled: false,
    priorityShopIds: [],
    excludeOthers: false,
  });
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [hasMultipleShops, setHasMultipleShops] = useState(false);

  useEffect(() => {
    fetchData();
  }, []);

  async function fetchData() {
    try {
      const [shopsRes, prefsRes] = await Promise.all([
        fetch("/api/shops/list"),
        fetch("/api/user/preferences"),
      ]);

      if (shopsRes.ok) {
        const shopsData = await shopsRes.json();
        const shops = (shopsData.shops || []).map((s: any) => ({
          shopId: Number(s.shopId),
          name: s.name,
          location: s.location,
        }));
        setAllShops(shops);
        setHasMultipleShops(shops.length > 1);
      }

      if (prefsRes.ok) {
        const prefsData = await prefsRes.json();
        if (prefsData.preferences?.jobHistory) {
          setPreferences(prefsData.preferences.jobHistory);
        }
      }
    } catch (err) {
      console.error("Failed to fetch data:", err);
    } finally {
      setLoading(false);
    }
  }

  async function savePreferences(newPrefs: JobHistoryPreferences) {
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch("/api/user/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobHistory: newPrefs }),
      });

      if (res.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      } else {
        const data = await res.json();
        alert(data.error || "Failed to save preferences");
      }
    } catch (err) {
      console.error("Failed to save:", err);
      alert("Failed to save preferences");
    } finally {
      setSaving(false);
    }
  }

  function toggleEnabled() {
    const newPrefs = { ...preferences, enabled: !preferences.enabled };
    setPreferences(newPrefs);
    savePreferences(newPrefs);
  }

  function toggleExcludeOthers() {
    const newPrefs = { ...preferences, excludeOthers: !preferences.excludeOthers };
    setPreferences(newPrefs);
    savePreferences(newPrefs);
  }

  function toggleShopInList(shopId: number) {
    const currentList = preferences.priorityShopIds;
    let newList: number[];
    
    if (currentList.includes(shopId)) {
      newList = currentList.filter(id => id !== shopId);
    } else {
      newList = [...currentList, shopId];
    }
    
    const newPrefs = { ...preferences, priorityShopIds: newList };
    setPreferences(newPrefs);
    savePreferences(newPrefs);
  }

  function handleDragStart(index: number) {
    setDraggedIndex(index);
  }

  function handleDragOver(e: React.DragEvent, index: number) {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === index) return;

    const newList = [...preferences.priorityShopIds];
    const draggedItem = newList[draggedIndex];
    newList.splice(draggedIndex, 1);
    newList.splice(index, 0, draggedItem);
    
    setPreferences(prev => ({ ...prev, priorityShopIds: newList }));
    setDraggedIndex(index);
  }

  function handleDragEnd() {
    if (draggedIndex !== null) {
      savePreferences(preferences);
    }
    setDraggedIndex(null);
  }

  const selectedShops = preferences.priorityShopIds
    .map(id => allShops.find(s => s.shopId === id))
    .filter(Boolean) as Shop[];
  
  const unselectedShops = allShops.filter(
    s => !preferences.priorityShopIds.includes(s.shopId)
  );

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (!hasMultipleShops) {
    return (
      <div className="min-h-screen bg-gray-50 p-6">
        <div className="max-w-2xl mx-auto">
          <div className="flex items-center gap-3 mb-6">
            <Link href="/dashboard/settings/preferences" className="text-gray-500 hover:text-gray-700">
              Settings
            </Link>
            <span className="text-gray-400">/</span>
            <h1 className="text-2xl font-bold text-gray-900">Job History Preferences</h1>
          </div>
          
          <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
            <Building className="w-12 h-12 text-gray-300 mx-auto mb-4" />
            <h2 className="text-lg font-semibold text-gray-700 mb-2">Single Location</h2>
            <p className="text-gray-500">
              Location priority settings are only available for users with access to multiple shop locations.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <Link href="/dashboard/settings/preferences" className="text-gray-500 hover:text-gray-700">
            Settings
          </Link>
          <span className="text-gray-400">/</span>
          <div className="flex items-center gap-2">
            <History className="w-6 h-6 text-blue-600" />
            <h1 className="text-2xl font-bold text-gray-900">Job History Preferences</h1>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Location Priority</h2>
              <p className="text-sm text-gray-500">
                Control which locations appear first when searching job history
              </p>
            </div>
            <button
              onClick={toggleEnabled}
              className="flex items-center gap-2"
              disabled={saving}
            >
              {preferences.enabled ? (
                <ToggleRight className="w-10 h-6 text-blue-600" />
              ) : (
                <ToggleLeft className="w-10 h-6 text-gray-400" />
              )}
            </button>
          </div>

          {saving && (
            <div className="flex items-center gap-2 text-sm text-gray-500 mb-4">
              <Loader2 className="w-4 h-4 animate-spin" />
              Saving...
            </div>
          )}
          
          {saved && (
            <div className="flex items-center gap-2 text-sm text-green-600 mb-4">
              <Check className="w-4 h-4" />
              Saved
            </div>
          )}
        </div>

        {preferences.enabled && (
          <>
            <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Filter className="w-5 h-5 text-gray-500" />
                  <span className="font-medium text-gray-900">Only show selected locations</span>
                </div>
                <button
                  onClick={toggleExcludeOthers}
                  className="flex items-center gap-2"
                  disabled={saving}
                >
                  {preferences.excludeOthers ? (
                    <ToggleRight className="w-10 h-6 text-blue-600" />
                  ) : (
                    <ToggleLeft className="w-10 h-6 text-gray-400" />
                  )}
                </button>
              </div>
              <p className="text-sm text-gray-500">
                {preferences.excludeOthers 
                  ? "Results will only show jobs from your selected locations"
                  : "All locations will appear, but selected ones will be prioritized"
                }
              </p>
            </div>

            <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
              <h3 className="font-semibold text-gray-900 mb-4">
                Priority Order
                <span className="font-normal text-sm text-gray-500 ml-2">
                  (drag to reorder)
                </span>
              </h3>

              {selectedShops.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  <Building className="w-8 h-8 mx-auto mb-2 text-gray-300" />
                  <p>No locations selected. Add locations from the list below.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {selectedShops.map((shop, index) => (
                    <div
                      key={shop.shopId}
                      draggable
                      onDragStart={() => handleDragStart(index)}
                      onDragOver={(e) => handleDragOver(e, index)}
                      onDragEnd={handleDragEnd}
                      className={`flex items-center gap-3 p-3 rounded-lg border transition-colors cursor-move ${
                        draggedIndex === index 
                          ? "border-blue-400 bg-blue-50" 
                          : "border-gray-200 bg-gray-50 hover:border-gray-300"
                      }`}
                    >
                      <GripVertical className="w-5 h-5 text-gray-400" />
                      <div className="w-6 h-6 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center font-bold">
                        {index + 1}
                      </div>
                      <div className="flex-1">
                        <div className="font-medium text-gray-900">{shop.name}</div>
                        {shop.location && (
                          <div className="text-sm text-gray-500">{shop.location}</div>
                        )}
                      </div>
                      <button
                        onClick={() => toggleShopInList(shop.shopId)}
                        className="text-red-500 hover:text-red-700 text-sm"
                        disabled={saving}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {unselectedShops.length > 0 && (
              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <h3 className="font-semibold text-gray-900 mb-4">Available Locations</h3>
                <div className="space-y-2">
                  {unselectedShops.map(shop => (
                    <div
                      key={shop.shopId}
                      className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 hover:border-gray-300 transition-colors"
                    >
                      <Building className="w-5 h-5 text-gray-400" />
                      <div className="flex-1">
                        <div className="font-medium text-gray-900">{shop.name}</div>
                        {shop.location && (
                          <div className="text-sm text-gray-500">{shop.location}</div>
                        )}
                      </div>
                      <button
                        onClick={() => toggleShopInList(shop.shopId)}
                        className="text-blue-600 hover:text-blue-700 text-sm font-medium"
                        disabled={saving}
                      >
                        Add
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
