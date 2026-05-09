"use client";

import { useState, useEffect } from "react";

interface DataQualityReport {
  timestamp: string;
  summary: {
    totalCustomers: number;
    activeCustomers: number;
    orphanedCustomers: number;
    incompleteVehicles: number;
    staleRecords: number;
    duplicateEmails: number;
    invalidVins: number;
  };
  issues: Array<{
    type: string;
    severity: string;
    description: string;
    entityId: string;
    entityType: string;
    suggestedAction: string;
    details?: Record<string, unknown>;
  }>;
  recommendations: string[];
}

export default function DataQualityPage() {
  const [report, setReport] = useState<DataQualityReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [cleanupLoading, setCleanupLoading] = useState(false);
  const [error, setError] = useState("");
  const [cleanupResult, setCleanupResult] = useState<any>(null);

  const runCheck = async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/data-quality");
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || "Failed to run data quality check");
      }
      
      setReport(data.report);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const runCleanup = async (dryRun: boolean = true) => {
    setCleanupLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/data-quality", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cleanup", dryRun })
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || "Cleanup failed");
      }
      
      setCleanupResult(data.result);
      if (!dryRun) {
        // Refresh the report after actual cleanup
        await runCheck();
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCleanupLoading(false);
    }
  };

  useEffect(() => {
    runCheck();
  }, []);

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case "critical": return "text-red-600 bg-red-50";
      case "high": return "text-orange-600 bg-orange-50";
      case "medium": return "text-yellow-600 bg-yellow-50";
      case "low": return "text-blue-600 bg-blue-50";
      default: return "text-gray-600 bg-gray-50";
    }
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Data Quality Monitor</h1>
        <p className="text-gray-600">Monitor and maintain data integrity across your customer database.</p>
      </div>

      {/* Control Panel */}
      <div className="bg-white p-4 rounded-lg shadow mb-6">
        <div className="flex items-center gap-4">
          <button
            onClick={runCheck}
            disabled={loading}
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? "Running Check..." : "Run Quality Check"}
          </button>
          
          <button
            onClick={() => runCleanup(true)}
            disabled={cleanupLoading}
            className="px-4 py-2 bg-yellow-600 text-white rounded hover:bg-yellow-700 disabled:opacity-50"
          >
            {cleanupLoading ? "Running..." : "Preview Cleanup (Dry Run)"}
          </button>
          
          <button
            onClick={() => runCleanup(false)}
            disabled={cleanupLoading}
            className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
          >
            {cleanupLoading ? "Running..." : "Execute Cleanup"}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-6">
          {error}
        </div>
      )}

      {/* Summary Cards */}
      {report && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
          <div className="bg-white p-4 rounded-lg shadow">
            <h3 className="text-sm font-medium text-gray-500">Total Customers</h3>
            <p className="text-2xl font-bold text-gray-900">{report.summary.totalCustomers}</p>
          </div>
          <div className="bg-white p-4 rounded-lg shadow">
            <h3 className="text-sm font-medium text-gray-500">Active Customers</h3>
            <p className="text-2xl font-bold text-green-600">{report.summary.activeCustomers}</p>
          </div>
          <div className="bg-white p-4 rounded-lg shadow">
            <h3 className="text-sm font-medium text-gray-500">Issues Found</h3>
            <p className="text-2xl font-bold text-orange-600">{report.issues.length}</p>
          </div>
          <div className="bg-white p-4 rounded-lg shadow">
            <h3 className="text-sm font-medium text-gray-500">Orphaned Customers</h3>
            <p className="text-2xl font-bold text-red-600">{report.summary.orphanedCustomers}</p>
          </div>
        </div>
      )}

      {/* Cleanup Results */}
      {cleanupResult && (
        <div className="bg-white p-4 rounded-lg shadow mb-6">
          <h2 className="text-lg font-semibold mb-3">Cleanup Results</h2>
          <div className="space-y-2">
            {cleanupResult.actions.map((action: string, index: number) => (
              <div key={index} className="text-sm text-gray-700 bg-gray-50 p-2 rounded">
                {action}
              </div>
            ))}
          </div>
          {cleanupResult.errors.length > 0 && (
            <div className="mt-3">
              <h3 className="text-sm font-medium text-red-600">Errors:</h3>
              {cleanupResult.errors.map((error: string, index: number) => (
                <div key={index} className="text-sm text-red-700 bg-red-50 p-2 rounded mt-1">
                  {error}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Recommendations */}
      {report && report.recommendations.length > 0 && (
        <div className="bg-white p-4 rounded-lg shadow mb-6">
          <h2 className="text-lg font-semibold mb-3">Recommendations</h2>
          <ul className="space-y-2">
            {report.recommendations.map((rec, index) => (
              <li key={index} className="text-sm text-gray-700 bg-blue-50 p-3 rounded flex items-start">
                <span className="text-blue-600 mr-2">•</span>
                {rec}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Issues List */}
      {report && report.issues.length > 0 && (
        <div className="bg-white rounded-lg shadow">
          <div className="px-4 py-3 border-b border-gray-200">
            <h2 className="text-lg font-semibold">Data Quality Issues</h2>
          </div>
          <div className="divide-y divide-gray-200">
            {report.issues.map((issue, index) => (
              <div key={index} className="p-4">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`px-2 py-1 text-xs font-medium rounded ${getSeverityColor(issue.severity)}`}>
                        {issue.severity.toUpperCase()}
                      </span>
                      <span className="text-xs text-gray-500">{issue.type.replace(/_/g, " ")}</span>
                    </div>
                    <p className="text-sm text-gray-900 mb-1">{issue.description}</p>
                    <p className="text-xs text-gray-500">
                      {issue.entityType}:{" "}
                      {issue.type === "mileage_discrepancy" && issue.entityType === "vehicle" ? (
                        <a
                          href={`/dashboard/vehicles/${issue.entityId}`}
                          className="underline text-blue-600 hover:text-blue-800"
                        >
                          {issue.entityId}
                        </a>
                      ) : (
                        issue.entityId
                      )}
                    </p>
                  </div>
                  <div className="ml-4 text-right">
                    <p className="text-xs text-gray-600">{issue.suggestedAction}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {report && report.issues.length === 0 && (
        <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded">
          ✅ No data quality issues found! Your database is in good shape.
        </div>
      )}
    </div>
  );
}