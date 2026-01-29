"use client";

import React, { useState } from "react";

interface ShopMatch {
  title: string;
  avgTotal: number;
  avgHours: number;
  occurrences: number;
  lastPerformed?: string;
}

interface MatchedFailure {
  repair: string;
  description: string;
  urgency: "low" | "medium" | "high";
  typicalMileageRange: string;
  symptoms?: string[];
  shopMatch?: ShopMatch;
  matchConfidence: number;
}

interface CommonFailuresResult {
  vehicle: {
    year: number;
    make: string;
    model: string;
    engine?: string;
    mileage: number;
  };
  failures: MatchedFailure[];
  cached: boolean;
  mileageBucket: number;
}

export default function CommonFailuresDemo() {
  const [year, setYear] = useState("2018");
  const [make, setMake] = useState("Honda");
  const [model, setModel] = useState("Accord");
  const [engine, setEngine] = useState("2.0L Turbo");
  const [mileage, setMileage] = useState("95000");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<CommonFailuresResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSearch = async () => {
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const params = new URLSearchParams({
        year,
        make,
        model,
        mileage,
        enterprise: "true",
      });
      if (engine) params.set("engine", engine);

      const res = await fetch(`/api/vehicle/common-failures?${params}`);
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to get common failures");
      }

      setResult(data);
    } catch (err: any) {
      setError(err.message || "An error occurred");
    } finally {
      setLoading(false);
    }
  };

  const getUrgencyColor = (urgency: string) => {
    switch (urgency) {
      case "high":
        return "bg-red-100 text-red-800 border-red-200";
      case "medium":
        return "bg-yellow-100 text-yellow-800 border-yellow-200";
      case "low":
        return "bg-green-100 text-green-800 border-green-200";
      default:
        return "bg-gray-100 text-gray-800 border-gray-200";
    }
  };

  const getMatchBadgeColor = (confidence: number) => {
    if (confidence >= 80) return "bg-green-500";
    if (confidence >= 60) return "bg-blue-500";
    if (confidence >= 40) return "bg-yellow-500";
    return "bg-gray-400";
  };

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">
          Common Failures Advisor
        </h1>
        <p className="text-gray-600 mb-8">
          AI-powered prediction of common repairs for a specific vehicle and mileage,
          matched to your shop's historical pricing data.
        </p>

        <div className="bg-white rounded-lg shadow-lg p-6 mb-6">
          <h2 className="text-lg font-semibold text-gray-800 mb-4">
            Vehicle Information
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Year *
              </label>
              <input
                type="text"
                value={year}
                onChange={(e) => setYear(e.target.value)}
                placeholder="2020"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Make *
              </label>
              <input
                type="text"
                value={make}
                onChange={(e) => setMake(e.target.value)}
                placeholder="Honda"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Model *
              </label>
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="Accord"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Engine
              </label>
              <input
                type="text"
                value={engine}
                onChange={(e) => setEngine(e.target.value)}
                placeholder="2.0L Turbo"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Mileage *
              </label>
              <input
                type="text"
                value={mileage}
                onChange={(e) => setMileage(e.target.value)}
                placeholder="95000"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
          </div>

          <button
            onClick={handleSearch}
            disabled={loading}
            className="w-full md:w-auto px-6 py-3 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
                Analyzing...
              </span>
            ) : (
              "Get Common Failures"
            )}
          </button>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-6">
            {error}
          </div>
        )}

        {result && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold text-gray-900">
                Common Failures for {result.vehicle.year} {result.vehicle.make}{" "}
                {result.vehicle.model}
                {result.vehicle.engine && ` (${result.vehicle.engine})`}
              </h2>
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <span>@ {result.vehicle.mileage.toLocaleString()} miles</span>
                {result.cached && (
                  <span className="px-2 py-0.5 bg-gray-100 rounded-full text-xs">
                    Cached
                  </span>
                )}
              </div>
            </div>

            {result.failures.length === 0 ? (
              <div className="bg-white rounded-lg shadow p-6 text-center text-gray-500">
                No common failures identified for this vehicle at this mileage.
              </div>
            ) : (
              result.failures.map((failure, index) => (
                <div
                  key={`${failure.repair}-${index}`}
                  className="bg-white rounded-lg shadow-lg overflow-hidden"
                >
                  <div className="p-6">
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex items-center gap-3">
                        <h3 className="text-lg font-semibold text-gray-900">
                          {failure.repair}
                        </h3>
                        <span
                          className={`px-2 py-0.5 rounded-full text-xs font-medium border ${getUrgencyColor(
                            failure.urgency
                          )}`}
                        >
                          {failure.urgency.charAt(0).toUpperCase() +
                            failure.urgency.slice(1)}{" "}
                          Priority
                        </span>
                      </div>
                      <div className="text-right">
                        <div className="text-sm text-gray-500">Mileage Range</div>
                        <div className="font-semibold text-gray-900">
                          {failure.typicalMileageRange}
                        </div>
                      </div>
                    </div>

                    <p className="text-gray-600 mb-3">{failure.description}</p>

                    {failure.symptoms && failure.symptoms.length > 0 && (
                      <div className="mb-4">
                        <span className="text-sm font-medium text-gray-700">
                          Warning Signs:
                        </span>
                        <div className="flex flex-wrap gap-2 mt-1">
                          {failure.symptoms.map((symptom, i) => (
                            <span
                              key={i}
                              className="px-2 py-1 bg-gray-100 text-gray-600 text-xs rounded-full"
                            >
                              {symptom}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {failure.shopMatch && (
                      <div className="mt-4 p-4 bg-blue-50 rounded-lg border border-blue-100">
                        <div className="flex items-center gap-2 mb-2">
                          <div
                            className={`w-2 h-2 rounded-full ${getMatchBadgeColor(
                              failure.matchConfidence
                            )}`}
                          ></div>
                          <span className="text-sm font-medium text-blue-900">
                            Your Shop Has Done This
                          </span>
                          <span className="text-xs text-blue-600">
                            ({failure.matchConfidence}% match)
                          </span>
                        </div>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                          <div>
                            <span className="text-blue-600">Job Title</span>
                            <div className="font-medium text-blue-900">
                              {failure.shopMatch.title}
                            </div>
                          </div>
                          <div>
                            <span className="text-blue-600">Your Avg Price</span>
                            <div className="font-semibold text-blue-900">
                              ${failure.shopMatch.avgTotal.toFixed(2)}
                            </div>
                          </div>
                          <div>
                            <span className="text-blue-600">Avg Labor Hours</span>
                            <div className="font-medium text-blue-900">
                              {failure.shopMatch.avgHours}h
                            </div>
                          </div>
                          <div>
                            <span className="text-blue-600">Times Performed</span>
                            <div className="font-medium text-blue-900">
                              {failure.shopMatch.occurrences}x
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

                    {!failure.shopMatch && failure.matchConfidence === 0 && (
                      <div className="mt-4 p-3 bg-gray-50 rounded-lg border border-gray-200 text-sm text-gray-500">
                        No matching job found in your shop history. This could be
                        a new service opportunity.
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        <div className="mt-8 bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-gray-800 mb-4">
            How It Works
          </h2>
          <ul className="space-y-2 text-gray-600">
            <li className="flex items-start gap-2">
              <span className="text-blue-500">1.</span>
              <span>
                AI analyzes the specific vehicle and powertrain to identify
                known failure patterns at the current mileage
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-blue-500">2.</span>
              <span>
                Results are matched to your shop's historical job data to show
                your actual pricing
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-blue-500">3.</span>
              <span>
                Failures are prioritized by urgency (safety/reliability impact)
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-blue-500">4.</span>
              <span>
                Results are cached by 5,000-mile buckets to minimize AI costs
              </span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
