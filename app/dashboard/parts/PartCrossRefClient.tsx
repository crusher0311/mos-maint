"use client";

import { useState, useCallback } from "react";
import { Search, RefreshCw, Package, Car, Hash, AlertCircle, Database } from "lucide-react";

type PartResult = {
  partNumber: string;
  normalizedPartNumber: string;
  description?: string;
  manufacturer?: string;
  usedOn: { year: number; make: string; model: string; engine?: string }[];
  crossReferences: string[];
  usageCount: number;
  lastUsedAt?: string;
};

type PartCategory = {
  category: string;
  parts: {
    partNumber: string;
    description?: string;
    manufacturer?: string;
    usageCount: number;
    lastUsedAt?: string;
  }[];
};

type SearchMode = "part" | "vehicle";

export default function PartCrossRefClient() {
  const [searchMode, setSearchMode] = useState<SearchMode>("part");
  const [query, setQuery] = useState("");
  const [year, setYear] = useState("");
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [results, setResults] = useState<PartResult[]>([]);
  const [vehicleResults, setVehicleResults] = useState<PartCategory[]>([]);
  const [searchedVehicle, setSearchedVehicle] = useState<{ year: number; make: string; model: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildMessage, setRebuildMessage] = useState<string | null>(null);

  const searchParts = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSearched(true);
    setResults([]);
    setVehicleResults([]);
    setSearchedVehicle(null);

    try {
      if (searchMode === "part") {
        if (!query.trim()) {
          setError("Please enter a part number or description");
          setLoading(false);
          return;
        }
        
        const params = new URLSearchParams();
        params.set("q", query.trim());
        
        const res = await fetch(`/api/parts/search?${params.toString()}`);
        const data = await res.json();

        if (!res.ok) {
          setError(data.error || "Search failed");
          return;
        }

        setResults(data.results || []);
      } else {
        if (!year || !make || !model) {
          setError("Please enter year, make, and model");
          setLoading(false);
          return;
        }
        
        const params = new URLSearchParams();
        params.set("year", year);
        params.set("make", make);
        params.set("model", model);
        
        const res = await fetch(`/api/parts/compatible?${params.toString()}`);
        const data = await res.json();

        if (!res.ok) {
          setError(data.error || "Search failed");
          return;
        }

        setVehicleResults(data.categories || []);
        setSearchedVehicle(data.vehicle || null);
      }
    } catch (err) {
      setError("Failed to search parts");
    } finally {
      setLoading(false);
    }
  }, [searchMode, query, year, make, model]);

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      searchParts();
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-lg shadow p-6">
        <div className="flex gap-4 mb-4">
          <button
            onClick={() => setSearchMode("part")}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
              searchMode === "part"
                ? "bg-blue-600 text-white"
                : "bg-gray-100 text-gray-700 hover:bg-gray-200"
            }`}
          >
            <Hash className="w-4 h-4" />
            Search by Part
          </button>
          <button
            onClick={() => setSearchMode("vehicle")}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
              searchMode === "vehicle"
                ? "bg-blue-600 text-white"
                : "bg-gray-100 text-gray-700 hover:bg-gray-200"
            }`}
          >
            <Car className="w-4 h-4" />
            Search by Vehicle
          </button>
        </div>

        {searchMode === "part" ? (
          <div className="flex gap-4">
            <div className="flex-1">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Part Number or Description
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyPress={handleKeyPress}
                  placeholder="e.g., 51372, WIX, oil filter..."
                  className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              </div>
            </div>
            <div className="flex items-end">
              <button
                onClick={searchParts}
                disabled={loading}
                className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
              >
                {loading ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : (
                  <Search className="w-4 h-4" />
                )}
                Search
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Year
                </label>
                <input
                  type="text"
                  value={year}
                  onChange={(e) => setYear(e.target.value)}
                  onKeyPress={handleKeyPress}
                  placeholder="2018"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Make
                </label>
                <input
                  type="text"
                  value={make}
                  onChange={(e) => setMake(e.target.value)}
                  onKeyPress={handleKeyPress}
                  placeholder="Honda"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Model
                </label>
                <input
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  onKeyPress={handleKeyPress}
                  placeholder="Civic"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            </div>
            <button
              onClick={searchParts}
              disabled={loading}
              className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
            >
              {loading ? (
                <RefreshCw className="w-4 h-4 animate-spin" />
              ) : (
                <Search className="w-4 h-4" />
              )}
              Find Compatible Parts
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0" />
          <p className="text-red-700">{error}</p>
        </div>
      )}

      {rebuildMessage && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-center gap-3">
          <Database className="w-5 h-5 text-blue-500 flex-shrink-0" />
          <p className="text-blue-700">{rebuildMessage}</p>
        </div>
      )}

      {searched && !loading && !error && results.length === 0 && vehicleResults.length === 0 && (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-8 text-center">
          <Package className="w-12 h-12 text-gray-400 mx-auto mb-3" />
          <p className="text-gray-600 font-medium">No parts found</p>
          <p className="text-sm text-gray-500 mt-1 mb-4">
            Build the parts database from your Protractor invoice history (5 years).
          </p>
          <button
            onClick={async () => {
              setRebuilding(true);
              setRebuildMessage("Building parts history from invoices... This may take a few minutes.");
              try {
                const res = await fetch("/api/parts/build-history", { method: "POST" });
                const data = await res.json();
                if (data.ok) {
                  setRebuildMessage(`${data.message}. ${data.partsIndexed} parts indexed.`);
                  if (data.partsIndexed > 0) {
                    searchParts();
                  }
                } else {
                  setRebuildMessage(data.error || data.message || "No parts found in history");
                }
              } catch {
                setRebuildMessage("Failed to build parts history");
              } finally {
                setRebuilding(false);
              }
            }}
            disabled={rebuilding}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-2"
          >
            {rebuilding ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Database className="w-4 h-4" />
            )}
            Build Parts History
          </button>
        </div>
      )}

      {results.length > 0 && (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200">
            <h2 className="font-semibold text-gray-900">
              {results.length} Part{results.length !== 1 ? "s" : ""} Found
            </h2>
          </div>
          <div className="divide-y divide-gray-100">
            {results.map((part, idx) => (
              <div key={idx} className="p-6 hover:bg-gray-50">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <span className="font-mono text-lg font-semibold text-gray-900">
                        {part.partNumber}
                      </span>
                      {part.manufacturer && (
                        <span className="px-2 py-0.5 bg-blue-100 text-blue-700 text-xs rounded-full">
                          {part.manufacturer}
                        </span>
                      )}
                      <span className="px-2 py-0.5 bg-gray-100 text-gray-600 text-xs rounded-full">
                        Used {part.usageCount}x
                      </span>
                    </div>
                    {part.description && (
                      <p className="text-gray-600 mb-3">{part.description}</p>
                    )}
                    {part.usedOn.length > 0 && (
                      <div className="mt-3">
                        <p className="text-xs font-medium text-gray-500 uppercase mb-2">
                          Compatible Vehicles
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {part.usedOn.slice(0, 6).map((vehicle, vIdx) => (
                            <span
                              key={vIdx}
                              className="inline-flex items-center gap-1 px-2 py-1 bg-gray-100 text-gray-700 text-sm rounded"
                            >
                              <Car className="w-3 h-3" />
                              {vehicle.year} {vehicle.make} {vehicle.model}
                              {vehicle.engine && (
                                <span className="text-gray-500">({vehicle.engine})</span>
                              )}
                            </span>
                          ))}
                          {part.usedOn.length > 6 && (
                            <span className="text-sm text-gray-500">
                              +{part.usedOn.length - 6} more
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                    {part.crossReferences.length > 0 && (
                      <div className="mt-3">
                        <p className="text-xs font-medium text-gray-500 uppercase mb-2">
                          Cross-References
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {part.crossReferences.map((ref, rIdx) => (
                            <span
                              key={rIdx}
                              className="font-mono px-2 py-1 bg-green-100 text-green-700 text-sm rounded"
                            >
                              {ref}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {vehicleResults.length > 0 && searchedVehicle && (
        <div className="space-y-4">
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <div className="flex items-center gap-2">
              <Car className="w-5 h-5 text-blue-600" />
              <span className="font-medium text-blue-900">
                Parts used on {searchedVehicle.year} {searchedVehicle.make} {searchedVehicle.model}
              </span>
            </div>
          </div>
          
          {vehicleResults.map((category, cIdx) => (
            <div key={cIdx} className="bg-white rounded-lg shadow overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-200 bg-gray-50">
                <h3 className="font-semibold text-gray-900">{category.category}</h3>
                <p className="text-sm text-gray-500">{category.parts.length} part{category.parts.length !== 1 ? "s" : ""}</p>
              </div>
              <div className="divide-y divide-gray-100">
                {category.parts.map((part, pIdx) => (
                  <div key={pIdx} className="px-6 py-4 hover:bg-gray-50">
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="font-mono font-semibold text-gray-900">
                          {part.partNumber}
                        </span>
                        {part.manufacturer && (
                          <span className="ml-2 px-2 py-0.5 bg-blue-100 text-blue-700 text-xs rounded-full">
                            {part.manufacturer}
                          </span>
                        )}
                        {part.description && (
                          <p className="text-sm text-gray-600 mt-1">{part.description}</p>
                        )}
                      </div>
                      <span className="px-2 py-1 bg-gray-100 text-gray-600 text-xs rounded-full">
                        Used {part.usageCount}x
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
