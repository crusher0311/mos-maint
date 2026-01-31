"use client";

import { useState, useEffect, useRef } from "react";
import { Plus, Loader2, Check, AlertCircle, ChevronDown, ChevronUp, X, Package, Wrench, DollarSign, Clock } from "lucide-react";
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

// Normalize service titles to better search terms
function normalizeServiceTitle(title: string): string {
  const normalized = title.toLowerCase();
  
  // Map common maintenance service phrases to their core search terms
  const termMappings: [RegExp, string][] = [
    // Fluid services
    [/brake\s*fluid|brake\s*system\s*fluid/i, "brake fluid"],
    [/transmission\s*fluid|trans\s*fluid|atf/i, "transmission fluid"],
    [/power\s*steering\s*fluid/i, "power steering fluid"],
    [/coolant|antifreeze|cooling\s*system/i, "coolant"],
    [/differential\s*fluid/i, "differential fluid"],
    [/transfer\s*case\s*fluid/i, "transfer case fluid"],
    
    // Filters
    [/engine\s*air\s*filter|air\s*filter(?!\s*cabin)/i, "air filter"],
    [/cabin\s*(air\s*)?filter|hvac\s*filter|interior\s*filter/i, "cabin filter"],
    [/oil\s*filter/i, "oil filter"],
    [/fuel\s*filter/i, "fuel filter"],
    
    // Belts
    [/serpentine\s*belt|drive\s*belt|accessory\s*belt/i, "serpentine belt"],
    [/timing\s*belt/i, "timing belt"],
    
    // Brakes
    [/brake\s*pad|front\s*brake|rear\s*brake/i, "brake pads"],
    [/brake\s*rotor/i, "brake rotors"],
    
    // Spark plugs and ignition - use singular for better search matching
    [/spark\s*plug/i, "spark plug"],
    [/ignition\s*coil/i, "ignition coil"],
    
    // Wipers
    [/wiper\s*blade/i, "wiper blades"],
    
    // Battery
    [/battery/i, "battery"],
    
    // Alignment
    [/wheel\s*alignment|alignment/i, "alignment"],
    
    // Tires
    [/tire\s*rotation/i, "tire rotation"],
    
    // Oil change
    [/oil\s*change|engine\s*oil|motor\s*oil/i, "oil change"],
    
    // Radiator
    [/radiator\s*cap/i, "radiator cap"],
    [/radiator\s*hose/i, "radiator hose"],
    
    // Locks/hinges
    [/lubricate.*lock|lock.*lubricate|door.*hinge/i, "lubricate locks hinges"],
  ];
  
  for (const [pattern, replacement] of termMappings) {
    if (pattern.test(normalized)) {
      return replacement;
    }
  }
  
  // Fallback: remove common action words and return the rest
  return normalized
    .replace(/^(replace|inspect|check|service|repair|install|perform|flush)\s+/i, "")
    .replace(/\.$/, "")
    .trim();
}

type IntegrationType = "protractor" | "tekmetric";

type MatchedDeferred = {
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
  repairOrderId?: string | number;
  cannedJobOptions?: CannedJobOption[];
  integration?: IntegrationType;
  protractorDeferredId?: string;
  matchedDeferred?: MatchedDeferred; // OEM item has matching deferred work
  showHistoryButton?: boolean; // Show History button (requires backfill integration)
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
  repairOrderId,
  cannedJobOptions = [],
  integration = "protractor",
  protractorDeferredId,
  matchedDeferred,
  showHistoryButton = true,
}: Props) {
  const [status, setStatus] = useState<"idle" | "loading" | "loaded" | "adding" | "success" | "error" | "fallback">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [historicalJobs, setHistoricalJobs] = useState<HistoricalJob[]>([]);
  const [selectedJob, setSelectedJob] = useState<HistoricalJob | null>(null);
  const [customQuery, setCustomQuery] = useState("");
  const [lastSearchQuery, setLastSearchQuery] = useState("");
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [deferredStatus, setDeferredStatus] = useState<"idle" | "adding" | "success" | "error">("idle");
  const [deferredError, setDeferredError] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  async function fetchHistoricalJobs(searchQuery?: string) {
    // Use provided search query, or normalize the service title for better results
    const query = searchQuery ?? normalizeServiceTitle(serviceTitle);
    setStatus("loading");
    setErrorMsg(null);
    setShowDropdown(true);
    setLastSearchQuery(query);

    try {
      const params = new URLSearchParams();
      params.set("q", query);
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

      // Show all non-poor results - API already filters at score >= 40
      const filteredJobs = (data.results || []).filter(
        (job: HistoricalJob) => job.matchBand !== "poor"
      );

      // Always show the dropdown with results (or empty state)
      setHistoricalJobs(filteredJobs);
      setStatus("loaded");
      
      // Focus the search input after loading
      setTimeout(() => searchInputRef.current?.focus(), 100);
    } catch (err: unknown) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Failed to search");
    }
  }
  
  function handleCustomSearch(e: React.FormEvent) {
    e.preventDefault();
    if (customQuery.trim()) {
      fetchHistoricalJobs(customQuery.trim());
    }
  }

  async function addJobToRO(job: HistoricalJob) {
    if (!workOrderGuid) {
      setStatus("error");
      setErrorMsg("No open work order - open one in Protractor first");
      return;
    }

    setSelectedJob(job);
    setStatus("success");
    setShowDropdown(false);

    fetch("/api/jobs/add-to-ro", {
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
        source: "lookup",
        vehicle: {
          vin,
          year: vehicleYear,
          make: vehicleMake,
          model: vehicleModel,
        },
      }),
    }).then(async (res) => {
      const data = await res.json();
      if (!res.ok || !data.ok) {
        console.error("[AddToRO] Background add failed:", data.error);
        setStatus("error");
        setErrorMsg(data.error || "Failed to add job - please try again");
      }
    }).catch((err) => {
      console.error("[AddToRO] Background add failed:", err);
      setStatus("error");
      setErrorMsg("Network error - please try again");
    });
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

  async function handleAddDeferred(deferredId?: string) {
    const idToUse = deferredId || protractorDeferredId || matchedDeferred?.id;
    if (!idToUse || !workOrderGuid) return;
    
    setDeferredStatus("adding");
    setDeferredError(null);
    
    try {
      const res = await fetch("/api/jobs/add-deferred", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workOrderGuid,
          deferredId: idToUse,
          vin,
          serviceTitle: matchedDeferred?.title || serviceTitle,
        }),
      });
      
      const data = await res.json();
      
      if (!res.ok) {
        setDeferredStatus("error");
        setDeferredError(data.error || "Failed to add deferred work");
        return;
      }
      
      setDeferredStatus("success");
    } catch (err) {
      setDeferredStatus("error");
      setDeferredError("Network error");
    }
  }

  if (status === "success" || deferredStatus === "success") {
    return (
      <span className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-green-100 text-green-700 text-xs font-medium">
        <Check className="w-3 h-3" />
        Added to RO
      </span>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {/* Add Deferred button - for Protractor deferred work items or OEM items with matched deferred */}
      {(protractorDeferredId || matchedDeferred) && workOrderGuid && integration === "protractor" && (
        <button
          onClick={() => handleAddDeferred()}
          disabled={deferredStatus === "adding"}
          className="inline-flex items-center gap-0.5 px-2 py-1 rounded-lg bg-blue-100 border border-blue-300 text-blue-700 text-xs font-medium hover:bg-blue-200 transition-colors disabled:opacity-50"
          title={matchedDeferred ? `Add matching shop recommendation: ${matchedDeferred.title}` : "Add this previously deferred service directly to the work order"}
        >
          {deferredStatus === "adding" ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <>
              <span className="relative">
                <img src="/protractor-icon.png" alt="" className="w-4 h-4 rounded-full" />
                <Plus className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 text-blue-700 bg-blue-100 rounded-full" />
              </span>
              <span className="ml-1">{matchedDeferred ? "+" : ""}Deferred</span>
            </>
          )}
        </button>
      )}

      {deferredStatus === "error" && deferredError && (
        <span className="text-xs text-red-600">{deferredError}</span>
      )}

      {/* Add History button - only show if shop has backfill integration */}
      {showHistoryButton && (
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
              History
            </>
          )}
        </button>

      {showDropdown && status === "loaded" && (
        <div className="absolute right-0 top-full mt-2 w-96 bg-white rounded-xl shadow-2xl border border-gray-200 z-50 max-h-[480px] overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 bg-gray-50 rounded-t-xl">
            <div className="flex items-center justify-between mb-2">
              <div>
                <h3 className="text-sm font-semibold text-gray-900">Historical Jobs</h3>
                <p className="text-xs text-gray-500 mt-0.5">
                  Searched: "{lastSearchQuery.substring(0, 25)}{lastSearchQuery.length > 25 ? '...' : ''}"
                </p>
              </div>
              <button
                onClick={() => setShowDropdown(false)}
                className="p-1 hover:bg-gray-200 rounded-full transition-colors"
              >
                <X className="w-4 h-4 text-gray-500" />
              </button>
            </div>
            <form onSubmit={handleCustomSearch} className="flex gap-2">
              <input
                ref={searchInputRef}
                type="text"
                value={customQuery}
                onChange={(e) => setCustomQuery(e.target.value)}
                placeholder="Search different term..."
                className="flex-1 px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              <button
                type="submit"
                disabled={!customQuery.trim()}
                className="px-3 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Search
              </button>
            </form>
          </div>

          <div className="overflow-y-auto max-h-[340px]">
            {historicalJobs.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <Package className="w-8 h-8 text-gray-300 mx-auto mb-2" />
                <p className="text-sm text-gray-500">No matching jobs found</p>
                <p className="text-xs text-gray-400 mt-1">
                  Try a different search term above
                </p>
              </div>
            ) : (
              <div className="divide-y divide-gray-100">
                {historicalJobs.map((job) => {
                  const isExpanded = expandedJobId === job._id;
                  return (
                    <div key={job._id} className="hover:bg-blue-50/50 transition-colors">
                      <div className="px-4 py-3">
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
                            <p className="text-sm font-medium text-gray-900">
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
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => setExpandedJobId(isExpanded ? null : job._id)}
                              className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors"
                              title={isExpanded ? "Collapse details" : "View details"}
                            >
                              {isExpanded ? (
                                <ChevronUp className="w-4 h-4" />
                              ) : (
                                <ChevronDown className="w-4 h-4" />
                              )}
                            </button>
                            <button
                              onClick={() => addJobToRO(job)}
                              className="p-1.5 text-blue-600 hover:text-blue-700 hover:bg-blue-100 rounded transition-colors"
                              title="Add to work order"
                            >
                              <Plus className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      </div>
                      
                      {isExpanded && job.lines && job.lines.length > 0 && (
                        <div className="px-4 pb-3 pt-0">
                          <div className="bg-gray-50 rounded-lg border border-gray-200 overflow-hidden">
                            <div className="px-3 py-2 bg-gray-100 border-b border-gray-200">
                              <p className="text-xs font-medium text-gray-600">Line Items ({job.lines.length})</p>
                            </div>
                            <div className="divide-y divide-gray-100 max-h-48 overflow-y-auto">
                              {job.lines.map((line, idx) => (
                                <div key={idx} className="px-3 py-2 text-xs">
                                  <div className="flex items-start justify-between gap-2">
                                    <div className="flex-1 min-w-0">
                                      <div className="flex items-center gap-1.5">
                                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                                          line.lineType === 'labor' ? 'bg-purple-100 text-purple-700' :
                                          line.lineType === 'part' ? 'bg-blue-100 text-blue-700' :
                                          line.lineType === 'sublet' ? 'bg-orange-100 text-orange-700' :
                                          'bg-gray-100 text-gray-600'
                                        }`}>
                                          {line.lineType}
                                        </span>
                                        <span className="text-gray-900 truncate">{line.description}</span>
                                      </div>
                                      {line.partNumber && (
                                        <p className="text-gray-500 mt-0.5 truncate">
                                          Part #: {line.partNumber}
                                          {line.manufacturer && ` (${line.manufacturer})`}
                                        </p>
                                      )}
                                    </div>
                                    <div className="text-right flex-shrink-0">
                                      <p className="text-gray-900 font-medium">
                                        ${line.extendedPrice?.toFixed(2) || '0.00'}
                                      </p>
                                      {line.quantity > 1 && (
                                        <p className="text-gray-400 text-[10px]">
                                          {line.quantity} × ${line.unitPrice?.toFixed(2)}
                                        </p>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
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
      )}
      
      {/* Add Canned Job button - only show when service-specific mappings exist */}
      {cannedJobOptions.length > 0 && (
        <AddToROButton
          vin={vin}
          serviceKey={serviceKey || serviceTitle}
          cannedJobOptions={cannedJobOptions}
          workOrderId={workOrderId}
          repairOrderId={repairOrderId}
          buttonLabel="Canned"
          integration={integration}
        />
      )}
    </div>
  );
}
