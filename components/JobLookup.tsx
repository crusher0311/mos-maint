"use client";

import { useState } from "react";
import { Search, Plus, ChevronDown, ChevronUp, Wrench, Package, Clock, DollarSign } from "lucide-react";

type JobResult = {
  _id: string;
  workOrderId: string;
  workOrderNumber?: number;
  servicePackageId: string;
  performedAt: string;
  vehicle: {
    vin?: string;
    year?: number;
    make?: string;
    model?: string;
    engine?: string;
  };
  job: {
    title: string;
    description?: string;
    code?: string;
    chapter?: string;
  };
  lines: {
    lineType: "labor" | "part" | "sublet" | "other";
    description: string;
    partNumber?: string;
    manufacturer?: string;
    quantity: number;
    unitPrice: number;
    extendedPrice: number;
  }[];
  totals: {
    laborHours: number;
    laborAmount: number;
    partsAmount: number;
    totalAmount: number;
  };
  matchScore: number;
  matchBand?: "exact" | "likely" | "possible" | "poor";
  matchBandLabel?: string;
  matchReason: string;
  isCurrentLocation?: boolean;
  locationName?: string;
  locationShopId?: number;
  scoreBreakdown?: {
    powertrain: number;
    makeModel: number;
    year: number;
    constraints: number;
    evidence: number;
    locationBonus?: number;
  };
};

type Props = {
  currentVehicle?: {
    year?: number;
    make?: string;
    model?: string;
    engine?: string;
  };
  workOrderGuid?: string;
  onJobAdded?: () => void;
};

export default function JobLookup({ currentVehicle, workOrderGuid, onJobAdded }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<JobResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedJob, setExpandedJob] = useState<string | null>(null);
  const [addingJob, setAddingJob] = useState<string | null>(null);
  const [featureNotAvailable, setFeatureNotAvailable] = useState(false);

  const handleSearch = async () => {
    if (!query.trim() && !currentVehicle?.make) {
      setError("Enter a search term or select a vehicle");
      return;
    }

    setLoading(true);
    setError(null);
    setFeatureNotAvailable(false);

    try {
      const params = new URLSearchParams();
      if (query.trim()) params.set("q", query.trim());
      if (currentVehicle?.year) params.set("year", String(currentVehicle.year));
      if (currentVehicle?.make) params.set("make", currentVehicle.make);
      if (currentVehicle?.model) params.set("model", currentVehicle.model);
      if (currentVehicle?.engine) params.set("engine", currentVehicle.engine);

      const res = await fetch(`/api/jobs/search?${params.toString()}`);
      const data = await res.json();

      if (res.status === 402 && data.code === "FEATURE_NOT_AVAILABLE") {
        setFeatureNotAvailable(true);
        setResults([]);
        return;
      }

      if (!res.ok) {
        throw new Error(data.error || "Search failed");
      }

      setResults(data.results || []);
    } catch (err: any) {
      setError(err.message);
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  const handleAddToRO = async (job: JobResult) => {
    if (!workOrderGuid) {
      setError("No work order selected");
      return;
    }

    setAddingJob(job._id);

    try {
      const res = await fetch("/api/jobs/add-to-ro", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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

      if (!res.ok) {
        throw new Error(data.error || "Failed to add job");
      }

      onJobAdded?.();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setAddingJob(null);
    }
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(amount);
  };

  // Compute totals from line items when job.totals is missing or zero
  const getJobTotals = (job: any) => {
    const storedTotal = job.totals?.totalAmount || 0;
    const storedLabor = job.totals?.laborHours || 0;
    const storedParts = job.totals?.partsAmount || 0;
    
    // If stored totals exist, use them
    if (storedTotal > 0) {
      return { totalAmount: storedTotal, laborHours: storedLabor, partsAmount: storedParts };
    }
    
    // Otherwise, compute from line items
    let totalAmount = 0;
    let laborHours = 0;
    let partsAmount = 0;
    
    for (const line of job.lines || []) {
      const lineTotal = line.extendedPrice || (line.unitPrice || 0) * (line.quantity || 1);
      totalAmount += lineTotal;
      
      if (line.lineType === "labor") {
        laborHours += line.quantity || 0;
      } else if (line.lineType === "part") {
        partsAmount += lineTotal;
      }
    }
    
    return { totalAmount, laborHours, partsAmount };
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  const getBandStyle = (band?: string) => {
    switch (band) {
      case "exact":
        return "text-green-700 bg-green-100 border-green-200";
      case "likely":
        return "text-blue-700 bg-blue-100 border-blue-200";
      case "possible":
        return "text-amber-700 bg-amber-100 border-amber-200";
      default:
        return "text-gray-600 bg-gray-100 border-gray-200";
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            placeholder="Search jobs (e.g., oil change, brake pads, timing belt)..."
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
        <button
          onClick={handleSearch}
          disabled={loading}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
        >
          {loading ? (
            <span className="animate-spin">...</span>
          ) : (
            <>
              <Search className="w-4 h-4" />
              Search
            </>
          )}
        </button>
      </div>

      {currentVehicle?.make && (
        <div className="text-sm text-gray-500">
          Searching for jobs on: {currentVehicle.year} {currentVehicle.make} {currentVehicle.model}
          {currentVehicle.engine && ` (${currentVehicle.engine})`}
        </div>
      )}

      {error && (
        <div className="p-3 bg-red-50 text-red-700 rounded-lg text-sm">
          {error}
        </div>
      )}

      {featureNotAvailable && (
        <div className="p-6 bg-gradient-to-r from-purple-50 to-blue-50 border border-purple-200 rounded-lg">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 bg-purple-100 rounded-lg flex items-center justify-center flex-shrink-0">
              <Search className="w-6 h-6 text-purple-600" />
            </div>
            <div>
              <h3 className="font-semibold text-gray-900 mb-1">Job Lookup - Premium Feature</h3>
              <p className="text-sm text-gray-600 mb-3">
                Job Lookup allows you to search through your shop&apos;s historical jobs to quickly find 
                pricing, parts, and labor information for any service.
              </p>
              <p className="text-sm text-gray-500 mb-4">
                Upgrade to Professional or Enterprise to unlock this feature and access your complete job history.
              </p>
              <a 
                href="/settings/billing"
                className="inline-flex items-center gap-2 px-4 py-2 bg-purple-600 text-white text-sm font-medium rounded-lg hover:bg-purple-700 transition-colors"
              >
                View Plans
              </a>
            </div>
          </div>
        </div>
      )}

      {results.length > 0 && (
        <div className="space-y-3">
          <div className="text-sm text-gray-500">
            Found {results.length} matching job{results.length !== 1 ? "s" : ""}
          </div>

          {results.map((job) => (
            <div
              key={job._id}
              className="border border-gray-200 rounded-lg overflow-hidden bg-white"
            >
              <div
                className="p-4 cursor-pointer hover:bg-gray-50"
                onClick={() => setExpandedJob(expandedJob === job._id ? null : job._id)}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <Wrench className="w-4 h-4 text-gray-400" />
                      <span className="font-medium text-gray-900">{job.job.title}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full border ${getBandStyle(job.matchBand)}`}>
                        {job.matchBandLabel}
                      </span>
                      <span className="text-sm font-semibold text-blue-600">{job.matchScore}%</span>
                    </div>
                    <div className="mt-1 text-sm text-gray-500 flex items-center gap-2">
                      <span>{job.vehicle.year} {job.vehicle.make} {job.vehicle.model}</span>
                      {job.vehicle.engine && <span className="text-gray-400">| {job.vehicle.engine}</span>}
                      {job.locationName && (
                        <span className={`text-xs px-1.5 py-0.5 rounded ${
                          job.isCurrentLocation 
                            ? "bg-blue-100 text-blue-700" 
                            : "bg-gray-100 text-gray-600"
                        }`}>
                          {job.locationName}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 text-xs text-gray-400">
                      {job.matchReason}
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <div className="text-right">
                      <div className="text-sm font-medium text-gray-900">
                        {formatCurrency(getJobTotals(job).totalAmount)}
                      </div>
                      <div className="text-xs text-gray-500">
                        {job.lines?.length || 0} line{(job.lines?.length || 0) !== 1 ? "s" : ""}
                      </div>
                    </div>

                    {expandedJob === job._id ? (
                      <ChevronUp className="w-5 h-5 text-gray-400" />
                    ) : (
                      <ChevronDown className="w-5 h-5 text-gray-400" />
                    )}
                  </div>
                </div>
              </div>

              {expandedJob === job._id && (
                <div className="border-t border-gray-200 p-4 bg-gray-50">
                  <div className="grid grid-cols-3 gap-4 mb-4 text-sm">
                    <div className="flex items-center gap-2">
                      <Clock className="w-4 h-4 text-gray-400" />
                      <span className="text-gray-600">Labor:</span>
                      <span className="font-medium">{getJobTotals(job).laborHours}h</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Package className="w-4 h-4 text-gray-400" />
                      <span className="text-gray-600">Parts:</span>
                      <span className="font-medium">{formatCurrency(getJobTotals(job).partsAmount)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <DollarSign className="w-4 h-4 text-gray-400" />
                      <span className="text-gray-600">Total:</span>
                      <span className="font-medium">{formatCurrency(getJobTotals(job).totalAmount)}</span>
                    </div>
                  </div>

                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-gray-500 border-b border-gray-200">
                        <th className="pb-2">Type</th>
                        <th className="pb-2">Description</th>
                        <th className="pb-2">Part #</th>
                        <th className="pb-2 text-right">Qty</th>
                        <th className="pb-2 text-right">Price</th>
                        <th className="pb-2 text-right">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(job.lines || []).map((line, idx) => (
                        <tr key={idx} className="border-b border-gray-100">
                          <td className="py-2">
                            <span className={`text-xs px-1.5 py-0.5 rounded ${
                              line.lineType === "labor" ? "bg-blue-100 text-blue-700" :
                              line.lineType === "part" ? "bg-green-100 text-green-700" :
                              "bg-gray-100 text-gray-700"
                            }`}>
                              {line.lineType}
                            </span>
                          </td>
                          <td className="py-2 text-gray-900">{line.description}</td>
                          <td className="py-2 text-gray-500 font-mono text-xs">
                            {line.partNumber || "-"}
                          </td>
                          <td className="py-2 text-right text-gray-600">{line.quantity}</td>
                          <td className="py-2 text-right text-gray-600">
                            {formatCurrency(line.unitPrice)}
                          </td>
                          <td className="py-2 text-right font-medium text-gray-900">
                            {formatCurrency(line.extendedPrice)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  <div className="mt-4 flex items-center justify-between">
                    <div className="text-xs text-gray-400">
                      WO #{job.workOrderNumber} | {formatDate(job.performedAt)}
                    </div>

                    {workOrderGuid && (
                      <button
                        onClick={() => handleAddToRO(job)}
                        disabled={addingJob === job._id}
                        className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
                      >
                        <Plus className="w-4 h-4" />
                        {addingJob === job._id ? "Adding..." : "Add to RO"}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {!loading && results.length === 0 && query && (
        <div className="text-center py-8 text-gray-500">
          <Search className="w-12 h-12 mx-auto mb-2 text-gray-300" />
          <p>No matching jobs found</p>
          <p className="text-sm mt-1">Try different keywords or broaden your search</p>
        </div>
      )}
    </div>
  );
}
