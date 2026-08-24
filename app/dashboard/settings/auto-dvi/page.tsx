"use client";

// Task #991 — Auto DVI: settings page for the shop's reusable custom
// inspection line items (name + optional group + optional notes). These are
// merged into every generated inspection; items already covered by an OE
// inspect or overdue/due-soon VHI item are automatically hidden at
// generation time.

import { useState, useEffect } from "react";
import { ClipboardCheck, Loader2, Check, Plus, Trash2, Pencil, X } from "lucide-react";

type AutoDviItem = {
  id: string;
  name: string;
  group: string | null;
  notes: string | null;
};

export default function AutoDviSettingsPage() {
  const [items, setItems] = useState<AutoDviItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [featureOff, setFeatureOff] = useState(false);

  // add/edit form state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formName, setFormName] = useState("");
  const [formGroup, setFormGroup] = useState("");
  const [formNotes, setFormNotes] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/settings/auto-dvi-items");
        if (res.status === 403) {
          const data = await res.json().catch(() => ({}));
          if (data?.code === "feature_disabled") {
            setFeatureOff(true);
            return;
          }
        }
        if (res.ok) {
          const data = await res.json();
          setItems(Array.isArray(data.items) ? data.items : []);
        } else {
          setError("Could not load inspection items");
        }
      } catch {
        setError("Could not load inspection items");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function persist(next: AutoDviItem[]) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/auto-dvi-items", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || "Save failed");
      }
      const data = await res.json();
      setItems(Array.isArray(data.items) ? data.items : next);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: any) {
      setError(err.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }

  function resetForm() {
    setEditingId(null);
    setFormName("");
    setFormGroup("");
    setFormNotes("");
  }

  function startEdit(item: AutoDviItem) {
    setEditingId(item.id);
    setFormName(item.name);
    setFormGroup(item.group || "");
    setFormNotes(item.notes || "");
  }

  async function submitForm() {
    const name = formName.trim();
    if (!name) return;
    const entry: AutoDviItem = {
      id: editingId || `item-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      group: formGroup.trim() || null,
      notes: formNotes.trim() || null,
    };
    const next = editingId
      ? items.map((i) => (i.id === editingId ? entry : i))
      : [...items, entry];
    await persist(next);
    resetForm();
  }

  async function removeItem(id: string) {
    await persist(items.filter((i) => i.id !== id));
    if (editingId === id) resetForm();
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-gray-500">
        <Loader2 className="w-6 h-6 animate-spin mr-2" /> Loading…
      </div>
    );
  }

  if (featureOff) {
    return (
      <div className="max-w-3xl mx-auto p-6">
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-8 text-center">
          <ClipboardCheck className="w-10 h-10 mx-auto text-gray-400 mb-3" />
          <h1 className="text-lg font-semibold text-gray-900 mb-1">Auto DVI is not enabled</h1>
          <p className="text-sm text-gray-600">
            Auto DVI is not enabled for this shop. Contact MOS to enable vehicle-specific
            inspection generation.
          </p>
        </div>
      </div>
    );
  }

  const groups = Array.from(new Set(items.map((i) => i.group || "Ungrouped")));

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <div className="flex items-center gap-3">
        <ClipboardCheck className="w-7 h-7 text-blue-600" />
        <div>
          <h1 className="text-xl font-bold text-gray-900">Auto DVI — Custom Inspection Items</h1>
          <p className="text-sm text-gray-600">
            Your shop&apos;s own inspection line items. They are merged into every generated
            inspection; items already covered by the vehicle&apos;s maintenance plan are hidden
            automatically (with the reason shown).
          </p>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">{error}</div>
      )}

      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5 space-y-3">
        <h2 className="font-semibold text-gray-900">{editingId ? "Edit item" : "Add item"}</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <input
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
            placeholder="Item name (e.g. Battery terminals)"
            value={formName}
            maxLength={120}
            onChange={(e) => setFormName(e.target.value)}
          />
          <input
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
            placeholder="Group (optional, e.g. Under Hood)"
            value={formGroup}
            maxLength={60}
            onChange={(e) => setFormGroup(e.target.value)}
          />
        </div>
        <textarea
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-full"
          placeholder="Notes for technicians (optional)"
          rows={2}
          maxLength={500}
          value={formNotes}
          onChange={(e) => setFormNotes(e.target.value)}
        />
        <div className="flex items-center gap-2">
          <button
            onClick={submitForm}
            disabled={saving || !formName.trim()}
            className="inline-flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg px-4 py-2"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : editingId ? <Pencil className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
            {editingId ? "Save changes" : "Add item"}
          </button>
          {editingId && (
            <button
              onClick={resetForm}
              className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900 px-3 py-2"
            >
              <X className="w-4 h-4" /> Cancel
            </button>
          )}
          {saved && (
            <span className="inline-flex items-center gap-1 text-sm text-green-600">
              <Check className="w-4 h-4" /> Saved
            </span>
          )}
        </div>
      </div>

      {items.length === 0 ? (
        <div className="text-sm text-gray-500 text-center py-8">
          No custom inspection items yet. Add your shop&apos;s standard checklist items above.
        </div>
      ) : (
        groups.map((group) => (
          <div key={group} className="bg-white rounded-xl shadow-sm border border-gray-200">
            <div className="px-5 py-3 border-b border-gray-100 font-semibold text-gray-700 text-sm">{group}</div>
            <ul className="divide-y divide-gray-100">
              {items
                .filter((i) => (i.group || "Ungrouped") === group)
                .map((item) => (
                  <li key={item.id} className="px-5 py-3 flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium text-gray-900">{item.name}</div>
                      {item.notes && <div className="text-xs text-gray-500 mt-0.5">{item.notes}</div>}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => startEdit(item)}
                        className="p-1.5 text-gray-400 hover:text-blue-600 rounded"
                        aria-label={`Edit ${item.name}`}
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => removeItem(item.id)}
                        disabled={saving}
                        className="p-1.5 text-gray-400 hover:text-red-600 rounded"
                        aria-label={`Remove ${item.name}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </li>
                ))}
            </ul>
          </div>
        ))
      )}
    </div>
  );
}
