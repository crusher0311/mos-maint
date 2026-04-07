"use client";

import { useState, useEffect, useCallback } from "react";

interface AuditFinding {
  id: string;
  severity: "critical" | "warning" | "info";
  category: string;
  title: string;
  description: string;
  suggestedAction?: string;
  suggestedJobId?: string;
  suggestedJobTitle?: string;
  confidence: number;
  lineItemIndex?: number;
}

interface AuditReport {
  workOrderId?: string;
  workOrderNumber?: string;
  vehicleDisplay?: string;
  auditDate: string;
  findings: AuditFinding[];
  summary: {
    totalFindings: number;
    critical: number;
    warnings: number;
    info: number;
    score: number;
  };
}

interface AuditHistoryItem {
  _id: string;
  workOrderId?: string;
  workOrderNumber?: string;
  lineItemCount: number;
  findingCount: number;
  score: number;
  createdAt: string;
  report: AuditReport;
}

const severityColors: Record<string, { bg: string; text: string; border: string; badge: string }> = {
  critical: { bg: "bg-red-50", text: "text-red-800", border: "border-red-200", badge: "bg-red-100 text-red-700" },
  warning: { bg: "bg-amber-50", text: "text-amber-800", border: "border-amber-200", badge: "bg-amber-100 text-amber-700" },
  info: { bg: "bg-blue-50", text: "text-blue-800", border: "border-blue-200", badge: "bg-blue-100 text-blue-700" },
};

export default function EstimateAuditPage() {
  const [workOrderId, setWorkOrderId] = useState("");
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<AuditReport | null>(null);
  const [error, setError] = useState("");
  const [severityFilter, setSeverityFilter] = useState<string>("all");
  const [history, setHistory] = useState<AuditHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyStartDate, setHistoryStartDate] = useState("");
  const [historyEndDate, setHistoryEndDate] = useState("");
  const [historySeverityFilter, setHistorySeverityFilter] = useState("all");
  const [expandedHistoryId, setExpandedHistoryId] = useState<string | null>(null);
  const [jobBuilderQuery, setJobBuilderQuery] = useState("");
  const [jobBuilderVin, setJobBuilderVin] = useState("");
  const [jobBuilderResult, setJobBuilderResult] = useState<Record<string, unknown> | null>(null);
  const [jobBuilderLoading, setJobBuilderLoading] = useState(false);
  const [languageMode, setLanguageMode] = useState<"technical" | "customer">("customer");
  const [activeTab, setActiveTab] = useState<"audit" | "builder" | "history">("audit");
  const [builtEstimates, setBuiltEstimates] = useState<Record<string, Record<string, unknown>>>({});
  const [buildingFindingId, setBuildingFindingId] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const params = new URLSearchParams({ limit: "20", offset: "0" });
      if (historyStartDate) params.set("startDate", historyStartDate);
      if (historyEndDate) params.set("endDate", historyEndDate);
      if (historySeverityFilter !== "all") params.set("severity", historySeverityFilter);

      const response = await fetch(`/api/estimate-assist/audit/history?${params}`);
      const data = await response.json();
      if (data.ok) {
        setHistory(data.audits || []);
        setHistoryTotal(data.totalCount || 0);
      }
    } catch (err) {
      console.error("Failed to load audit history:", err);
    } finally {
      setHistoryLoading(false);
    }
  }, [historyStartDate, historyEndDate, historySeverityFilter]);

  useEffect(() => {
    if (activeTab === "history") {
      loadHistory();
    }
  }, [activeTab, loadHistory]);

  const runAudit = async () => {
    if (!workOrderId.trim()) {
      setError("Please enter a work order number or ID");
      return;
    }
    setLoading(true);
    setError("");
    setReport(null);
    try {
      const response = await fetch("/api/estimate-assist/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workOrderId: workOrderId.trim() }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        throw new Error(data.error || "Audit failed");
      }
      setReport(data.report);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Audit failed";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const runJobBuilder = async (queryOverride?: string) => {
    const query = (queryOverride || jobBuilderQuery).trim();
    if (!query) return;
    setJobBuilderLoading(true);
    setJobBuilderResult(null);
    try {
      const response = await fetch("/api/estimate-assist/job-builder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobNameOrId: query,
          vin: jobBuilderVin.trim() || undefined,
          languageMode,
        }),
      });
      const data = await response.json();
      if (data.ok) {
        setJobBuilderResult(data.estimate);
      }
    } catch (err) {
      console.error("Job builder failed:", err);
    }
    setJobBuilderLoading(false);
  };

  const addToEstimate = async (finding: AuditFinding) => {
    if (!finding.suggestedJobTitle) return;
    setBuildingFindingId(finding.id);
    try {
      const response = await fetch("/api/estimate-assist/job-builder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobNameOrId: finding.suggestedJobTitle,
          languageMode,
        }),
      });
      const data = await response.json();
      if (data.ok && data.estimate) {
        setBuiltEstimates(prev => ({ ...prev, [finding.id]: data.estimate }));
      }
    } catch (err) {
      console.error("Add to estimate failed:", err);
    }
    setBuildingFindingId(null);
  };

  const filteredFindings = report?.findings.filter(f =>
    severityFilter === "all" || f.severity === severityFilter
  ) || [];

  const getScoreColor = (score: number) => {
    if (score >= 85) return "text-green-600";
    if (score >= 60) return "text-amber-600";
    return "text-red-600";
  };

  const getScoreBg = (score: number) => {
    if (score >= 85) return "bg-green-50 border-green-200";
    if (score >= 60) return "bg-amber-50 border-amber-200";
    return "bg-red-50 border-red-200";
  };

  const est = jobBuilderResult as Record<string, unknown> | null;

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Estimate Assist</h1>
        <p className="text-gray-500 mt-1">Build accurate estimates and audit existing work orders for completeness</p>
      </div>

      <div className="flex gap-2 mb-6 border-b border-gray-200">
        {(["audit", "builder", "history"] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
              activeTab === tab
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            {tab === "audit" ? "Estimate Audit" : tab === "builder" ? "Smart Job Builder" : "Audit History"}
          </button>
        ))}
      </div>

      {activeTab === "audit" && (
        <div>
          <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6">
            <div className="flex gap-3">
              <input
                type="text"
                value={workOrderId}
                onChange={(e) => setWorkOrderId(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && runAudit()}
                placeholder="Enter work order number or ID..."
                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              <button
                onClick={runAudit}
                disabled={loading}
                className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
              >
                {loading ? "Auditing..." : "Run Audit"}
              </button>
            </div>
            {error && <p className="text-red-600 text-sm mt-2">{error}</p>}
          </div>

          {report && (
            <div>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
                <div className={`rounded-lg border p-4 ${getScoreBg(report.summary.score)}`}>
                  <p className="text-sm text-gray-500">Estimate Score</p>
                  <p className={`text-3xl font-bold ${getScoreColor(report.summary.score)}`}>
                    {report.summary.score}/100
                  </p>
                </div>
                <div className="rounded-lg border border-red-200 bg-red-50 p-4">
                  <p className="text-sm text-gray-500">Critical</p>
                  <p className="text-3xl font-bold text-red-600">{report.summary.critical}</p>
                </div>
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
                  <p className="text-sm text-gray-500">Warnings</p>
                  <p className="text-3xl font-bold text-amber-600">{report.summary.warnings}</p>
                </div>
                <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
                  <p className="text-sm text-gray-500">Info</p>
                  <p className="text-3xl font-bold text-blue-600">{report.summary.info}</p>
                </div>
              </div>

              {report.vehicleDisplay && (
                <div className="text-sm text-gray-500 mb-4">
                  Vehicle: <span className="font-medium text-gray-700">{report.vehicleDisplay}</span>
                  {report.workOrderNumber && (
                    <> &middot; WO# <span className="font-medium text-gray-700">{report.workOrderNumber}</span></>
                  )}
                </div>
              )}

              <div className="flex gap-2 mb-4">
                {["all", "critical", "warning", "info"].map(sev => (
                  <button
                    key={sev}
                    onClick={() => setSeverityFilter(sev)}
                    className={`px-3 py-1 text-sm rounded-full border ${
                      severityFilter === sev
                        ? "bg-gray-900 text-white border-gray-900"
                        : "bg-white text-gray-600 border-gray-300 hover:bg-gray-50"
                    }`}
                  >
                    {sev === "all" ? `All (${report.summary.totalFindings})` :
                     sev === "critical" ? `Critical (${report.summary.critical})` :
                     sev === "warning" ? `Warnings (${report.summary.warnings})` :
                     `Info (${report.summary.info})`}
                  </button>
                ))}
              </div>

              <div className="space-y-3">
                {filteredFindings.map(finding => {
                  const colors = severityColors[finding.severity];
                  return (
                    <div key={finding.id} className={`rounded-lg border p-4 ${colors.bg} ${colors.border}`}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${colors.badge}`}>
                              {finding.severity.toUpperCase()}
                            </span>
                            <span className="text-xs text-gray-500">{finding.category}</span>
                            <span className="text-xs text-gray-400">{Math.round(finding.confidence * 100)}% confidence</span>
                          </div>
                          <h4 className={`font-semibold ${colors.text}`}>{finding.title}</h4>
                          <p className="text-sm text-gray-700 mt-1">{finding.description}</p>
                          {finding.suggestedAction && (
                            <p className="text-sm text-gray-600 mt-2 italic">
                              Suggested: {finding.suggestedAction}
                            </p>
                          )}
                        </div>
                        {finding.suggestedJobTitle && (
                          <div className="flex flex-col gap-1.5">
                            <button
                              onClick={() => addToEstimate(finding)}
                              disabled={buildingFindingId === finding.id || !!builtEstimates[finding.id]}
                              className={`px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap ${
                                builtEstimates[finding.id]
                                  ? "bg-green-600 text-white cursor-default"
                                  : "bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                              }`}
                            >
                              {buildingFindingId === finding.id ? "Building..." :
                               builtEstimates[finding.id] ? "Added" : "+ Add to Estimate"}
                            </button>
                            <button
                              onClick={() => {
                                setJobBuilderQuery(finding.suggestedJobTitle || "");
                                setActiveTab("builder");
                              }}
                              className="px-3 py-1.5 text-xs font-medium bg-white border border-gray-300 rounded-lg hover:bg-gray-50 whitespace-nowrap"
                            >
                              View Details
                            </button>
                          </div>
                        )}
                      </div>
                      {builtEstimates[finding.id] && (() => {
                        const be = builtEstimates[finding.id];
                        const lh = be.laborHours as Record<string, unknown> | undefined;
                        return (
                          <div className="mt-3 p-3 bg-white rounded-lg border border-green-200">
                            <div className="flex items-center gap-2 mb-2">
                              <span className="text-xs font-semibold text-green-700 bg-green-50 px-2 py-0.5 rounded-full">Estimate Line Item</span>
                              <span className="text-xs text-gray-400">{String(be.category || "")}</span>
                            </div>
                            <p className="text-sm font-semibold text-gray-900">{String(be.title || "")}</p>
                            <p className="text-xs text-gray-600 mt-1">{String(be.description || "")}</p>
                            <div className="flex gap-4 mt-2 text-xs text-gray-500">
                              <span>Labor: <strong className="text-gray-700">{String(lh?.typical || 0)}h</strong> ({String(lh?.min || 0)}-{String(lh?.max || 0)}h)</span>
                              {Array.isArray(be.requiredParts) && (be.requiredParts as string[]).length > 0 && (
                                <span>Parts: <strong className="text-gray-700">{(be.requiredParts as string[]).join(", ")}</strong></span>
                              )}
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  );
                })}
                {filteredFindings.length === 0 && (
                  <div className="text-center py-8 text-gray-500">
                    {severityFilter === "all"
                      ? "No findings - this estimate looks complete!"
                      : `No ${severityFilter} findings`}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === "builder" && (
        <div>
          <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6">
            <div className="flex gap-3 mb-3">
              <input
                type="text"
                value={jobBuilderQuery}
                onChange={(e) => setJobBuilderQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && runJobBuilder()}
                placeholder="Search for a job... (e.g., front brake pads, oil change, timing belt)"
                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              <button
                onClick={runJobBuilder}
                disabled={jobBuilderLoading}
                className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium"
              >
                {jobBuilderLoading ? "Building..." : "Build Estimate"}
              </button>
            </div>
            <div className="flex gap-3 items-center">
              <input
                type="text"
                value={jobBuilderVin}
                onChange={(e) => setJobBuilderVin(e.target.value)}
                placeholder="VIN (optional)"
                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => setLanguageMode("customer")}
                  className={`px-3 py-1 text-sm rounded-full border ${
                    languageMode === "customer"
                      ? "bg-blue-600 text-white border-blue-600"
                      : "bg-white text-gray-600 border-gray-300"
                  }`}
                >
                  Customer-Facing
                </button>
                <button
                  onClick={() => setLanguageMode("technical")}
                  className={`px-3 py-1 text-sm rounded-full border ${
                    languageMode === "technical"
                      ? "bg-blue-600 text-white border-blue-600"
                      : "bg-white text-gray-600 border-gray-300"
                  }`}
                >
                  Technical
                </button>
              </div>
            </div>
          </div>

          {est && (
            <div className="space-y-4">
              <div className="bg-white rounded-lg border border-gray-200 p-6">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-medium px-2 py-0.5 bg-gray-100 text-gray-600 rounded-full">
                    {String(est.category || "")}
                  </span>
                  {est.safetyRelated && (
                    <span className="text-xs font-medium px-2 py-0.5 bg-red-100 text-red-600 rounded-full">
                      Safety Related
                    </span>
                  )}
                  {est.aiEnhanced && (
                    <span className="text-xs font-medium px-2 py-0.5 bg-purple-100 text-purple-600 rounded-full">
                      AI Enhanced
                    </span>
                  )}
                </div>
                <h3 className="text-lg font-bold text-gray-900 mb-2">{String(est.title || "")}</h3>

                <div className="mb-4">
                  <h4 className="text-sm font-semibold text-gray-500 uppercase mb-1">
                    {languageMode === "customer" ? "Customer-Facing Description" : "Technical Description"}
                  </h4>
                  <p className="text-gray-700">
                    {languageMode === "customer"
                      ? String(est.customerDescription || "")
                      : String(est.technicalDescription || "")}
                  </p>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                  {(() => {
                    const lh = est.laborHours as Record<string, unknown> | undefined;
                    return (
                      <>
                        <div className="bg-gray-50 rounded-lg p-3">
                          <p className="text-xs text-gray-500">Labor Hours (typical)</p>
                          <p className="text-lg font-bold text-gray-900">{String(lh?.typical || 0)}h</p>
                          <p className="text-xs text-gray-400">Range: {String(lh?.min || 0)}-{String(lh?.max || 0)}h</p>
                        </div>
                        {lh?.shopAverage && (
                          <div className="bg-green-50 rounded-lg p-3">
                            <p className="text-xs text-gray-500">Shop Average</p>
                            <p className="text-lg font-bold text-green-700">{String(lh.shopAverage)}h</p>
                          </div>
                        )}
                      </>
                    );
                  })()}
                  {(() => {
                    const sh = est.shopHistory as Record<string, unknown> | undefined;
                    if (!sh) return null;
                    return (
                      <>
                        <div className="bg-blue-50 rounded-lg p-3">
                          <p className="text-xs text-gray-500">Shop Avg Total</p>
                          <p className="text-lg font-bold text-blue-700">${String(sh.avgTotal)}</p>
                          <p className="text-xs text-gray-400">{String(sh.occurrences)} jobs</p>
                        </div>
                        <div className="bg-blue-50 rounded-lg p-3">
                          <p className="text-xs text-gray-500">Shop Avg Parts</p>
                          <p className="text-lg font-bold text-blue-700">${String(sh.avgPartsTotal)}</p>
                        </div>
                      </>
                    );
                  })()}
                </div>

                {Array.isArray(est.requiredParts) && (est.requiredParts as string[]).length > 0 && (
                  <div className="mb-4">
                    <h4 className="text-sm font-semibold text-gray-500 uppercase mb-2">Required Parts</h4>
                    <div className="flex flex-wrap gap-2">
                      {(est.requiredParts as string[]).map((part: string, i: number) => (
                        <span key={i} className="px-3 py-1 bg-gray-100 text-gray-700 text-sm rounded-full">
                          {part}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {(() => {
                  const vc = est.vehicleContext as Record<string, unknown> | undefined;
                  const va = vc?.vinAdjustments as Record<string, unknown> | undefined;
                  if (!va) return null;
                  return (
                    <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4">
                      <p className="text-sm font-medium text-amber-800">VIN-Specific Adjustments</p>
                      <p className="text-sm text-amber-700">
                        +{String(va.laborHoursAdded)}h labor added for this vehicle configuration
                        {Array.isArray(va.additionalParts) && (va.additionalParts as string[]).length > 0 && (
                          <> &middot; Additional parts: {(va.additionalParts as string[]).join(", ")}</>
                        )}
                      </p>
                    </div>
                  );
                })()}
              </div>

              {Array.isArray(est.companionJobs) && (est.companionJobs as Array<Record<string, unknown>>).length > 0 && (
                <div className="bg-white rounded-lg border border-gray-200 p-4">
                  <h4 className="text-sm font-semibold text-gray-500 uppercase mb-3">Related Jobs (Commonly Done Together)</h4>
                  <div className="space-y-2">
                    {(est.companionJobs as Array<Record<string, unknown>>).map((job) => (
                      <div key={String(job.jobId)} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                        <div>
                          <span className="font-medium text-gray-900">{String(job.title)}</span>
                          <span className="text-sm text-gray-500 ml-2">{String(job.category)}</span>
                          {job.safetyRelated && (
                            <span className="text-xs text-red-600 ml-2">Safety</span>
                          )}
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-sm text-gray-500">{String(job.laborHoursTypical)}h</span>
                          <button
                            onClick={() => {
                              const title = String(job.title);
                              setJobBuilderQuery(title);
                              runJobBuilder(title);
                            }}
                            className="px-3 py-1 text-xs font-medium bg-white border border-gray-300 rounded hover:bg-gray-50"
                          >
                            View
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {Array.isArray(est.upsellJobs) && (est.upsellJobs as Array<Record<string, unknown>>).length > 0 && (
                <div className="bg-white rounded-lg border border-gray-200 p-4">
                  <h4 className="text-sm font-semibold text-gray-500 uppercase mb-3">Upsell Opportunities</h4>
                  <div className="space-y-2">
                    {(est.upsellJobs as Array<Record<string, unknown>>).map((job) => (
                      <div key={String(job.jobId)} className="flex items-center justify-between p-3 bg-green-50 rounded-lg border border-green-100">
                        <span className="font-medium text-gray-900">{String(job.title)}</span>
                        <div className="flex items-center gap-3">
                          <span className="text-sm text-gray-500">{String(job.laborHoursTypical)}h</span>
                          <button
                            onClick={() => {
                              const title = String(job.title);
                              setJobBuilderQuery(title);
                              runJobBuilder(title);
                            }}
                            className="px-3 py-1 text-xs font-medium bg-white border border-gray-300 rounded hover:bg-gray-50"
                          >
                            View
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {activeTab === "history" && (
        <div>
          <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6">
            <div className="flex gap-3 items-end flex-wrap">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Start Date</label>
                <input
                  type="date"
                  value={historyStartDate}
                  onChange={(e) => setHistoryStartDate(e.target.value)}
                  className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">End Date</label>
                <input
                  type="date"
                  value={historyEndDate}
                  onChange={(e) => setHistoryEndDate(e.target.value)}
                  className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Severity</label>
                <select
                  value={historySeverityFilter}
                  onChange={(e) => setHistorySeverityFilter(e.target.value)}
                  className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="all">All</option>
                  <option value="critical">Critical</option>
                  <option value="warning">Warning</option>
                  <option value="info">Info</option>
                </select>
              </div>
              <button
                onClick={loadHistory}
                disabled={historyLoading}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium"
              >
                {historyLoading ? "Loading..." : "Filter"}
              </button>
              <span className="text-sm text-gray-500 ml-auto">{historyTotal} audits</span>
            </div>
          </div>

          {historyLoading ? (
            <div className="text-center py-8 text-gray-500">Loading audit history...</div>
          ) : history.length === 0 ? (
            <div className="text-center py-8 text-gray-500">No audit history found. Run an audit to get started.</div>
          ) : (
            <div className="space-y-3">
              {history.map(item => (
                <div key={item._id} className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                  <button
                    onClick={() => setExpandedHistoryId(expandedHistoryId === item._id ? null : item._id)}
                    className="w-full p-4 flex items-center justify-between hover:bg-gray-50"
                  >
                    <div className="flex items-center gap-4">
                      <div className={`text-xl font-bold ${getScoreColor(item.score)}`}>{item.score}</div>
                      <div className="text-left">
                        <div className="text-sm font-medium text-gray-900">
                          {item.workOrderNumber ? `WO# ${item.workOrderNumber}` : item.workOrderId || "Manual Audit"}
                        </div>
                        <div className="text-xs text-gray-500">
                          {new Date(item.createdAt).toLocaleDateString()} &middot; {item.lineItemCount} items &middot; {item.findingCount} findings
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {item.report.summary.critical > 0 && (
                        <span className="text-xs px-2 py-0.5 bg-red-100 text-red-700 rounded-full">{item.report.summary.critical} critical</span>
                      )}
                      {item.report.summary.warnings > 0 && (
                        <span className="text-xs px-2 py-0.5 bg-amber-100 text-amber-700 rounded-full">{item.report.summary.warnings} warnings</span>
                      )}
                      <svg
                        className={`w-4 h-4 text-gray-400 transition-transform ${expandedHistoryId === item._id ? "rotate-180" : ""}`}
                        fill="none" viewBox="0 0 24 24" stroke="currentColor"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </div>
                  </button>
                  {expandedHistoryId === item._id && item.report.findings.length > 0 && (
                    <div className="border-t border-gray-200 p-4 space-y-2">
                      {item.report.findings.map(finding => {
                        const colors = severityColors[finding.severity];
                        return (
                          <div key={finding.id} className={`rounded-lg border p-3 ${colors.bg} ${colors.border}`}>
                            <div className="flex items-center gap-2 mb-1">
                              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${colors.badge}`}>
                                {finding.severity.toUpperCase()}
                              </span>
                              <span className="text-xs text-gray-500">{finding.category}</span>
                            </div>
                            <h4 className={`text-sm font-semibold ${colors.text}`}>{finding.title}</h4>
                            <p className="text-xs text-gray-600 mt-1">{finding.description}</p>
                            {finding.suggestedJobTitle && (
                              <button
                                onClick={() => {
                                  setJobBuilderQuery(finding.suggestedJobTitle || "");
                                  setActiveTab("builder");
                                }}
                                className="mt-2 px-2 py-1 text-xs font-medium bg-white border border-gray-300 rounded hover:bg-gray-50"
                              >
                                + Build Estimate
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
