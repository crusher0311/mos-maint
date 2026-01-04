"use client";

import React, { useState, useEffect, useRef } from "react";

interface AutocompleteSuggestion {
  title: string;
  description?: string;
  avgHours?: number;
  avgTotal?: number;
  avgLaborTotal?: number;
  avgPartsTotal?: number;
  occurrences: number;
  lastPerformed?: string;
  vehicleMatch: boolean;
  cannedJobCode?: string;
}

export default function AutocompleteDemo() {
  const [query, setQuery] = useState("");
  const [vin, setVin] = useState("");
  const [year, setYear] = useState("");
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [suggestions, setSuggestions] = useState<AutocompleteSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [cached, setCached] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [isOpen, setIsOpen] = useState(false);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (query.length < 2) {
      setSuggestions([]);
      setIsOpen(false);
      return;
    }

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ q: query });
        if (vin) params.set("vin", vin);
        if (year) params.set("year", year);
        if (make) params.set("make", make);
        if (model) params.set("model", model);
        params.set("enterprise", "true");

        const res = await fetch(`/api/jobs/autocomplete?${params}`);
        const data = await res.json();
        
        if (data.suggestions) {
          setSuggestions(data.suggestions);
          setCached(data.cached || false);
          setIsOpen(true);
          setSelectedIndex(-1);
        }
      } catch (err) {
        console.error("Autocomplete error:", err);
      } finally {
        setLoading(false);
      }
    }, 150);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [query, vin, year, make, model]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen || suggestions.length === 0) return;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelectedIndex(prev => 
          prev < suggestions.length - 1 ? prev + 1 : 0
        );
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelectedIndex(prev => 
          prev > 0 ? prev - 1 : suggestions.length - 1
        );
        break;
      case "Enter":
        e.preventDefault();
        if (selectedIndex >= 0 && suggestions[selectedIndex]) {
          setQuery(suggestions[selectedIndex].title);
          setIsOpen(false);
        }
        break;
      case "Escape":
        setIsOpen(false);
        break;
    }
  };

  const formatCurrency = (value?: number) => {
    if (value === undefined || value === null) return "—";
    return `$${value.toFixed(2)}`;
  };

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">
          Smart Job Autocomplete
        </h1>
        <p className="text-gray-600 mb-8">
          Start typing a job name to see suggestions with historical pricing data.
          Vehicle-specific matches are highlighted.
        </p>

        <div className="bg-white rounded-lg shadow-lg p-6 mb-6">
          <h2 className="text-lg font-semibold text-gray-800 mb-4">
            Vehicle Context (Optional)
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                VIN
              </label>
              <input
                type="text"
                value={vin}
                onChange={(e) => setVin(e.target.value)}
                placeholder="1HGBH41JXMN109186"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Year
              </label>
              <input
                type="text"
                value={year}
                onChange={(e) => setYear(e.target.value)}
                placeholder="2020"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
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
                placeholder="Honda"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
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
                placeholder="Accord"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
              />
            </div>
          </div>

          <div className="relative">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Job Search
            </label>
            <div className="relative">
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                onFocus={() => suggestions.length > 0 && setIsOpen(true)}
                placeholder="Start typing... e.g., 'oil change', 'brake pads', 'timing belt'"
                className="w-full px-4 py-3 text-lg border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              {loading && (
                <div className="absolute right-3 top-1/2 -translate-y-1/2">
                  <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600"></div>
                </div>
              )}
            </div>

            {isOpen && suggestions.length > 0 && (
              <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-xl max-h-[400px] overflow-auto">
                {cached && (
                  <div className="px-3 py-1 bg-gray-50 text-xs text-gray-500 border-b">
                    Cached result
                  </div>
                )}
                {suggestions.map((suggestion, index) => (
                  <div
                    key={`${suggestion.title}-${index}`}
                    className={`px-4 py-3 cursor-pointer border-b border-gray-100 last:border-b-0 transition-colors ${
                      index === selectedIndex
                        ? "bg-blue-50"
                        : "hover:bg-gray-50"
                    }`}
                    onClick={() => {
                      setQuery(suggestion.title);
                      setIsOpen(false);
                    }}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-gray-900">
                            {suggestion.title}
                          </span>
                          {suggestion.vehicleMatch && (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                              Vehicle Match
                            </span>
                          )}
                          {suggestion.cannedJobCode && (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                              {suggestion.cannedJobCode}
                            </span>
                          )}
                        </div>
                        {suggestion.description && (
                          <p className="text-sm text-gray-500 mt-0.5 line-clamp-1">
                            {suggestion.description}
                          </p>
                        )}
                      </div>
                      <div className="text-right text-sm ml-4 whitespace-nowrap">
                        <div className="font-semibold text-gray-900">
                          {formatCurrency(suggestion.avgTotal)}
                        </div>
                        <div className="text-gray-500 text-xs">
                          {suggestion.avgHours ? `${suggestion.avgHours}h` : "—"} avg
                        </div>
                      </div>
                    </div>
                    <div className="mt-2 flex items-center gap-4 text-xs text-gray-500">
                      <span>
                        <strong>{suggestion.occurrences}</strong> times performed
                      </span>
                      <span>Labor: {formatCurrency(suggestion.avgLaborTotal)}</span>
                      <span>Parts: {formatCurrency(suggestion.avgPartsTotal)}</span>
                      {suggestion.lastPerformed && (
                        <span>
                          Last: {new Date(suggestion.lastPerformed).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {isOpen && suggestions.length === 0 && query.length >= 2 && !loading && (
              <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-xl p-4 text-center text-gray-500">
                No matching jobs found
              </div>
            )}
          </div>
        </div>

        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-gray-800 mb-4">
            How It Works
          </h2>
          <ul className="space-y-2 text-gray-600">
            <li className="flex items-start gap-2">
              <span className="text-green-500">✓</span>
              <span>Searches your shop's historical job data for matching services</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-green-500">✓</span>
              <span>Shows average labor hours and pricing from past work orders</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-green-500">✓</span>
              <span>Prioritizes jobs that match the current vehicle (year/make/model)</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-green-500">✓</span>
              <span>Includes enterprise data when multiple shop locations exist</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-green-500">✓</span>
              <span>Results are cached for instant repeat lookups</span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
