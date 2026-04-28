"use client";

import { useEffect, useState } from "react";
import { Loader2, Plus, Save, Trash2, AlertTriangle, ShieldCheck, Wrench } from "lucide-react";

interface EngineRiskOverrideMatch {
  make?: string | null;
  model?: string | null;
  yearMin?: number | null;
  yearMax?: number | null;
  engineNamePattern?: string | null;
  engineSize?: number | null;
  induction?: string | null;
  aspiration?: string | null;
  cylindersMax?: number | null;
}

interface EngineRiskOverride {
  _id?: string;
  label: string;
  reason: string;
  action: "flag" | "clear";
  match: EngineRiskOverrideMatch;
  createdAt?: string;
  updatedAt?: string;
}

const EMPTY_FORM: EngineRiskOverride = {
  label: "",
  reason: "",
  action: "flag",
  match: {
    make: "",
    model: "",
    yearMin: null,
    yearMax: null,
    engineNamePattern: "",
    engineSize: null,
    induction: "",
    aspiration: "",
    cylindersMax: null,
  },
};

export default function EngineRiskOverridesPage() {
  const [items, setItems] = useState<EngineRiskOverride[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<EngineRiskOverride>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ type: "success" | "error"; message: string } | null>(null);

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (notice) {
      const t = setTimeout(() => setNotice(null), 3500);
      return () => clearTimeout(t);
    }
  }, [notice]);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/platform-admin/engine-risk-overrides");
      const data = await res.json();
      if (data.ok) setItems(data.overrides ?? []);
    } catch (err) {
      setNotice({ type: "error", message: "Failed to load overrides" });
    } finally {
      setLoading(false);
    }
  }

  function startEdit(o: EngineRiskOverride) {
    setEditingId(o._id ?? null);
    setForm({ ...o, match: { ...EMPTY_FORM.match, ...o.match } });
  }

  function resetForm() {
    setEditingId(null);
    setForm(EMPTY_FORM);
  }

  async function save() {
    if (!form.label.trim() || !form.reason.trim()) {
      setNotice({ type: "error", message: "Label and reason are required." });
      return;
    }
    setSaving(true);
    try {
      const payload: any = { ...form };
      if (editingId) payload._id = editingId;
      const res = await fetch("/api/platform-admin/engine-risk-overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.ok) {
        setNotice({ type: "success", message: editingId ? "Override updated." : "Override created." });
        resetForm();
        await load();
      } else {
        setNotice({ type: "error", message: data.error ?? "Save failed" });
      }
    } catch (err: any) {
      setNotice({ type: "error", message: err?.message ?? "Save failed" });
    } finally {
      setSaving(false);
    }
  }

  async function remove(id?: string) {
    if (!id) return;
    if (!confirm("Delete this engine-risk override?")) return;
    try {
      const res = await fetch("/api/platform-admin/engine-risk-overrides", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ _id: id }),
      });
      const data = await res.json();
      if (data.ok) {
        if (editingId === id) resetForm();
        setNotice({ type: "success", message: "Override deleted." });
        await load();
      } else {
        setNotice({ type: "error", message: data.error ?? "Delete failed" });
      }
    } catch (err: any) {
      setNotice({ type: "error", message: err?.message ?? "Delete failed" });
    }
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center gap-3 mb-2">
        <Wrench className="w-6 h-6 text-slate-600" />
        <h1 className="text-2xl font-semibold text-slate-900">Engine Risk Overrides</h1>
      </div>
      <p className="text-sm text-slate-600 mb-6 max-w-3xl">
        Force engines to be flagged or cleared in the engine-aware oil interval
        classifier. Match fields combine with AND semantics; string fields are
        case-insensitive partial matches. Overrides take precedence over the
        curated baseline rules.
      </p>

      {notice && (
        <div
          className={`mb-4 px-4 py-2 rounded text-sm ${
            notice.type === "success"
              ? "bg-emerald-50 text-emerald-800 border border-emerald-200"
              : "bg-red-50 text-red-800 border border-red-200"
          }`}
        >
          {notice.message}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="bg-white border border-slate-200 rounded-lg p-5 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900 mb-3">
            {editingId ? "Edit override" : "Create override"}
          </h2>

          <div className="space-y-3">
            <Field label="Label">
              <input
                value={form.label}
                onChange={(e) => setForm({ ...form, label: e.target.value })}
                placeholder="e.g. Subaru turbo boxer"
                className="w-full border rounded px-2 py-1.5 text-sm"
              />
            </Field>
            <Field label="Reason">
              <textarea
                value={form.reason}
                onChange={(e) => setForm({ ...form, reason: e.target.value })}
                placeholder="Shown to shops when this override fires."
                rows={2}
                className="w-full border rounded px-2 py-1.5 text-sm"
              />
            </Field>
            <Field label="Action">
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setForm({ ...form, action: "flag" })}
                  className={`px-3 py-1.5 rounded text-sm border flex items-center gap-1 ${
                    form.action === "flag"
                      ? "bg-amber-50 border-amber-300 text-amber-800"
                      : "bg-white border-slate-300 text-slate-700"
                  }`}
                >
                  <AlertTriangle className="w-4 h-4" /> Flag
                </button>
                <button
                  type="button"
                  onClick={() => setForm({ ...form, action: "clear" })}
                  className={`px-3 py-1.5 rounded text-sm border flex items-center gap-1 ${
                    form.action === "clear"
                      ? "bg-emerald-50 border-emerald-300 text-emerald-800"
                      : "bg-white border-slate-300 text-slate-700"
                  }`}
                >
                  <ShieldCheck className="w-4 h-4" /> Clear
                </button>
              </div>
            </Field>

            <h3 className="text-sm font-semibold text-slate-700 pt-2 border-t mt-3">Match</h3>
            <div className="grid grid-cols-2 gap-2">
              <MatchInput label="Make" value={form.match.make ?? ""} onChange={(v) => setMatch("make", v)} />
              <MatchInput label="Model" value={form.match.model ?? ""} onChange={(v) => setMatch("model", v)} />
              <MatchInput
                label="Year ≥"
                type="number"
                value={form.match.yearMin ?? ""}
                onChange={(v) => setMatchNum("yearMin", v)}
              />
              <MatchInput
                label="Year ≤"
                type="number"
                value={form.match.yearMax ?? ""}
                onChange={(v) => setMatchNum("yearMax", v)}
              />
              <MatchInput
                label="Engine name contains"
                value={form.match.engineNamePattern ?? ""}
                onChange={(v) => setMatch("engineNamePattern", v)}
              />
              <MatchInput
                label="Engine size (L)"
                type="number"
                value={form.match.engineSize ?? ""}
                onChange={(v) => setMatchNum("engineSize", v)}
              />
              <MatchInput
                label="Induction contains"
                value={form.match.induction ?? ""}
                onChange={(v) => setMatch("induction", v)}
                placeholder="e.g. GDI"
              />
              <MatchInput
                label="Aspiration contains"
                value={form.match.aspiration ?? ""}
                onChange={(v) => setMatch("aspiration", v)}
                placeholder="e.g. Turbo"
              />
              <MatchInput
                label="Cylinders ≤"
                type="number"
                value={form.match.cylindersMax ?? ""}
                onChange={(v) => setMatchNum("cylindersMax", v)}
              />
            </div>

            <div className="flex gap-2 pt-3 border-t mt-3">
              <button
                type="button"
                onClick={save}
                disabled={saving}
                className="bg-slate-900 text-white px-4 py-2 rounded text-sm flex items-center gap-2 disabled:opacity-50"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                {editingId ? "Update" : "Create"}
              </button>
              {editingId && (
                <button
                  type="button"
                  onClick={resetForm}
                  className="bg-white border border-slate-300 text-slate-700 px-4 py-2 rounded text-sm flex items-center gap-2"
                >
                  <Plus className="w-4 h-4" /> New
                </button>
              )}
            </div>
          </div>
        </section>

        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold text-slate-900">
              Existing overrides ({items.length})
            </h2>
          </div>
          {loading ? (
            <div className="flex items-center gap-2 text-slate-500 text-sm">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          ) : items.length === 0 ? (
            <div className="text-sm text-slate-500 italic border border-dashed border-slate-300 rounded p-6 text-center">
              No overrides yet. The classifier is running on the curated baseline only.
            </div>
          ) : (
            <ul className="space-y-3">
              {items.map((o) => (
                <li
                  key={o._id}
                  className="bg-white border border-slate-200 rounded-lg p-3 shadow-sm flex items-start justify-between gap-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span
                        className={`text-xs px-2 py-0.5 rounded ${
                          o.action === "flag"
                            ? "bg-amber-100 text-amber-800"
                            : "bg-emerald-100 text-emerald-800"
                        }`}
                      >
                        {o.action.toUpperCase()}
                      </span>
                      <span className="font-medium text-slate-900 truncate">{o.label}</span>
                    </div>
                    <div className="text-xs text-slate-600 mb-2">{o.reason}</div>
                    <div className="text-xs text-slate-500 flex flex-wrap gap-x-3 gap-y-0.5">
                      {o.match.make && <span>make: {o.match.make}</span>}
                      {o.match.model && <span>model: {o.match.model}</span>}
                      {(o.match.yearMin || o.match.yearMax) && (
                        <span>
                          year: {o.match.yearMin ?? "*"}–{o.match.yearMax ?? "*"}
                        </span>
                      )}
                      {o.match.engineNamePattern && <span>engine: {o.match.engineNamePattern}</span>}
                      {o.match.engineSize != null && <span>{o.match.engineSize} L</span>}
                      {o.match.induction && <span>induction: {o.match.induction}</span>}
                      {o.match.aspiration && <span>aspiration: {o.match.aspiration}</span>}
                      {o.match.cylindersMax != null && <span>cyls ≤ {o.match.cylindersMax}</span>}
                    </div>
                  </div>
                  <div className="flex flex-col gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => startEdit(o)}
                      className="text-xs px-2 py-1 rounded border border-slate-300 hover:bg-slate-50"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(o._id)}
                      className="text-xs px-2 py-1 rounded border border-red-300 text-red-700 hover:bg-red-50 flex items-center gap-1"
                    >
                      <Trash2 className="w-3 h-3" /> Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );

  function setMatch<K extends keyof EngineRiskOverrideMatch>(key: K, value: string) {
    setForm({
      ...form,
      match: { ...form.match, [key]: value === "" ? null : value },
    });
  }

  function setMatchNum<K extends keyof EngineRiskOverrideMatch>(key: K, value: string) {
    const n = value === "" ? null : Number(value);
    setForm({
      ...form,
      match: {
        ...form.match,
        [key]: typeof n === "number" && Number.isFinite(n) ? n : null,
      },
    });
  }
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-slate-600 mb-1">{label}</span>
      {children}
    </label>
  );
}

function MatchInput({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  label: string;
  value: string | number;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="block text-[11px] font-medium text-slate-600 mb-1">{label}</span>
      <input
        type={type}
        value={value as any}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full border rounded px-2 py-1 text-sm"
      />
    </label>
  );
}
