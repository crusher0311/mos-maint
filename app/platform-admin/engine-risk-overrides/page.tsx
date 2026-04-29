"use client";

import { useEffect, useRef, useState } from "react";
import {
  Loader2,
  Plus,
  Save,
  Trash2,
  AlertTriangle,
  ShieldCheck,
  Wrench,
  Download,
  Upload,
  X,
} from "lucide-react";

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

interface DiffChange {
  field: string;
  from: unknown;
  to: unknown;
}

interface DiffEntry {
  status: "add" | "update" | "remove" | "unchanged" | "error";
  rowNumber?: number;
  _id?: string;
  label: string;
  current?: EngineRiskOverride;
  next?: EngineRiskOverride;
  changes?: DiffChange[];
  errors?: string[];
}

interface DiffSummary {
  total: number;
  add: number;
  update: number;
  remove: number;
  unchanged: number;
  errors: number;
}

interface DiffPayload {
  entries: DiffEntry[];
  summary: DiffSummary;
}

interface DestructiveEvaluation {
  destructive: boolean;
  removed: number;
  currentTotal: number;
  fractionRemoved: number;
  fractionThreshold: number;
  floor: number;
  reason?: string;
}

interface ImportHistoryEntry {
  _id: string;
  adminEmail: string | null;
  fileName: string | null;
  csvByteSize: number;
  counts: {
    inserted: number;
    updated: number;
    removed: number;
    unchanged: number;
  };
  createdAt: string;
}

const IMPORT_HISTORY_LIMIT = 20;

export default function EngineRiskOverridesPage() {
  const [items, setItems] = useState<EngineRiskOverride[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<EngineRiskOverride>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [pendingCsv, setPendingCsv] = useState<string | null>(null);
  const [pendingDiff, setPendingDiff] = useState<DiffPayload | null>(null);
  const [pendingFileName, setPendingFileName] = useState<string | null>(null);
  const [pendingDestructive, setPendingDestructive] =
    useState<DestructiveEvaluation | null>(null);
  const [confirmDestructive, setConfirmDestructive] = useState(false);
  const [imports, setImports] = useState<ImportHistoryEntry[]>([]);
  const [importsLoading, setImportsLoading] = useState(true);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void load();
    void loadImports();
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

  async function loadImports() {
    setImportsLoading(true);
    try {
      const res = await fetch(
        `/api/platform-admin/engine-risk-overrides/imports?limit=${IMPORT_HISTORY_LIMIT}`,
      );
      const data = await res.json();
      if (data.ok) setImports((data.imports ?? []) as ImportHistoryEntry[]);
    } catch (err) {
      // Non-fatal — the override editor still works without history.
    } finally {
      setImportsLoading(false);
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

  function exportCsv() {
    window.location.href = "/api/platform-admin/engine-risk-overrides/export";
  }

  function pickImportFile() {
    fileInputRef.current?.click();
  }

  async function onFileChosen(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setImporting(true);
    try {
      const text = await file.text();
      const res = await fetch("/api/platform-admin/engine-risk-overrides/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv: text, apply: false }),
      });
      const data = await res.json();
      if (!data.ok) {
        setNotice({ type: "error", message: data.error ?? "Import preview failed" });
        return;
      }
      setPendingCsv(text);
      setPendingDiff(data.diff as DiffPayload);
      setPendingFileName(file.name);
      setPendingDestructive(
        (data.destructive as DestructiveEvaluation | undefined) ?? null,
      );
      setConfirmDestructive(false);
    } catch (err: any) {
      setNotice({ type: "error", message: err?.message ?? "Failed to read file" });
    } finally {
      setImporting(false);
    }
  }

  function cancelImport() {
    setPendingCsv(null);
    setPendingDiff(null);
    setPendingFileName(null);
    setPendingDestructive(null);
    setConfirmDestructive(false);
  }

  async function applyImport() {
    if (!pendingCsv || !pendingDiff) return;
    if (pendingDiff.summary.errors > 0) {
      setNotice({ type: "error", message: "Fix validation errors before applying." });
      return;
    }
    if (pendingDestructive?.destructive && !confirmDestructive) {
      setNotice({
        type: "error",
        message:
          "This import would delete a large chunk of overrides. Tick the confirmation checkbox to proceed.",
      });
      return;
    }
    setApplying(true);
    try {
      const res = await fetch("/api/platform-admin/engine-risk-overrides/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          csv: pendingCsv,
          apply: true,
          confirmDestructive: pendingDestructive?.destructive
            ? confirmDestructive
            : undefined,
          fileName: pendingFileName,
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        setNotice({ type: "error", message: data.error ?? "Import failed" });
        return;
      }
      const r = data.result ?? {};
      setNotice({
        type: "success",
        message: `Imported: +${r.inserted ?? 0} ~${r.updated ?? 0} −${r.removed ?? 0} (${r.unchanged ?? 0} unchanged).`,
      });
      cancelImport();
      await Promise.all([load(), loadImports()]);
    } catch (err: any) {
      setNotice({ type: "error", message: err?.message ?? "Import failed" });
    } finally {
      setApplying(false);
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
      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <Wrench className="w-6 h-6 text-slate-600" />
        <h1 className="text-2xl font-semibold text-slate-900">Engine Risk Overrides</h1>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={exportCsv}
            className="bg-white border border-slate-300 text-slate-700 px-3 py-1.5 rounded text-sm flex items-center gap-1 hover:bg-slate-50"
          >
            <Download className="w-4 h-4" /> Export CSV
          </button>
          <button
            type="button"
            onClick={pickImportFile}
            disabled={importing}
            className="bg-white border border-slate-300 text-slate-700 px-3 py-1.5 rounded text-sm flex items-center gap-1 hover:bg-slate-50 disabled:opacity-50"
          >
            {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            Import CSV
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={onFileChosen}
          />
        </div>
      </div>
      <p className="text-sm text-slate-600 mb-6 max-w-3xl">
        Force engines to be flagged or cleared in the engine-aware oil interval
        classifier. Match fields combine with AND semantics; string fields are
        case-insensitive partial matches. Overrides take precedence over the
        curated baseline rules. Use Export/Import CSV to bulk-edit in a
        spreadsheet — rows omitted from an imported file are removed, blank{" "}
        <code>_id</code> values create new overrides, and an{" "}
        <code>_id</code> that no longer exists in the database is treated as a
        new override (not an in-place replacement).
      </p>

      {pendingDiff && (
        <ImportDiffModal
          fileName={pendingFileName}
          diff={pendingDiff}
          destructive={pendingDestructive}
          confirmDestructive={confirmDestructive}
          onConfirmDestructiveChange={setConfirmDestructive}
          applying={applying}
          onCancel={cancelImport}
          onConfirm={applyImport}
        />
      )}

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

      <ImportHistorySection
        loading={importsLoading}
        imports={imports}
        limit={IMPORT_HISTORY_LIMIT}
      />
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

function ImportDiffModal({
  fileName,
  diff,
  destructive,
  confirmDestructive,
  onConfirmDestructiveChange,
  applying,
  onCancel,
  onConfirm,
}: {
  fileName: string | null;
  diff: DiffPayload;
  destructive: DestructiveEvaluation | null;
  confirmDestructive: boolean;
  onConfirmDestructiveChange: (v: boolean) => void;
  applying: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { entries, summary } = diff;
  const blocked = summary.errors > 0;
  const hasChanges = summary.add + summary.update + summary.remove > 0;
  const isDestructive = !!destructive?.destructive;
  const destructivePending = isDestructive && !confirmDestructive;
  const destructivePct = destructive
    ? Math.round(destructive.fractionRemoved * 100)
    : 0;
  const thresholdPct = destructive
    ? Math.round(destructive.fractionThreshold * 100)
    : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[85vh] flex flex-col">
        <div className="flex items-start justify-between px-5 py-3 border-b">
          <div>
            <h3 className="text-base font-semibold text-slate-900">
              Review CSV import
            </h3>
            <div className="text-xs text-slate-500 mt-0.5">
              {fileName ?? "uploaded file"} — {summary.total} row
              {summary.total === 1 ? "" : "s"}
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="text-slate-400 hover:text-slate-700"
            aria-label="Cancel import"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 py-3 border-b flex flex-wrap gap-2 text-xs">
          <SummaryPill label="Add" count={summary.add} className="bg-emerald-100 text-emerald-800" />
          <SummaryPill label="Update" count={summary.update} className="bg-blue-100 text-blue-800" />
          <SummaryPill label="Remove" count={summary.remove} className="bg-red-100 text-red-800" />
          <SummaryPill label="Unchanged" count={summary.unchanged} className="bg-slate-100 text-slate-700" />
          <SummaryPill label="Errors" count={summary.errors} className="bg-amber-100 text-amber-800" />
        </div>

        <div className="overflow-y-auto px-5 py-3 flex-1">
          {entries.length === 0 ? (
            <div className="text-sm text-slate-500 italic">No rows.</div>
          ) : (
            <ul className="space-y-2">
              {entries.map((entry, idx) => (
                <DiffRow key={idx} entry={entry} />
              ))}
            </ul>
          )}
        </div>

        {isDestructive && destructive && (
          <div className="mx-5 mb-3 mt-1 border border-red-300 bg-red-50 rounded p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-red-700 mt-0.5 shrink-0" />
              <div className="text-xs text-red-900 space-y-1">
                <div className="font-semibold">
                  Heads up: this import will delete a large chunk of overrides.
                </div>
                <div>
                  It would remove <span className="font-mono">{destructive.removed}</span>{" "}
                  of <span className="font-mono">{destructive.currentTotal}</span>{" "}
                  current override(s) ({destructivePct}%), which is at or above the{" "}
                  {thresholdPct}% destructive-import threshold (floor:{" "}
                  {destructive.floor} row(s)). Double-check that the uploaded
                  spreadsheet is the full list and not a partial extract.
                </div>
              </div>
            </div>
            <label className="flex items-center gap-2 mt-2 text-xs text-red-900 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={confirmDestructive}
                onChange={(e) => onConfirmDestructiveChange(e.target.checked)}
                className="border-red-400"
                aria-label="Confirm destructive import"
              />
              <span>
                Yes, I reviewed the diff and want to delete{" "}
                {destructive.removed} override(s).
              </span>
            </label>
          </div>
        )}

        <div className="px-5 py-3 border-t flex items-center justify-end gap-2">
          {blocked && (
            <span className="text-xs text-amber-700 mr-auto">
              Fix the validation errors before applying.
            </span>
          )}
          {!blocked && destructivePending && (
            <span className="text-xs text-red-700 mr-auto">
              Confirm the destructive-import checkbox above to enable Apply.
            </span>
          )}
          {!hasChanges && !blocked && !destructivePending && (
            <span className="text-xs text-slate-500 mr-auto">
              No changes to apply.
            </span>
          )}
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 rounded border border-slate-300 text-sm text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={
              applying || blocked || !hasChanges || destructivePending
            }
            className={`px-3 py-1.5 rounded text-white text-sm flex items-center gap-1 disabled:opacity-50 ${
              isDestructive ? "bg-red-700 hover:bg-red-800" : "bg-slate-900"
            }`}
          >
            {applying && <Loader2 className="w-4 h-4 animate-spin" />}
            {isDestructive ? "Apply destructive changes" : "Apply changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SummaryPill({
  label,
  count,
  className,
}: {
  label: string;
  count: number;
  className: string;
}) {
  return (
    <span className={`px-2 py-0.5 rounded font-medium ${className}`}>
      {label}: {count}
    </span>
  );
}

function DiffRow({ entry }: { entry: DiffEntry }) {
  const tone =
    entry.status === "add"
      ? "border-emerald-200 bg-emerald-50"
      : entry.status === "update"
        ? "border-blue-200 bg-blue-50"
        : entry.status === "remove"
          ? "border-red-200 bg-red-50"
          : entry.status === "error"
            ? "border-amber-300 bg-amber-50"
            : "border-slate-200 bg-white";

  const badgeTone =
    entry.status === "add"
      ? "bg-emerald-200 text-emerald-900"
      : entry.status === "update"
        ? "bg-blue-200 text-blue-900"
        : entry.status === "remove"
          ? "bg-red-200 text-red-900"
          : entry.status === "error"
            ? "bg-amber-300 text-amber-900"
            : "bg-slate-200 text-slate-700";

  return (
    <li className={`border rounded p-3 text-xs ${tone}`}>
      <div className="flex items-center gap-2 mb-1">
        <span className={`px-2 py-0.5 rounded uppercase tracking-wide font-semibold ${badgeTone}`}>
          {entry.status}
        </span>
        <span className="font-medium text-slate-900 truncate">{entry.label}</span>
        {entry.rowNumber != null && (
          <span className="text-slate-500">row {entry.rowNumber}</span>
        )}
        {entry._id && <span className="text-slate-400 font-mono">{entry._id}</span>}
      </div>

      {entry.status === "error" && entry.errors && (
        <ul className="list-disc list-inside text-amber-800">
          {entry.errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}

      {entry.status === "update" && entry.changes && entry.changes.length > 0 && (
        <ul className="space-y-0.5 text-slate-700">
          {entry.changes.map((c, i) => (
            <li key={i} className="font-mono">
              <span className="text-slate-500">{c.field}:</span>{" "}
              <span className="line-through text-slate-500">{formatValue(c.from)}</span>{" "}
              →{" "}
              <span className="text-slate-900">{formatValue(c.to)}</span>
            </li>
          ))}
        </ul>
      )}

      {entry.status === "add" && entry.next && (
        <div className="text-slate-700">{summarizeOverride(entry.next)}</div>
      )}

      {entry.status === "remove" && entry.current && (
        <div className="text-slate-700">{summarizeOverride(entry.current)}</div>
      )}
    </li>
  );
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "∅";
  return String(v);
}

function summarizeOverride(o: EngineRiskOverride): string {
  const parts: string[] = [];
  parts.push(`${o.action}: ${o.reason}`);
  const m = o.match || {};
  const matchBits: string[] = [];
  if (m.make) matchBits.push(`make=${m.make}`);
  if (m.model) matchBits.push(`model=${m.model}`);
  if (m.yearMin != null || m.yearMax != null) {
    matchBits.push(`year=${m.yearMin ?? "*"}–${m.yearMax ?? "*"}`);
  }
  if (m.engineNamePattern) matchBits.push(`engine~${m.engineNamePattern}`);
  if (m.engineSize != null) matchBits.push(`${m.engineSize}L`);
  if (m.induction) matchBits.push(`induction~${m.induction}`);
  if (m.aspiration) matchBits.push(`aspiration~${m.aspiration}`);
  if (m.cylindersMax != null) matchBits.push(`cyl≤${m.cylindersMax}`);
  if (matchBits.length) parts.push(`match: ${matchBits.join(", ")}`);
  return parts.join(" · ");
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

function ImportHistorySection({
  loading,
  imports,
  limit,
}: {
  loading: boolean;
  imports: ImportHistoryEntry[];
  limit: number;
}) {
  return (
    <section className="mt-8">
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-lg font-semibold text-slate-900">
          Recent CSV imports
        </h2>
        <span className="text-xs text-slate-500">
          last {limit} apply events
        </span>
      </div>
      {loading ? (
        <div className="flex items-center gap-2 text-slate-500 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      ) : imports.length === 0 ? (
        <div className="text-sm text-slate-500 italic border border-dashed border-slate-300 rounded p-6 text-center">
          No CSV imports recorded yet. Audit entries appear here after the
          first successful Apply.
        </div>
      ) : (
        <div className="overflow-x-auto bg-white border border-slate-200 rounded-lg shadow-sm">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-3 py-2 font-medium">When</th>
                <th className="text-left px-3 py-2 font-medium">Admin</th>
                <th className="text-left px-3 py-2 font-medium">File</th>
                <th className="text-left px-3 py-2 font-medium">Changes</th>
                <th className="text-right px-3 py-2 font-medium">Original CSV</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {imports.map((imp) => (
                <tr key={imp._id} className="align-top">
                  <td className="px-3 py-2 text-slate-700 whitespace-nowrap">
                    <div>{formatTimestamp(imp.createdAt)}</div>
                    <div className="text-xs text-slate-400">
                      {formatRelative(imp.createdAt)}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-slate-700">
                    {imp.adminEmail ?? (
                      <span className="text-slate-400 italic">unknown</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-700">
                    <div className="font-mono text-xs break-all">
                      {imp.fileName ?? (
                        <span className="text-slate-400 italic font-sans">
                          (no file name)
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-slate-400">
                      {formatBytes(imp.csvByteSize)}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1 text-xs">
                      <CountPill
                        label="add"
                        count={imp.counts.inserted}
                        className="bg-emerald-100 text-emerald-800"
                      />
                      <CountPill
                        label="upd"
                        count={imp.counts.updated}
                        className="bg-blue-100 text-blue-800"
                      />
                      <CountPill
                        label="rm"
                        count={imp.counts.removed}
                        className="bg-red-100 text-red-800"
                      />
                      <CountPill
                        label="same"
                        count={imp.counts.unchanged}
                        className="bg-slate-100 text-slate-700"
                      />
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <a
                      href={`/api/platform-admin/engine-risk-overrides/imports/${imp._id}/csv`}
                      className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-slate-300 hover:bg-slate-50 text-slate-700"
                    >
                      <Download className="w-3 h-3" /> Download
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function CountPill({
  label,
  count,
  className,
}: {
  label: string;
  count: number;
  className: string;
}) {
  const muted = count === 0;
  return (
    <span
      className={`px-1.5 py-0.5 rounded font-medium ${
        muted ? "bg-slate-100 text-slate-400" : className
      }`}
    >
      {label} {count}
    </span>
  );
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diffMs = Date.now() - d.getTime();
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.round(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
