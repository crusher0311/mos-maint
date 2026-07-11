"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FileUp, Upload, AlertTriangle, Check, X, Loader2, Sparkles } from "lucide-react";
import type { ShopInterval } from "./page";

type Proposal = {
  key: string;
  serviceName: string;
  sourceNames: string[];
  miles: number | null;
  months: number | null;
  confidence: "high" | "medium" | "low";
  flags: string[];
  oneTime: boolean;
  appearedAt: number[];
};

type Flagged = {
  name: string;
  reason: "unmatched" | "inspect_only" | "not_adjustable" | "implausible";
  detail: string;
  appearedAt: number[];
};

type ReviewRow = {
  proposal: Proposal;
  accepted: boolean;
  miles: string;   // display units, editable
  months: string;  // editable
};

type Props = {
  intervals: ShopInterval[];
  distanceUnit: "miles" | "kilometers";
  applyMode: "always" | "shop_only";
  saveAction: (formData: FormData) => Promise<void>;
};

const MILES_TO_KM = 1.60934;

function milesToDisplay(miles: number | null, unit: "miles" | "kilometers"): number | null {
  if (miles == null) return null;
  return unit === "kilometers" ? Math.round(miles * MILES_TO_KM) : miles;
}

const REASON_LABELS: Record<Flagged["reason"], string> = {
  unmatched: "Not recognized",
  inspect_only: "Inspect-only",
  not_adjustable: "Not adjustable here",
  implausible: "Implausible value",
};

export default function ImportFromDocument({ intervals, distanceUnit, applyMode, saveAction }: Props) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<"idle" | "uploading" | "review" | "applying" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [flagged, setFlagged] = useState<Flagged[]>([]);
  const [fileName, setFileName] = useState<string>("");

  const currentByKey = new Map(intervals.map((i) => [i.key, i]));
  const distanceAbbr = distanceUnit === "kilometers" ? "km" : "mi";

  const handleFile = async (file: File) => {
    setError(null);
    setPhase("uploading");
    setFileName(file.name);
    try {
      const fd = new FormData();
      fd.append("document", file);
      const res = await fetch("/api/dashboard/settings/interval-import", { method: "POST", body: fd });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        setError(data?.error || "Import failed. Nothing was changed.");
        setPhase("idle");
        return;
      }
      const proposals: Proposal[] = data.proposals || [];
      setRows(
        proposals.map((p) => ({
          proposal: p,
          accepted: !p.oneTime && p.confidence !== "low",
          miles: milesToDisplay(p.miles, distanceUnit)?.toString() ?? "",
          months: p.months?.toString() ?? "",
        })),
      );
      setFlagged(data.flagged || []);
      setPhase("review");
    } catch {
      setError("Upload failed. Please try again.");
      setPhase("idle");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const applySelected = async () => {
    setError(null);
    setPhase("applying");
    try {
      const accepted = new Map<string, { miles: string; months: string }>();
      for (const row of rows) {
        if (row.accepted) accepted.set(row.proposal.key, { miles: row.miles, months: row.months });
      }

      // Build the exact same FormData the manual form submits, merging the
      // accepted proposals over the currently saved values for every service.
      const fd = new FormData();
      fd.append("distanceUnit", distanceUnit);
      fd.append("intervalApplyMode", applyMode);
      for (const svc of intervals) {
        const imp = accepted.get(svc.key);
        if (imp) {
          fd.append(`${svc.key}_useShop`, "on");
          // Accepting an import un-excludes the service.
          if (imp.miles.trim()) fd.append(`${svc.key}_distance`, imp.miles.trim());
          if (imp.months.trim()) fd.append(`${svc.key}_months`, imp.months.trim());
        } else {
          if (svc.useShop) fd.append(`${svc.key}_useShop`, "on");
          if (svc.excluded) fd.append(`${svc.key}_excluded`, "on");
          const dist = milesToDisplay(svc.miles, distanceUnit);
          if (dist != null) fd.append(`${svc.key}_distance`, String(dist));
          if (svc.months != null) fd.append(`${svc.key}_months`, String(svc.months));
        }
      }
      await saveAction(fd);
      setPhase("done");
      router.refresh();
      setTimeout(() => setPhase("idle"), 3000);
    } catch {
      setError("Applying the intervals failed. Your settings were not changed — please try again.");
      setPhase("review");
    }
  };

  const acceptedCount = rows.filter((r) => r.accepted).length;

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
        <h2 className="font-semibold text-gray-900 flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-purple-500" />
          Import from document
        </h2>
        {phase === "review" && (
          <button
            type="button"
            onClick={() => {
              setPhase("idle");
              setRows([]);
              setFlagged([]);
            }}
            className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1"
          >
            <X className="w-4 h-4" /> Cancel import
          </button>
        )}
      </div>

      {(phase === "idle" || phase === "uploading" || phase === "done") && (
        <div className="p-6">
          <p className="text-sm text-gray-600 mb-4">
            Upload your shop&apos;s maintenance guide (.docx, .pdf, or a photo/scan) and AI will read it,
            work out the recurring intervals, and pre-fill them for your review. Nothing changes until you apply.
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".docx,.pdf,.png,.jpg,.jpeg,.webp,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
            }}
          />
          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={phase === "uploading"}
              onClick={() => fileInputRef.current?.click()}
              className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors font-medium flex items-center gap-2 disabled:opacity-50"
            >
              {phase === "uploading" ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Reading {fileName}…
                </>
              ) : (
                <>
                  <FileUp className="w-4 h-4" />
                  Upload maintenance guide
                </>
              )}
            </button>
            {phase === "done" && (
              <span className="text-sm text-green-700 flex items-center gap-1">
                <Check className="w-4 h-4" /> Intervals applied and saved.
              </span>
            )}
          </div>
          {error && (
            <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>
      )}

      {(phase === "review" || phase === "applying") && (
        <div className="p-6 space-y-5">
          <p className="text-sm text-gray-600">
            AI matched <strong>{rows.length}</strong> service{rows.length === 1 ? "" : "s"} from{" "}
            <strong>{fileName}</strong>. Review each proposed interval below — edit or uncheck anything,
            then apply. Only checked rows are saved.
          </p>

          <div className="overflow-x-auto border border-gray-200 rounded-lg">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-3 py-2 text-center text-xs font-medium text-gray-500 uppercase w-14">Apply</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Service</th>
                  <th className="px-3 py-2 text-center text-xs font-medium text-gray-500 uppercase w-28">
                    Proposed {distanceAbbr}
                  </th>
                  <th className="px-3 py-2 text-center text-xs font-medium text-gray-500 uppercase w-24">Months</th>
                  <th className="px-3 py-2 text-center text-xs font-medium text-gray-500 uppercase w-32">Current</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((row, idx) => {
                  const cur = currentByKey.get(row.proposal.key);
                  const curDist = cur ? milesToDisplay(cur.miles, distanceUnit) : null;
                  const warn = row.proposal.oneTime || row.proposal.confidence === "low";
                  return (
                    <tr key={row.proposal.key} className={row.accepted ? "bg-green-50/50" : "bg-gray-50/50"}>
                      <td className="px-3 py-2 text-center align-top">
                        <input
                          type="checkbox"
                          checked={row.accepted}
                          onChange={(e) =>
                            setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, accepted: e.target.checked } : r)))
                          }
                          className="w-5 h-5 rounded border-gray-300 text-green-600 focus:ring-green-500 mt-1"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <div className={`font-medium ${row.accepted ? "text-gray-900" : "text-gray-400"}`}>
                          {row.proposal.serviceName}
                        </div>
                        <div className="text-xs text-gray-500 mt-0.5">
                          From: {row.proposal.sourceNames.join(", ")} · seen at{" "}
                          {row.proposal.appearedAt.map((m) => `${Math.round(m / 1000)}k`).join(", ")}
                        </div>
                        {(warn || row.proposal.flags.length > 0) && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {row.proposal.flags.map((f, i) => (
                              <span
                                key={i}
                                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] bg-amber-50 text-amber-800 border border-amber-200"
                              >
                                <AlertTriangle className="w-3 h-3" />
                                {f}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 align-top">
                        <input
                          type="number"
                          value={row.miles}
                          min={0}
                          disabled={!row.accepted}
                          onChange={(e) =>
                            setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, miles: e.target.value } : r)))
                          }
                          className={`w-full px-2 py-1.5 border rounded-lg text-center ${
                            row.accepted
                              ? "border-gray-300 bg-white focus:ring-2 focus:ring-green-500"
                              : "border-gray-200 bg-gray-100 text-gray-400"
                          }`}
                        />
                      </td>
                      <td className="px-3 py-2 align-top">
                        <input
                          type="number"
                          value={row.months}
                          min={0}
                          disabled={!row.accepted}
                          onChange={(e) =>
                            setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, months: e.target.value } : r)))
                          }
                          className={`w-full px-2 py-1.5 border rounded-lg text-center ${
                            row.accepted
                              ? "border-gray-300 bg-white focus:ring-2 focus:ring-green-500"
                              : "border-gray-200 bg-gray-100 text-gray-400"
                          }`}
                        />
                      </td>
                      <td className="px-3 py-2 text-center align-top text-xs text-gray-600">
                        {cur?.excluded ? (
                          <span className="text-red-600">Excluded</span>
                        ) : cur?.useShop ? (
                          <>
                            {curDist != null ? `${curDist.toLocaleString()} ${distanceAbbr}` : "—"}
                            {" / "}
                            {cur?.months != null ? `${cur.months} mo` : "—"}
                          </>
                        ) : (
                          <span className="text-gray-400">OEM default</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {flagged.length > 0 && (
            <div className="border border-amber-200 bg-amber-50 rounded-lg p-4">
              <p className="text-sm font-medium text-amber-800 flex items-center gap-2 mb-2">
                <AlertTriangle className="w-4 h-4" />
                Needs your attention — these items were NOT turned into intervals
              </p>
              <ul className="space-y-1">
                {flagged.map((f, i) => (
                  <li key={i} className="text-xs text-amber-800">
                    <span className="font-medium">{f.name}</span>{" "}
                    <span className="text-amber-600">
                      ({REASON_LABELS[f.reason]}, seen at {f.appearedAt.map((m) => `${Math.round(m / 1000)}k`).join(", ")})
                    </span>{" "}
                    — {f.detail}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex items-center justify-end gap-3">
            <span className="text-sm text-gray-500">
              {acceptedCount} of {rows.length} selected
            </span>
            <button
              type="button"
              disabled={phase === "applying" || acceptedCount === 0}
              onClick={applySelected}
              className="px-5 py-2.5 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-medium flex items-center gap-2 disabled:opacity-50"
            >
              {phase === "applying" ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Applying…
                </>
              ) : (
                <>
                  <Upload className="w-4 h-4" />
                  Apply {acceptedCount} interval{acceptedCount === 1 ? "" : "s"}
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
