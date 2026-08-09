"use client";

// Dashboard Sales Coach (task #987): open estimates list + AI-generated
// sales script per estimate. Scripts are cached server-side per estimate
// version, so re-viewing costs nothing.
import { useCallback, useEffect, useState } from "react";
import {
  Megaphone,
  RefreshCw,
  ChevronLeft,
  Loader2,
  MessageSquareQuote,
  Copy,
  Check,
} from "lucide-react";

interface OpenEstimate {
  workOrderId: string;
  workOrderNumber: string | null;
  status: string;
  vehicle: { year?: number; make?: string; model?: string } | null;
  customerFirstName: string | null;
  customerConcern: string | null;
  grandTotal: number;
  deferredCount: number;
  updatedAt: string | null;
}

interface ScriptJob {
  title: string;
  total: number;
  declined: boolean;
}

interface ScriptResult {
  workOrderId: string;
  context: {
    vehicle: { year?: number; make?: string; model?: string } | null;
    customerFirstName: string | null;
    customerConcern: string | null;
    grandTotal: number;
    jobs: ScriptJob[];
  };
  script: {
    opening: string;
    concernAcknowledgment: string | null;
    valuePoints: { job: string; talkingPoint: string }[];
    totalPresentation: string;
    deferredRecovery: string | null;
    close: string;
    fullScript: string;
  };
  cached: boolean;
  generatedAt: string;
}

const fmtMoney = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

const vehicleLabel = (v: OpenEstimate["vehicle"]) =>
  v ? `${v.year ?? ""} ${v.make ?? ""} ${v.model ?? ""}`.trim() || "Unknown vehicle" : "Unknown vehicle";

export default function SalesCoachPage() {
  const [estimates, setEstimates] = useState<OpenEstimate[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<OpenEstimate | null>(null);
  const [script, setScript] = useState<ScriptResult | null>(null);
  const [scriptLoading, setScriptLoading] = useState(false);
  const [scriptError, setScriptError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const loadList = useCallback(async () => {
    setListError(null);
    setEstimates(null);
    try {
      const res = await fetch("/api/sales-script");
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setEstimates(data.estimates);
    } catch (e: any) {
      setListError(e?.message || "Failed to load open estimates");
      setEstimates([]);
    }
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  const openScript = useCallback(async (est: OpenEstimate) => {
    setSelected(est);
    setScript(null);
    setScriptError(null);
    setScriptLoading(true);
    setCopied(false);
    try {
      const res = await fetch(`/api/sales-script?workOrderId=${encodeURIComponent(est.workOrderId)}`);
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setScript(data);
    } catch (e: any) {
      setScriptError(e?.message || "Failed to generate script");
    } finally {
      setScriptLoading(false);
    }
  }, []);

  const copyScript = useCallback(async () => {
    if (!script?.script.fullScript) return;
    try {
      await navigator.clipboard.writeText(script.script.fullScript);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard unavailable */ }
  }, [script]);

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <div className="flex items-center gap-3 mb-1">
        <Megaphone className="w-7 h-7 text-blue-600" />
        <h1 className="text-2xl font-bold text-gray-900">Sales Coach</h1>
      </div>
      <p className="text-gray-500 mb-6">
        AI-generated call scripts for your open estimates — value framing, the total, and a clear close.
      </p>

      {!selected ? (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
            <h2 className="font-semibold text-gray-800">Open estimates</h2>
            <button
              onClick={loadList}
              className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800"
            >
              <RefreshCw className="w-4 h-4" /> Refresh
            </button>
          </div>

          {estimates === null && !listError && (
            <div className="flex items-center justify-center py-12 text-gray-400">
              <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading open estimates…
            </div>
          )}
          {listError && (
            <div className="px-4 py-6 text-sm text-red-600">{listError}</div>
          )}
          {estimates !== null && !listError && estimates.length === 0 && (
            <div className="px-4 py-10 text-center text-gray-500 text-sm">
              No open estimates right now. New estimates from your shop management system show up here automatically.
            </div>
          )}
          {estimates && estimates.length > 0 && (
            <ul className="divide-y divide-gray-100">
              {estimates.map((est) => (
                <li key={est.workOrderId}>
                  <button
                    onClick={() => openScript(est)}
                    className="w-full text-left px-4 py-3 hover:bg-blue-50/50 transition flex items-center justify-between gap-4"
                  >
                    <div className="min-w-0">
                      <div className="font-medium text-gray-900 truncate">
                        {vehicleLabel(est.vehicle)}
                        {est.workOrderNumber && (
                          <span className="ml-2 text-gray-400 font-normal">RO #{est.workOrderNumber}</span>
                        )}
                      </div>
                      <div className="text-sm text-gray-500 truncate">
                        {est.customerFirstName ? `${est.customerFirstName} · ` : ""}
                        {est.customerConcern || "No stated concern"}
                        {est.deferredCount > 0 && (
                          <span className="ml-2 text-amber-600">
                            {est.deferredCount} deferred item{est.deferredCount > 1 ? "s" : ""}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="text-xs uppercase tracking-wide text-gray-400">{est.status.replace(/_/g, " ")}</span>
                      <span className="font-semibold text-gray-900">{fmtMoney(est.grandTotal)}</span>
                      <MessageSquareQuote className="w-5 h-5 text-blue-500" />
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div>
          <button
            onClick={() => { setSelected(null); setScript(null); setScriptError(null); }}
            className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 mb-4"
          >
            <ChevronLeft className="w-4 h-4" /> Back to open estimates
          </button>

          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 mb-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">{vehicleLabel(selected.vehicle)}</h2>
                <div className="text-sm text-gray-500">
                  {selected.customerFirstName ? `Customer: ${selected.customerFirstName} · ` : ""}
                  {selected.workOrderNumber ? `RO #${selected.workOrderNumber} · ` : ""}
                  {selected.customerConcern || "No stated concern"}
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-xl font-bold text-gray-900">{fmtMoney(selected.grandTotal)}</div>
                <div className="text-xs text-gray-400">estimate total</div>
              </div>
            </div>
            {script && (
              <div className="mt-3 pt-3 border-t border-gray-100">
                <div className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-1">On this estimate</div>
                <ul className="text-sm text-gray-600 grid sm:grid-cols-2 gap-x-6">
                  {script.context.jobs.map((j, i) => (
                    <li key={i} className="flex justify-between gap-2 py-0.5">
                      <span className="truncate">{j.title}{j.declined ? " (deferred)" : ""}</span>
                      <span className="text-gray-500 shrink-0">{fmtMoney(j.total)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {scriptLoading && (
            <div className="flex items-center justify-center py-12 text-gray-400 bg-white rounded-xl border border-gray-200">
              <Loader2 className="w-5 h-5 animate-spin mr-2" /> Writing your script…
            </div>
          )}
          {scriptError && (
            <div className="px-4 py-6 text-sm text-red-600 bg-white rounded-xl border border-gray-200">{scriptError}</div>
          )}

          {script && (
            <div className="space-y-4">
              <div className="bg-blue-50 border border-blue-100 rounded-xl p-5">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-semibold text-blue-900 flex items-center gap-2">
                    <MessageSquareQuote className="w-5 h-5" /> Your script
                  </h3>
                  <button
                    onClick={copyScript}
                    className="inline-flex items-center gap-1.5 text-sm text-blue-700 hover:text-blue-900"
                  >
                    {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                <p className="text-blue-950 leading-relaxed italic">“{script.script.fullScript}”</p>
              </div>

              <div className="grid md:grid-cols-2 gap-4">
                <div className="bg-white rounded-xl border border-gray-200 p-4">
                  <h4 className="text-sm font-semibold text-gray-700 mb-1">Opening</h4>
                  <p className="text-sm text-gray-600">{script.script.opening}</p>
                  {script.script.concernAcknowledgment && (
                    <>
                      <h4 className="text-sm font-semibold text-gray-700 mt-3 mb-1">Their concern</h4>
                      <p className="text-sm text-gray-600">{script.script.concernAcknowledgment}</p>
                    </>
                  )}
                </div>
                <div className="bg-white rounded-xl border border-gray-200 p-4">
                  <h4 className="text-sm font-semibold text-gray-700 mb-1">Presenting the total</h4>
                  <p className="text-sm text-gray-600">{script.script.totalPresentation}</p>
                  {script.script.deferredRecovery && (
                    <>
                      <h4 className="text-sm font-semibold text-amber-700 mt-3 mb-1">Recovering deferred work</h4>
                      <p className="text-sm text-gray-600">{script.script.deferredRecovery}</p>
                    </>
                  )}
                  <h4 className="text-sm font-semibold text-gray-700 mt-3 mb-1">Close</h4>
                  <p className="text-sm text-gray-600">{script.script.close}</p>
                </div>
              </div>

              {script.script.valuePoints.length > 0 && (
                <div className="bg-white rounded-xl border border-gray-200 p-4">
                  <h4 className="text-sm font-semibold text-gray-700 mb-2">Value talking points</h4>
                  <ul className="space-y-1.5">
                    {script.script.valuePoints.map((v, i) => (
                      <li key={i} className="text-sm">
                        <span className="font-medium text-gray-800">{v.job}:</span>{" "}
                        <span className="text-gray-600">{v.talkingPoint}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <p className="text-xs text-gray-400 text-right">
                {script.cached ? "Cached script" : "Freshly generated"} · {new Date(script.generatedAt).toLocaleString()}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
