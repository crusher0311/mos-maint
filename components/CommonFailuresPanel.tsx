"use client";

import React, { useState, useEffect } from "react";

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
  estimatedCostRange: string;
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

interface CommonFailuresPanelProps {
  vehicle: {
    year?: number;
    make?: string;
    model?: string;
    engine?: string;
    mileage?: number;
  };
}

export default function CommonFailuresPanel({ vehicle }: CommonFailuresPanelProps) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<CommonFailuresResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (vehicle.year && vehicle.make && vehicle.model && vehicle.mileage && vehicle.mileage > 0) {
      fetchFailures();
    }
  }, [vehicle.year, vehicle.make, vehicle.model, vehicle.mileage]);

  const fetchFailures = async () => {
    if (!vehicle.year || !vehicle.make || !vehicle.model || !vehicle.mileage) {
      setError("Missing vehicle information");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        year: String(vehicle.year),
        make: vehicle.make,
        model: vehicle.model,
        mileage: String(vehicle.mileage),
        enterprise: "true",
      });
      if (vehicle.engine) params.set("engine", vehicle.engine);

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

  if (!vehicle.mileage || vehicle.mileage <= 0) {
    return (
      <div className="text-center py-8 text-gray-500">
        <p className="mb-2">Mileage required for failure predictions</p>
        <p className="text-sm">Add mileage to this vehicle to see common failures at this point.</p>
      </div>
    );
  }

  if (!vehicle.year || !vehicle.make || !vehicle.model) {
    return (
      <div className="text-center py-8 text-gray-500">
        <p>Vehicle year, make, and model required</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="flex items-center gap-3 text-gray-600">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
          <span>Analyzing common failures...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-8">
        <p className="text-red-600 mb-4">{error}</p>
        <button
          onClick={fetchFailures}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          Try Again
        </button>
      </div>
    );
  }

  if (!result) {
    return null;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between text-sm text-gray-500 pb-2 border-b">
        <span>@ {result.vehicle.mileage.toLocaleString()} miles</span>
        {result.cached && (
          <span className="px-2 py-0.5 bg-gray-100 rounded-full text-xs">Cached</span>
        )}
      </div>

      {result.failures.length === 0 ? (
        <div className="text-center py-6 text-gray-500">
          No common failures identified for this vehicle at this mileage.
        </div>
      ) : (
        result.failures.map((failure, index) => (
          <div
            key={`${failure.repair}-${index}`}
            className="bg-gray-50 rounded-lg p-4 border border-gray-200"
          >
            <div className="flex items-start justify-between mb-2">
              <div className="flex items-center gap-2">
                <h3 className="font-medium text-gray-900">{failure.repair}</h3>
                <span
                  className={`px-2 py-0.5 rounded-full text-xs font-medium border ${getUrgencyColor(
                    failure.urgency
                  )}`}
                >
                  {failure.urgency.charAt(0).toUpperCase() + failure.urgency.slice(1)}
                </span>
              </div>
              <div className="text-right text-sm">
                <div className="text-gray-500">Typical</div>
                <div className="font-medium text-gray-900">{failure.estimatedCostRange}</div>
              </div>
            </div>

            <p className="text-sm text-gray-600 mb-2">{failure.description}</p>

            <div className="text-xs text-gray-500 mb-2">
              Range: {failure.typicalMileageRange}
            </div>

            {failure.symptoms && failure.symptoms.length > 0 && (
              <div className="flex flex-wrap gap-1 mb-3">
                {failure.symptoms.map((symptom, i) => (
                  <span
                    key={i}
                    className="px-2 py-0.5 bg-gray-200 text-gray-600 text-xs rounded-full"
                  >
                    {symptom}
                  </span>
                ))}
              </div>
            )}

            {failure.shopMatch && (
              <div className="mt-3 p-3 bg-blue-50 rounded-lg border border-blue-100">
                <div className="flex items-center gap-2 mb-2">
                  <div
                    className={`w-2 h-2 rounded-full ${getMatchBadgeColor(
                      failure.matchConfidence
                    )}`}
                  ></div>
                  <span className="text-xs font-medium text-blue-900">
                    Your Shop: {failure.shopMatch.title}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <span className="text-blue-600">Avg Price</span>
                    <div className="font-semibold text-blue-900">
                      ${failure.shopMatch.avgTotal.toFixed(2)}
                    </div>
                  </div>
                  <div>
                    <span className="text-blue-600">Hours</span>
                    <div className="font-medium text-blue-900">{failure.shopMatch.avgHours}h</div>
                  </div>
                  <div>
                    <span className="text-blue-600">Done</span>
                    <div className="font-medium text-blue-900">{failure.shopMatch.occurrences}x</div>
                  </div>
                </div>
              </div>
            )}

            {!failure.shopMatch && (
              <div className="mt-3 p-2 bg-gray-100 rounded text-xs text-gray-500 text-center">
                No matching job in shop history - new opportunity
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}
