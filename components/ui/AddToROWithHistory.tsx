"use client";

import { useState, useEffect, useRef } from "react";
import { Plus, Loader2, Check, AlertCircle, ChevronDown, X, Package, Wrench, DollarSign, Clock } from "lucide-react";
import { AddToROButton } from "./AddToROButton";

type HistoricalJob = {
  _id: string;
  job: {
    title: string;
    description?: string;
    code?: string;
    keywords?: string[];
  };
  vehicle: {
    year?: number;
    make?: string;
    model?: string;
    engine?: string;
  };
  lines: Array<{
    lineType: "labor" | "part" | "sublet" | "other";
    description: string;
    partNumber?: string;
    manufacturer?: string;
    quantity: number;
    unitPrice: number;
    extendedPrice: number;
  }>;
  performedAt?: string;
  matchScore?: number;
  matchBand?: "exact" | "likely" | "possible" | "poor";
  matchBandLabel?: string;
};

type CannedJobOption = {
  id: string;
  title: string;
};

type Props = {
  vin: string;
  serviceTitle: string;
  serviceKey?: string;
  vehicleYear?: number;
  vehicleMake?: string;
  vehicleModel?: string;
  vehicleEngine?: string;
  workOrderGuid?: string;
  workOrderId?: string;
  cannedJobOptions?: CannedJobOption[];
};

export function AddToROWithHistory({
  vin,
  serviceTitle,
  serviceKey,
  vehicleYear,
  vehicleMake,
  vehicleModel,
  vehicleEngine,
  workOrderGuid,
  workOrderId,
  cannedJobOptions = [],
}: Props) {
  const [status, setStatus] = useState<"idle" | "loading" | "loaded" | "adding" | "success" | "error" | "fallback">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [historicalJobs, setHistoricalJobs] = useState<HistoricalJob[]>([]);
  const [selectedJob, setSelectedJob] = useState<HistoricalJob | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  async function fetchHistoricalJobs() {
    setStatus("loading");
    setErrorMsg(null);
    setShowDropdown(true);

    try {
      const params = new URLSearchParams();
      params.set("q", serviceTitle);
      if (vehicleYear) params.set("year", String(vehicleYear));
      if (vehicleMake) params.set("make", vehicleMake);
      if (vehicleModel) params.set("model", vehicleModel);
      if (vehicleEngine) params.set("engine", vehicleEngine);
      params.set("limit", "10");

      const res = await fetch(`/api/jobs/search?${params.toString()}`, {
        credentials: "include",
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to search job history");
      }

      const filteredJobs = (data.results || []).filter(
        (job: HistoricalJob) => job.matchBand !== "poor" && job.matchScore && job.matchScore >= 70
      );

      if (filteredJobs.length === 0 && cannedJobOptions.length > 0) {
        setStatus("fallback");
        setShowDropdown(false);
      } else {
        setHistoricalJobs(filteredJobs);
        setStatus("loaded");
      }
    } catch (err: unknown) {
      if (cannedJobOptions.length > 0) {
        setStatus("fallback");
        setShowDropdown(false);
      } else {
        setStatus("error");
        setErrorMsg(err instanceof Error ? err.message : "Failed to search");
      }
    }
  }

  async function addJobToRO(job: HistoricalJob) {
    if (!workOrderGuid) {
      setStatus("error");
      setErrorMsg("No open work order - open one in Protractor first");
      return;
    }

    setStatus("adding");
    setSelectedJob(job);

    try {
      const res = await fetch("/api/jobs/add-to-ro", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          workOrderGuid,
          job: {
            title: job.job.title,
            description: job.job.description,
            code: job.job.code,
            lines: job.lines,
          },
        }),
      });

      const data = await res.json();

      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Failed to add job");
      }

      setStatus("success");
      setShowDropdown(false);
    } catch (err: unknown) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Failed to add");
    }
  }

  function formatPrice(lines: HistoricalJob["lines"]) {
    const total = lines.reduce((sum, line) => sum + (line.extendedPrice || 0), 0);
    return total > 0 ? `$${total.toFixed(2)}` : "";
  }

  function formatPartsCount(lines: HistoricalJob["lines"]) {
    const parts = lines.filter((l) => l.lineType === "part").length;
    const labor = lines.filter((l) => l.lineType === "labor").length;
    const bits: string[] = [];
    if (parts > 0) bits.push(`${parts} part${parts > 1 ? "s" : ""}`);
    if (labor > 0) bits.push(`${labor} labor`);
    return bits.join(", ");
  }

  function getBandColor(band?: string) {
    switch (band) {
      case "exact":
        return "bg-green-100 text-green-700 border-green-200";
      case "likely":
        return "bg-blue-100 text-blue-700 border-blue-200";
      case "possible":
        return "bg-amber-100 text-amber-700 border-amber-200";
      default:
        return "bg-gray-100 text-gray-600 border-gray-200";
    }
  }

  if (status === "success") {
    return (
      <span className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-green-100 text-green-700 text-xs font-medium">
        <Check className="w-3 h-3" />
        Added to RO
      </span>
    );
  }

  if (status === "fallback" && cannedJobOptions.length > 0 && serviceKey) {
    return (
      <AddToROButton
        vin={vin}
        serviceKey={serviceKey}
        cannedJobOptions={cannedJobOptions}
        workOrderId={workOrderId}
      />
    );
  }

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => {
          if (status === "idle" || status === "error") {
            fetchHistoricalJobs();
          } else {
            setShowDropdown(!showDropdown);
          }
        }}
        disabled={status === "loading" || status === "adding"}
        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 transition-colors disabled:opacity-50"
      >
        {status === "loading" || status === "adding" ? (
          <>
            <Loader2 className="w-3 h-3 animate-spin" />
            {status === "adding" ? "Adding..." : "Finding..."}
          </>
        ) : (
          <>
            <Plus className="w-3 h-3" />
            Add to RO
          </>
        )}
      </button>

      {showDropdown && status === "loaded" && (
        <div className="absolute right-0 top-full mt-2 w-96 bg-white rounded-xl shadow-2xl border border-gray-200 z-50 max-h-[400px] overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 bg-gray-50 rounded-t-xl">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-gray-900">Historical Jobs</h3>
                <p className="text-xs text-gray-500 mt-0.5">
                  Matched for "{serviceTitle.substring(0, 30)}..."
                </p>
              </div>
              <button
                onClick={() => setShowDropdown(false)}
                className="p-1 hover:bg-gray-200 rounded-full transition-colors"
              >
                <X className="w-4 h-4 text-gray-500" />
              </button>
            </div>
          </div>

          <div className="overflow-y-auto max-h-[320px]">
            {historicalJobs.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <Package className="w-8 h-8 text-gray-300 mx-auto mb-2" />
                <p className="text-sm text-gray-500">No matching jobs found in history</p>
                <p className="text-xs text-gray-400 mt-1">
                  Try adding this service manually
                </p>
              </div>
            ) : (
              <div className="divide-y divide-gray-100">
                {historicalJobs.map((job) => (
                  <button
                    key={job._id}
                    onClick={() => addJobToRO(job)}
                    className="w-full px-4 py-3 text-left hover:bg-blue-50 transition-colors"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span
                            className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${getBandColor(
                              job.matchBand
                            )}`}
                          >
                            {job.matchBandLabel || job.matchBand}
                          </span>
                          {job.matchScore && (
                            <span className="text-[10px] text-gray-400">
                              {job.matchScore}%
                            </span>
                          )}
                        </div>
                        <p className="text-sm font-medium text-gray-900 truncate">
                          {job.job.title}
                        </p>
                        <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                          <span className="flex items-center gap-1">
                            <Wrench className="w-3 h-3" />
                            {job.vehicle.year} {job.vehicle.make} {job.vehicle.model}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                          <span className="flex items-center gap-1">
                            <Package className="w-3 h-3" />
                            {formatPartsCount(job.lines)}
                          </span>
                          {formatPrice(job.lines) && (
                            <span className="flex items-center gap-1">
                              <DollarSign className="w-3 h-3" />
                              {formatPrice(job.lines)}
                            </span>
                          )}
                        </div>
                      </div>
                      <Plus className="w-4 h-4 text-blue-600 flex-shrink-0 mt-1" />
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {errorMsg && (
            <div className="px-4 py-2 bg-red-50 border-t border-red-100">
              <p className="text-xs text-red-600 flex items-center gap-1">
                <AlertCircle className="w-3 h-3" />
                {errorMsg}
              </p>
            </div>
          )}
        </div>
      )}

      {showDropdown && status === "loading" && (
        <div className="absolute right-0 top-full mt-2 w-80 bg-white rounded-xl shadow-2xl border border-gray-200 z-50 p-6">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="w-6 h-6 text-blue-600 animate-spin" />
            <p className="text-sm text-gray-600">Searching job history...</p>
          </div>
        </div>
      )}

      {status === "error" && !showDropdown && errorMsg && (
        <div className="absolute right-0 top-full mt-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg z-50">
          <p className="text-xs text-red-600 flex items-center gap-1">
            <AlertCircle className="w-3 h-3" />
            {errorMsg}
          </p>
        </div>
      )}
    </div>
  );
}
