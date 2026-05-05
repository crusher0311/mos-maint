"use client";

// Edit/add/delete per-shop DVI blurbs. Server canonicalizes the key via
// toKeyFromName so blurbs match the keys DVI plan matching looks up.

import { useState } from "react";
import { DVI_BEST_PRACTICE_MAX_CHARS } from "@/lib/dvi-best-practices";

interface Row {
  serviceKey: string;
  serviceName: string;
  blurb: string;
  updatedAt: string | null;
  updatedBy: string | null;
}

interface Template {
  serviceKey: string;
  serviceName: string;
  blurb: string;
}

interface Props {
  shopId: number;
  initialRows: Row[];
  suggestedTemplates: Template[];
}

type RowState = Row & {
  draft: string;
  saving: boolean;
  saved: boolean;
  deleting: boolean;
  error: string | null;
};

function formatTimestamp(iso: string | null): string | null {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return null;
  }
}

export default function DviBestPracticesEditor({ shopId, initialRows, suggestedTemplates }: Props) {
  const [rows, setRows] = useState<RowState[]>(
    initialRows.map((r) => ({
      ...r,
      draft: r.blurb,
      saving: false,
      saved: false,
      deleting: false,
      error: null,
    })),
  );
  const [templates, setTemplates] = useState<Template[]>(suggestedTemplates);
  const [adding, setAdding] = useState(false);
  const [newRow, setNewRow] = useState<{ serviceName: string; blurb: string }>({
    serviceName: "",
    blurb: "",
  });
  const [addError, setAddError] = useState<string | null>(null);

  const updateRow = (idx: number, patch: Partial<RowState>) => {
    setRows((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
  };

  async function save(idx: number) {
    const row = rows[idx];
    updateRow(idx, { saving: true, saved: false, error: null });
    try {
      const res = await fetch(
        `/api/admin/shops/${shopId}/dvi-best-practices`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            serviceKey: row.serviceKey,
            serviceName: row.serviceName,
            blurb: row.draft,
          }),
        },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || `Save failed (${res.status})`);
      updateRow(idx, {
        saving: false,
        saved: true,
        blurb: body.blurb ?? row.draft.trim().slice(0, DVI_BEST_PRACTICE_MAX_CHARS),
        updatedAt: body.updatedAt ?? new Date().toISOString(),
        updatedBy: body.updatedBy ?? null,
      });
      setTimeout(() => updateRow(idx, { saved: false }), 1500);
    } catch (err: any) {
      updateRow(idx, { saving: false, saved: false, error: err?.message || "Save failed" });
    }
  }

  async function remove(idx: number) {
    const row = rows[idx];
    if (!confirm(`Delete the blurb for "${row.serviceName}"?`)) return;
    updateRow(idx, { deleting: true, error: null });
    try {
      const res = await fetch(
        `/api/admin/shops/${shopId}/dvi-best-practices?serviceKey=${encodeURIComponent(row.serviceKey)}`,
        { method: "DELETE" },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || `Delete failed (${res.status})`);
      setRows((prev) => prev.filter((_, i) => i !== idx));
      setTemplates((prev) =>
        prev.some((t) => t.serviceKey === row.serviceKey)
          ? prev
          : [...prev, { serviceKey: row.serviceKey, serviceName: row.serviceName, blurb: row.blurb }]
              .sort((a, b) => a.serviceName.localeCompare(b.serviceName)),
      );
    } catch (err: any) {
      updateRow(idx, { deleting: false, error: err?.message || "Delete failed" });
    }
  }

  async function addRow(values: { serviceKey?: string; serviceName: string; blurb: string }) {
    const serviceName = values.serviceName.trim();
    const blurb = values.blurb.trim();
    if (!serviceName) {
      setAddError("Service name is required.");
      return;
    }
    if (!blurb) {
      setAddError("Blurb cannot be empty.");
      return;
    }
    setAddError(null);
    try {
      const res = await fetch(
        `/api/admin/shops/${shopId}/dvi-best-practices`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ serviceKey: values.serviceKey ?? "", serviceName, blurb }),
        },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || `Save failed (${res.status})`);
      const savedKey: string = body.serviceKey ?? values.serviceKey ?? "";
      if (!savedKey) throw new Error("Server did not return a serviceKey");
      if (rows.some((r) => r.serviceKey === savedKey)) {
        setAddError(`A blurb for "${savedKey}" already exists above — edit it instead.`);
        return;
      }
      setRows((prev) =>
        [
          ...prev,
          {
            serviceKey: savedKey,
            serviceName: body.serviceName ?? serviceName,
            blurb: body.blurb ?? blurb.slice(0, DVI_BEST_PRACTICE_MAX_CHARS),
            draft: body.blurb ?? blurb.slice(0, DVI_BEST_PRACTICE_MAX_CHARS),
            updatedAt: body.updatedAt ?? new Date().toISOString(),
            updatedBy: body.updatedBy ?? null,
            saving: false,
            saved: false,
            deleting: false,
            error: null,
          },
        ].sort((a, b) => a.serviceName.localeCompare(b.serviceName)),
      );
      setTemplates((prev) => prev.filter((t) => t.serviceKey !== savedKey));
      setNewRow({ serviceName: "", blurb: "" });
      setAdding(false);
    } catch (err: any) {
      setAddError(err?.message || "Save failed");
    }
  }

  const newRemaining = DVI_BEST_PRACTICE_MAX_CHARS - newRow.blurb.trim().length;
  const newOverLimit = newRemaining < 0;

  return (
    <div className="space-y-6">
      <div className="bg-white shadow sm:rounded-lg overflow-hidden">
        <ul className="divide-y divide-gray-200">
          {rows.length === 0 && (
            <li className="px-6 py-8 text-sm text-gray-500">
              No blurbs configured yet. Use &ldquo;Add custom blurb&rdquo;
              below or pick from the suggested library.
            </li>
          )}
          {rows.map((row, idx) => {
            const remaining = DVI_BEST_PRACTICE_MAX_CHARS - row.draft.trim().length;
            const overLimit = remaining < 0;
            const dirty = row.draft.trim() !== row.blurb.trim();
            const updatedLabel = formatTimestamp(row.updatedAt);
            return (
              <li key={row.serviceKey} className="px-6 py-5">
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <h3 className="text-sm font-semibold text-gray-900">
                      {row.serviceName}
                    </h3>
                    <p className="text-xs text-gray-500 mt-0.5">
                      serviceKey: <code className="font-mono">{row.serviceKey}</code>
                    </p>
                  </div>
                  <div className="text-right">
                    <span className={`text-xs ${overLimit ? "text-red-600 font-semibold" : "text-gray-500"}`}>
                      {Math.max(remaining, -999)} chars left
                    </span>
                    {updatedLabel && (
                      <p className="text-xs text-gray-400 mt-0.5">
                        Updated {updatedLabel}
                        {row.updatedBy ? ` by ${row.updatedBy}` : ""}
                      </p>
                    )}
                  </div>
                </div>
                <textarea
                  value={row.draft}
                  onChange={(e) => updateRow(idx, { draft: e.target.value, saved: false, error: null })}
                  rows={2}
                  maxLength={DVI_BEST_PRACTICE_MAX_CHARS + 50}
                  className={`w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mos-blue ${
                    overLimit ? "border-red-400" : "border-gray-300"
                  }`}
                />
                <div className="mt-2 flex items-center justify-between">
                  <div className="text-xs">
                    {row.error && <span className="text-red-600">{row.error}</span>}
                    {row.saved && <span className="text-green-600">Saved.</span>}
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => remove(idx)}
                      disabled={row.deleting || row.saving}
                      className="inline-flex items-center px-3 py-1.5 text-sm font-medium rounded-md text-red-700 bg-white border border-red-300 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {row.deleting ? "Deleting…" : "Delete"}
                    </button>
                    <button
                      type="button"
                      onClick={() => save(idx)}
                      disabled={row.saving || overLimit || !dirty}
                      className="inline-flex items-center px-3 py-1.5 border border-transparent text-sm font-medium rounded-md text-white bg-mos-blue hover:bg-mos-blue-dark focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-mos-blue disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {row.saving ? "Saving…" : dirty ? "Save" : "Saved"}
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="bg-white shadow sm:rounded-lg overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-900">Add custom blurb</h2>
          {!adding && (
            <button
              type="button"
              onClick={() => { setAdding(true); setAddError(null); }}
              className="inline-flex items-center px-3 py-1.5 border border-transparent text-sm font-medium rounded-md text-white bg-mos-blue hover:bg-mos-blue-dark"
            >
              + Add row
            </button>
          )}
        </div>
        {adding && (
          <div className="px-6 py-4 space-y-3">
            <label className="block">
              <span className="text-xs text-gray-600">Service name</span>
              <input
                type="text"
                value={newRow.serviceName}
                onChange={(e) => setNewRow((p) => ({ ...p, serviceName: e.target.value }))}
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mos-blue"
                placeholder="e.g. Serpentine Belt"
              />
              <span className="mt-1 block text-xs text-gray-400">
                The matching key is derived automatically so the blurb attaches to the right DVI finding.
              </span>
            </label>
            <div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-600">Blurb (≤ {DVI_BEST_PRACTICE_MAX_CHARS} chars)</span>
                <span className={`text-xs ${newOverLimit ? "text-red-600 font-semibold" : "text-gray-500"}`}>
                  {Math.max(newRemaining, -999)} chars left
                </span>
              </div>
              <textarea
                value={newRow.blurb}
                onChange={(e) => setNewRow((p) => ({ ...p, blurb: e.target.value }))}
                rows={2}
                maxLength={DVI_BEST_PRACTICE_MAX_CHARS + 50}
                className={`mt-1 w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mos-blue ${
                  newOverLimit ? "border-red-400" : "border-gray-300"
                }`}
              />
            </div>
            {addError && <p className="text-xs text-red-600">{addError}</p>}
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => { setAdding(false); setNewRow({ serviceName: "", blurb: "" }); setAddError(null); }}
                className="inline-flex items-center px-3 py-1.5 text-sm font-medium rounded-md text-gray-700 bg-white border border-gray-300 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => addRow({ serviceName: newRow.serviceName, blurb: newRow.blurb })}
                disabled={newOverLimit}
                className="inline-flex items-center px-3 py-1.5 border border-transparent text-sm font-medium rounded-md text-white bg-mos-blue hover:bg-mos-blue-dark disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Save blurb
              </button>
            </div>
          </div>
        )}
      </div>

      {templates.length > 0 && (
        <div className="bg-white shadow sm:rounded-lg overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200">
            <h2 className="text-sm font-semibold text-gray-900">Suggested starter library</h2>
            <p className="mt-1 text-xs text-gray-500">
              One-click templates for common services. Clicking adds the
              blurb to your shop — you can edit or delete it afterwards.
            </p>
          </div>
          <ul className="divide-y divide-gray-100">
            {templates.map((t) => (
              <li key={t.serviceKey} className="px-6 py-3 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900">{t.serviceName}</p>
                  <p className="text-xs text-gray-500 mt-0.5 truncate">{t.blurb}</p>
                </div>
                <button
                  type="button"
                  onClick={() => addRow({ serviceKey: t.serviceKey, serviceName: t.serviceName, blurb: t.blurb })}
                  className="shrink-0 inline-flex items-center px-3 py-1.5 text-sm font-medium rounded-md text-mos-blue bg-white border border-mos-blue hover:bg-mos-blue/5"
                >
                  + Add
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
