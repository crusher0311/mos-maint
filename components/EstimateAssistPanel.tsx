"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { resolvePrefill } from "@/lib/estimate-assist-prefill";

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

interface AuditVehicleMetadata {
  vin?: string;
  year?: number;
  make?: string;
  model?: string;
}

interface AuditReport {
  workOrderId?: string;
  workOrderNumber?: string;
  provider?: string;
  smsWorkOrderId?: string;
  vehicleDisplay?: string;
  /** Added to new reports; old saved audits may not carry this metadata. */
  vehicle?: AuditVehicleMetadata;
  auditDate: string;
  findings: AuditFinding[];
  /** Task #1145: outcome of the VHI-plan comparison (missing on old audits). */
  vhiComparison?: {
    status: "compared" | "skipped";
    reason?: string;
    missingCount?: number;
  };
  summary: {
    totalFindings: number;
    critical: number;
    warnings: number;
    info: number;
    score: number;
  };
}

/**
 * Resolver candidates intentionally accept a few source-adapter shapes. The
 * resolver is shared by provider adapters, while this client only needs to
 * render the common preview contract and preserve the returned lines.
 */
type RecommendationCandidate = {
  [key: string]: any;
  id?: string | number;
  jobId?: string | number;
  title?: string;
  name?: string;
  lines?: Array<Record<string, unknown>>;
  laborLines?: Array<Record<string, unknown>>;
  partsLines?: Array<Record<string, unknown>>;
  source?: string | Record<string, unknown>;
  sourceType?: string;
  sourceLabel?: string;
  warnings?: string[];
  vehicleRelevance?: string | number | boolean;
  relevance?: string | number | boolean;
};

interface RecommendationResolution {
  status: string;
  candidates: RecommendationCandidate[];
  warnings: string[];
}

interface RecommendationState extends RecommendationResolution {
  loading?: boolean;
  error?: string;
  selectedCandidateId?: string;
  confirmedCandidateId?: string;
  fallbackUsed?: boolean;
  previewingCandidateId?: string;
  selectedCandidateUnusable?: boolean;
}

interface PreviewRequestToken {
  generation: number;
  candidateId: string;
  requestId: number;
}

function candidateId(candidate: RecommendationCandidate, index = 0): string {
  const sourceId = candidate.source && typeof candidate.source === "object"
    ? candidate.source.id
    : undefined;
  return String(
    candidate.id ??
    candidate.jobId ??
    candidate.sourceId ??
    candidate.sourceIdentity?.id ??
    sourceId ??
    `candidate-${index}`,
  );
}

function candidateTitle(candidate: RecommendationCandidate): string {
  return String(candidate.title ?? candidate.name ?? candidate.job?.title ?? "Untitled job");
}

function candidateSourceLabel(candidate: RecommendationCandidate): string {
  const source = candidate.source;
  if (typeof source === "string" && source.trim()) return source;
  if (source && typeof source === "object") {
    const kind = String(source.kind ?? source.type ?? "").toLowerCase();
    const base = source.label ?? source.name ?? source.listSource ??
      (kind === "canned" ? "Canned job" : kind === "history" ? "Shop history" : source.source);
    const workOrder = source.workOrderNumber ?? source.workOrderId;
    return String(base || "Existing job") + (workOrder ? ` (RO ${workOrder})` : "");
  }
  return String(candidate.sourceLabel ?? candidate.sourceType ?? "Existing job");
}

function candidateTotal(candidate: RecommendationCandidate): unknown {
  const explicit = candidate.total ??
    candidate.totalPrice ??
    candidate.price ??
    candidate.pricing?.total ??
    candidate.pricing?.totalPrice;
  if (explicit != null) return explicit;
  const lineTotals = candidateLines(candidate)
    .map(line => toNumber(line.extendedPrice ?? line.total ?? line.amount))
    .filter((value): value is number => value != null);
  return lineTotals.length > 0 ? lineTotals.reduce((sum, value) => sum + value, 0) : null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function formatMoney(value: unknown): string {
  const amount = toNumber(value);
  return amount == null ? "Price unavailable" : `$${amount.toFixed(2)}`;
}

function warningText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const warning = value as Record<string, unknown>;
    return String(warning.message ?? warning.code ?? JSON.stringify(value));
  }
  return String(value ?? "Review warning");
}

function relevanceText(value: unknown): string {
  if (!value || typeof value !== "object") return String(value ?? "");
  const relevance = value as Record<string, unknown>;
  const labels = [relevance.band, relevance.vehicleMatch, relevance.reason]
    .filter(Boolean)
    .map(String);
  return labels.join(" — ") || JSON.stringify(value);
}

function candidateLines(candidate: RecommendationCandidate): Array<Record<string, unknown>> {
  const direct = candidate.lines ?? candidate.lineItems ?? candidate.servicePackageLines ?? candidate.job?.lines;
  if (Array.isArray(direct)) return direct.filter(Boolean);
  const labor = Array.isArray(candidate.laborLines)
    ? candidate.laborLines.map(line => ({ ...line, lineType: line.lineType ?? "labor" }))
    : [];
  const parts = Array.isArray(candidate.partsLines)
    ? candidate.partsLines.map(line => ({ ...line, lineType: line.lineType ?? "part" }))
    : [];
  return [...labor, ...parts];
}

function lineDescription(line: Record<string, unknown>): string {
  return String(line.description ?? line.name ?? line.title ?? "Line item");
}

function linePrice(line: Record<string, unknown>): unknown {
  return line.extendedPrice ?? line.total ?? line.amount ?? line.price ?? line.unitPrice;
}

function lineIsIncomplete(line: Record<string, unknown>): boolean {
  const quantity = toNumber(line.quantity ?? line.hours ?? 1);
  const price = linePrice(line);
  const lineType = String(line.lineType ?? line.type ?? "").toLowerCase();
  return !lineDescription(line).trim() || quantity == null || (lineType !== "labor" && toNumber(price) == null);
}

function resolutionStatus(status: unknown): string {
  return String(status || "unavailable").toLowerCase().replace(/[\s-]+/g, "_");
}

function resolutionHasCandidates(state?: RecommendationState): boolean {
  return Boolean(state?.candidates?.length);
}

interface WorkOrderPickerItem {
  id: string;
  workOrderNumber: string;
  status: string | null;
  vin: string | null;
  vehicle: { year: number | null; make: string | null; model: string | null };
  customerName: string | null;
  updatedAt: string | null;
  closedAt: string | null;
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

export interface EstimateAssistPanelProps {
  /**
   * Auto-run an audit for this id on mount (normalized `_id`, RO number, or
   * provider source id). Used by the dashboard modal and ?wo= deep links.
   */
  initialWorkOrderId?: string;
  /** Human-facing RO number to show in the input when initialWorkOrderId is an opaque id. */
  initialRoDisplay?: string;
  /** Prefill the Smart Job Builder VIN field. */
  initialVin?: string;
  /** Embedded (modal) mode: hide the page header and outer width constraints. */
  embedded?: boolean;
}

export default function EstimateAssistPanel({
  initialWorkOrderId,
  initialRoDisplay,
  initialVin,
  embedded = false,
}: EstimateAssistPanelProps = {}) {
  const [workOrderId, setWorkOrderId] = useState("");
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<AuditReport | null>(null);
  const [error, setError] = useState("");
  const [severityFilter, setSeverityFilter] = useState<string>("all");
  const [history, setHistory] = useState<AuditHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
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
  // Push-to-RO: the audit report carries the provider + the SMS's own RO id,
  // and /api/jobs/add-to-ro does the write (Protractor) or returns a guided
  // hand-off deep link (Tekmetric — its API can't create arbitrary jobs).
  const [pushingFindingId, setPushingFindingId] = useState<string | null>(null);
  const [pushedFindings, setPushedFindings] = useState<Record<string, boolean>>({});
  // Tekmetric hand-off: RO deep link per finding once opened (Task #978).
  const [handoffFindings, setHandoffFindings] = useState<Record<string, string>>({});
  // Push state for the Smart Job Builder result (same write path as findings).
  const [pushingBuilder, setPushingBuilder] = useState(false);
  const [pushedBuilder, setPushedBuilder] = useState(false);
  const [builderHandoffUrl, setBuilderHandoffUrl] = useState("");
  const [pushBuilderError, setPushBuilderError] = useState("");
  const [pushErrors, setPushErrors] = useState<Record<string, string>>({});
  const [jobBuilderError, setJobBuilderError] = useState("");
  // Recommendation resolution is deliberately separate from the generated
  // builder state. A report may have several actionable findings, and a
  // resolver response must never make a previous report's selection/push
  // state look confirmed on the new report.
  const [recommendationStates, setRecommendationStates] = useState<Record<string, RecommendationState>>({});
  const [selectedRecommendationCandidates, setSelectedRecommendationCandidates] =
    useState<Record<string, RecommendationCandidate>>({});
  const reportGeneration = useRef(0);
  const previewRequestSequence = useRef(0);
  const previewRequests = useRef<Record<string, PreviewRequestToken>>({});
  // null = still checking; fail open on transient errors so a hiccup in the
  // features API never locks a paying shop out of the page.
  const [featureAllowed, setFeatureAllowed] = useState<boolean | null>(null);
  // Work order picker (Task #833): search/browse synced ROs instead of
  // typing an id blind. Results come from /api/estimate-assist/work-orders,
  // which reads the same collection the audit resolves against.
  const [pickerResults, setPickerResults] = useState<WorkOrderPickerItem[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerLoading, setPickerLoading] = useState(false);
  const pickerFetchSeq = useRef(0);
  const pickerDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pickerContainerRef = useRef<HTMLDivElement | null>(null);

  const fetchPickerResults = useCallback((query: string) => {
    const seq = ++pickerFetchSeq.current;
    setPickerLoading(true);
    const params = new URLSearchParams({ limit: "15" });
    if (query.trim()) params.set("q", query.trim());
    fetch(`/api/estimate-assist/work-orders?${params}`)
      .then(res => res.json())
      .then(data => {
        if (seq !== pickerFetchSeq.current) return; // stale response
        if (data.ok && Array.isArray(data.workOrders)) {
          setPickerResults(data.workOrders);
        }
      })
      .catch(() => { /* picker is best-effort; manual entry still works */ })
      .finally(() => {
        if (seq === pickerFetchSeq.current) setPickerLoading(false);
      });
  }, []);

  // Debounced search as the user types (only while the dropdown is open).
  useEffect(() => {
    if (!pickerOpen) return;
    if (pickerDebounce.current) clearTimeout(pickerDebounce.current);
    pickerDebounce.current = setTimeout(() => fetchPickerResults(workOrderId), 250);
    return () => {
      if (pickerDebounce.current) clearTimeout(pickerDebounce.current);
    };
  }, [workOrderId, pickerOpen, fetchPickerResults]);

  // Close the dropdown on any click outside the picker.
  useEffect(() => {
    if (!pickerOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (pickerContainerRef.current && !pickerContainerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [pickerOpen]);

  // Prefill support: the estimate-audit page passes ?wo=/?workOrderId= deep
  // link values through these props; the dashboard's Estimate Assist modal
  // passes the row's normalized id + vehicle context directly.
  useEffect(() => {
    if (initialVin) setJobBuilderVin(String(initialVin));
    // Coerce defensively: dashboard rows can carry RO numbers as numbers
    // (Task #979 — shared logic in lib/estimate-assist-prefill.ts).
    const { auditId, inputDisplay } = resolvePrefill(initialWorkOrderId, initialRoDisplay);
    if (auditId) {
      setActiveTab("audit");
      setWorkOrderId(inputDisplay);
      runAudit(auditId);
    }
    // Run once on mount only — deliberately not reactive to state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/shop/features")
      .then(res => (res.ok ? res.json() : null))
      .then(data => {
        if (cancelled) return;
        if (data && Array.isArray(data.enabledFeatureIds)) {
          setFeatureAllowed(data.enabledFeatureIds.includes("estimate_assist"));
        } else {
          setFeatureAllowed(true);
        }
      })
      .catch(() => {
        if (!cancelled) setFeatureAllowed(true);
      });
    return () => { cancelled = true; };
  }, []);

  // offset > 0 appends (load more); offset 0 replaces (initial load / filter).
  const loadHistory = useCallback(async (offset = 0) => {
    if (offset === 0) setHistoryLoading(true);
    else setHistoryLoadingMore(true);
    try {
      const params = new URLSearchParams({ limit: "20", offset: String(offset) });
      if (historyStartDate) params.set("startDate", historyStartDate);
      if (historyEndDate) params.set("endDate", historyEndDate);
      if (historySeverityFilter !== "all") params.set("severity", historySeverityFilter);

      const response = await fetch(`/api/estimate-assist/audit/history?${params}`);
      const data = await response.json();
      if (data.ok) {
        const audits: AuditHistoryItem[] = data.audits || [];
        if (offset === 0) {
          setHistory(audits);
        } else {
          // Dedupe on _id in case a new audit shifted the pages between requests.
          setHistory(prev => {
            const seen = new Set(prev.map(a => a._id));
            return [...prev, ...audits.filter(a => !seen.has(a._id))];
          });
        }
        setHistoryTotal(data.totalCount || 0);
      }
    } catch (err) {
      console.error("Failed to load audit history:", err);
    } finally {
      if (offset === 0) setHistoryLoading(false);
      else setHistoryLoadingMore(false);
    }
  }, [historyStartDate, historyEndDate, historySeverityFilter]);

  useEffect(() => {
    if (activeTab === "history") {
      loadHistory();
    }
  }, [activeTab, loadHistory]);

  const resetRecommendationState = () => {
    // Invalidate in-flight resolver/builder responses from the previous
    // report before clearing visible state.
    reportGeneration.current += 1;
    previewRequests.current = {};
    setRecommendationStates({});
    setSelectedRecommendationCandidates({});
    setBuiltEstimates({});
    setBuildingFindingId(null);
    setPushingFindingId(null);
    setPushedFindings({});
    setHandoffFindings({});
    setPushErrors({});
  };

  const resetReportState = () => {
    resetRecommendationState();
    setPushedBuilder(false);
    setBuilderHandoffUrl("");
    setPushBuilderError("");
    setJobBuilderResult(null);
    setJobBuilderError("");
    setReport(null);
  };

  // idOverride lets the picker audit by the normalized _id (exact match)
  // while the input keeps showing the human-facing RO number.
  const runAudit = async (idOverride?: string) => {
    const auditId = String(idOverride ?? workOrderId ?? "").trim();
    if (!auditId) {
      setError("Please enter a work order number or ID");
      return;
    }
    setPickerOpen(false);
    setLoading(true);
    setError("");
    resetReportState();
    // resetReportState invalidates all in-flight recommendation work. Capture
    // the new generation so an older audit response cannot replace this
    // report (or clear this request's loading/error state).
    const generation = reportGeneration.current;
    try {
      const response = await fetch("/api/estimate-assist/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workOrderId: auditId }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        throw new Error(data.error || "Audit failed");
      }
      if (generation !== reportGeneration.current) return;
      setReport(data.report);
    } catch (err: unknown) {
      if (generation !== reportGeneration.current) return;
      const message = err instanceof Error ? err.message : "Audit failed";
      setError(message);
    } finally {
      if (generation === reportGeneration.current) setLoading(false);
    }
  };

  const runJobBuilder = async (queryOverride?: string) => {
    const query = String(queryOverride ?? jobBuilderQuery ?? "").trim();
    if (!query) return;
    // A new build is a new package — clear the previous push state.
    setPushedBuilder(false);
    setBuilderHandoffUrl("");
    setPushBuilderError("");
    setJobBuilderLoading(true);
    setJobBuilderResult(null);
    setJobBuilderError("");
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
      } else {
        setJobBuilderError(data.error || "Failed to build the estimate. Please try again.");
      }
    } catch (err) {
      console.error("Job builder failed:", err);
      setJobBuilderError("Failed to build the estimate. Please check your connection and try again.");
    }
    setJobBuilderLoading(false);
  };

  const vehicleForReport = (reportForFinding?: AuditReport | null) => ({
    vin: reportForFinding?.vehicle?.vin,
    year: reportForFinding?.vehicle?.year,
    make: reportForFinding?.vehicle?.make,
    model: reportForFinding?.vehicle?.model,
  });

  const resolveRecommendation = async (
    finding: AuditFinding,
    reportForFinding: AuditReport | null = report,
  ) => {
    if (!finding.suggestedJobTitle) return;
    const generation = reportGeneration.current;
    const previous = recommendationStates[finding.id];
    setRecommendationStates(prev => ({
      ...prev,
      [finding.id]: {
        status: previous?.status || "resolving",
        candidates: previous?.candidates || [],
        warnings: previous?.warnings || [],
        loading: true,
        error: "",
      },
    }));
    try {
      const response = await fetch("/api/estimate-assist/resolve-recommendation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          finding: {
            suggestedJobTitle: finding.suggestedJobTitle,
            suggestedJobId: finding.suggestedJobId,
          },
          vehicle: vehicleForReport(reportForFinding),
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok || !data.resolution) {
        throw new Error(data.error || "Existing job lookup was unavailable.");
      }
      const resolution = data.resolution as Partial<RecommendationResolution>;
      const candidates = Array.isArray(resolution.candidates) ? resolution.candidates : [];
      const warnings = Array.isArray(resolution.warnings)
        ? resolution.warnings.map(warningText)
        : [];
      if (generation !== reportGeneration.current) return;
      setRecommendationStates(prev => ({
        ...prev,
        [finding.id]: {
          status: String(resolution.status || (candidates.length ? "matched" : "no_match")),
          candidates,
          warnings,
          loading: false,
          error: "",
        },
      }));
    } catch (err: unknown) {
      if (generation !== reportGeneration.current) return;
      const message = err instanceof Error ? err.message : "Existing job lookup was unavailable.";
      setRecommendationStates(prev => ({
        ...prev,
        [finding.id]: {
          status: "unavailable",
          candidates: [],
          warnings: [],
          loading: false,
          error: message,
        },
      }));
    }
  };

  const buildGeneratedFallback = async (
    finding: AuditFinding,
    reportForFinding: AuditReport | null = report,
  ) => {
    if (!finding.suggestedJobTitle) return;
    const generation = reportGeneration.current;
    setBuildingFindingId(finding.id);
    setPushErrors(prev => ({ ...prev, [finding.id]: "" }));
    try {
      const vehicle = vehicleForReport(reportForFinding);
      const response = await fetch("/api/estimate-assist/job-builder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobNameOrId: finding.suggestedJobTitle,
          vin: vehicle.vin || undefined,
          year: vehicle.year,
          make: vehicle.make,
          model: vehicle.model,
          languageMode,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok || !data.estimate) {
        throw new Error(data.error || `Couldn't build "${finding.suggestedJobTitle}".`);
      }
      if (generation !== reportGeneration.current) return;
      setBuiltEstimates(prev => ({
        ...prev,
        [finding.id]: {
          ...data.estimate,
          source: "generated_fallback",
          sourceLabel: "Generated estimate fallback",
          fallbackReason: recommendationStates[finding.id]?.status || "no_match",
        },
      }));
      setRecommendationStates(prev => ({
        ...prev,
        [finding.id]: {
          ...(prev[finding.id] || { status: "no_match", candidates: [], warnings: [] }),
          fallbackUsed: true,
          loading: false,
        },
      }));
    } catch (err: unknown) {
      if (generation !== reportGeneration.current) return;
      const message = err instanceof Error ? err.message : "Generated fallback failed.";
      setRecommendationStates(prev => ({
        ...prev,
        [finding.id]: {
          ...(prev[finding.id] || { status: "unavailable", candidates: [], warnings: [] }),
          loading: false,
          error: message,
        },
      }));
    } finally {
      if (generation === reportGeneration.current) setBuildingFindingId(null);
    }
  };

  const confirmRecommendation = (finding: AuditFinding) => {
    const state = recommendationStates[finding.id];
    if (!state?.selectedCandidateId) return;
    const selected = state.candidates.find(
      (candidate, index) => candidateId(candidate, index) === state.selectedCandidateId,
    );
    if (!selected) return;
    const lines = candidateLines(selected);
    if (lines.length === 0) {
      setRecommendationStates(prev => ({
        ...prev,
        [finding.id]: {
          ...state,
          selectedCandidateUnusable: true,
          error: "This existing job has no usable line details. Use the generated estimate fallback instead.",
        },
      }));
      return;
    }
    const incomplete = lines.some(lineIsIncomplete);
    const source = candidateSourceLabel(selected);
    const estimate = {
      ...selected,
      title: candidateTitle(selected),
      description: selected.description ?? selected.customerDescription ?? selected.note ?? "",
      lines,
      // Keep the opaque resolver identity intact for server-side
      // revalidation; sourceLabel is display-only.
      source: selected.source,
      sourceIdentity: selected.sourceIdentity ?? selected.source,
      sourceLabel: `Existing job — ${source}`,
      sourceCandidateId: state.selectedCandidateId,
      incompleteLines: incomplete,
      laborHours: selected.laborHours,
      requiredParts: selected.requiredParts,
    };
    setSelectedRecommendationCandidates(prev => ({ ...prev, [finding.id]: selected }));
    setBuiltEstimates(prev => ({ ...prev, [finding.id]: estimate }));
    setRecommendationStates(prev => ({
      ...prev,
      [finding.id]: {
        ...state,
        confirmedCandidateId: state.selectedCandidateId,
        error: incomplete
          ? "This package has incomplete line pricing. Review the highlighted lines before adding it to the RO."
          : "",
      },
    }));
  };

  // Backwards-compatible name for callers within this panel: clicking
  // "+ Add to Estimate" now always reviews existing jobs first.
  const addToEstimate = (finding: AuditFinding) => resolveRecommendation(finding);

  /**
   * A compact canned/history result may only contain source identity. Once a
   * user selects it, ask the resolver to hydrate that one item rather than
   * pretending the list row is an estimate. The server re-checks ownership
   * and returns the current detail; the browser never supplies authoritative
   * lines or prices.
   */
  const previewRecommendation = async (
    finding: AuditFinding,
    candidate: RecommendationCandidate,
    candidateIndex: number,
    requestId: number,
  ) => {
    const source =
      candidate.sourceIdentity && typeof candidate.sourceIdentity === "object"
        ? candidate.sourceIdentity
        : candidate.source && typeof candidate.source === "object"
          ? candidate.source
          : null;
    const selectedId = candidateId(candidate, candidateIndex);
    const generation = reportGeneration.current;
    const isCurrentPreview = () => {
      const current = previewRequests.current[finding.id];
      return generation === reportGeneration.current &&
        current?.generation === generation &&
        current.candidateId === selectedId &&
        current.requestId === requestId;
    };
    if (!source) {
      if (!isCurrentPreview()) return;
      setRecommendationStates(prev => ({
        ...prev,
        [finding.id]: {
          ...(prev[finding.id] || { status: "candidates", candidates: [], warnings: [] }),
          selectedCandidateId: selectedId,
          previewingCandidateId: undefined,
          selectedCandidateUnusable: true,
          error: "This candidate has no revalidation source identity. Use the generated estimate fallback instead.",
        },
      }));
      return;
    }

    setRecommendationStates(prev => ({
      ...prev,
      [finding.id]: {
        ...(prev[finding.id] || { status: "candidates", candidates: [], warnings: [] }),
        selectedCandidateId: selectedId,
        previewingCandidateId: selectedId,
        selectedCandidateUnusable: false,
        error: "",
      },
    }));

    try {
      const response = await fetch("/api/estimate-assist/resolve-recommendation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "preview",
          finding: {
            suggestedJobTitle: finding.suggestedJobTitle,
            suggestedJobId: finding.suggestedJobId,
          },
          vehicle: vehicleForReport(report),
          selection: { source },
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok || !data.resolution) {
        throw new Error(data.error || "Selected job details are unavailable.");
      }
      if (!isCurrentPreview()) return;

      const resolution = data.resolution as Partial<RecommendationResolution> & {
        candidate?: RecommendationCandidate;
      };
      const hydrated = Array.isArray(resolution.candidates)
        ? resolution.candidates[0]
        : resolution.candidate;
      if (!hydrated) {
        const warning = Array.isArray(resolution.warnings)
          ? resolution.warnings.map(warningText).join(" ")
          : "";
        throw new Error(warning || "Selected job details are unavailable.");
      }

      setRecommendationStates(prev => {
        if (!isCurrentPreview()) return prev;
        const current = prev[finding.id] || {
          status: "candidates",
          candidates: [],
          warnings: [],
        };
        const candidates = current.candidates.map((existing, index) =>
          candidateId(existing, index) === selectedId
            ? {
                ...hydrated,
                // Keep the client selection key stable even if the preview
                // response omits its display-only id.
                id: hydrated.id ?? selectedId,
                source: hydrated.source ?? source,
                sourceIdentity: hydrated.sourceIdentity ?? source,
              }
            : existing,
        );
        const hasLines = candidateLines(hydrated).length > 0;
        return {
          ...prev,
          [finding.id]: {
            ...current,
            candidates,
            warnings: Array.isArray(resolution.warnings)
              ? resolution.warnings.map(warningText)
              : current.warnings,
            previewingCandidateId: undefined,
            selectedCandidateUnusable: !hasLines,
            error: hasLines
              ? ""
              : "Selected job details are still missing usable lines. Use the generated estimate fallback instead.",
          },
        };
      });
    } catch (err: unknown) {
      if (!isCurrentPreview()) return;
      const message = err instanceof Error ? err.message : "Selected job details are unavailable.";
      setRecommendationStates(prev => ({
        ...prev,
        [finding.id]: {
          ...(prev[finding.id] || { status: "candidates", candidates: [], warnings: [] }),
          previewingCandidateId: undefined,
          selectedCandidateUnusable: true,
          error: `${message} Use the generated estimate fallback instead.`,
        },
      }));
    }
  };

  const selectRecommendationCandidate = (
    finding: AuditFinding,
    candidate: RecommendationCandidate,
    candidateIndex: number,
  ) => {
    const selectedId = candidateId(candidate, candidateIndex);
    const generation = reportGeneration.current;
    const requestId = ++previewRequestSequence.current;
    previewRequests.current[finding.id] = {
      generation,
      candidateId: selectedId,
      requestId,
    };
    setRecommendationStates(prev => ({
      ...prev,
      [finding.id]: {
        ...(prev[finding.id] || { status: "candidates", candidates: [], warnings: [] }),
        selectedCandidateId: selectedId,
        previewingCandidateId: undefined,
        selectedCandidateUnusable: false,
        error: "",
      },
    }));
    if (candidateLines(candidate).length === 0) {
      void previewRecommendation(finding, candidate, candidateIndex, requestId);
    }
  };

  // Push a built estimate onto the audited RO.
  // - Protractor: server-side write via /api/jobs/add-to-ro. Labor is priced
  //   by the route's labor-rate chain; parts go in at $0 so the shop sets
  //   real pricing in the SMS.
  // - Tekmetric (Task #978): the same route verifies the RO is still open
  //   (posted ROs reject adds) and returns a deep link; we open the RO in
  //   Tekmetric so the user adds the built package there.
  const pushProvider: "protractor" | "tekmetric" | null =
    report?.provider === "protractor" &&
    !!report?.smsWorkOrderId &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(report.smsWorkOrderId)
      ? "protractor"
      : report?.provider === "tekmetric" &&
          !!report?.smsWorkOrderId &&
          /^\d+$/.test(report.smsWorkOrderId)
        ? "tekmetric"
        : null;
  const canPushToRo = pushProvider !== null;

  const pushLinesForEstimate = (be: Record<string, unknown>, finding: AuditFinding) => {
    // Resolver-selected packages keep their source lines and prices. Do not
    // rebuild them from the knowledge base (which would lose historical
    // source identity and silently turn priced lines into generic $0 parts).
    if (String(be.sourceCandidateId || "") && Array.isArray(be.lines)) {
      return (be.lines as Array<Record<string, unknown>>).map(line => {
        const rawType = String(line.lineType ?? line.type ?? "part").toLowerCase();
        const lineType = rawType.includes("labor") ? "labor" : rawType.includes("sublet") ? "sublet" : "part";
        const quantity = toNumber(line.quantity ?? line.hours ?? 1) ?? 1;
        const price = toNumber(line.unitPrice ?? line.price ?? line.amount ?? 0) ?? 0;
        const extendedPrice = toNumber(line.extendedPrice ?? line.total ?? line.amount) ?? price * quantity;
        return {
          lineType,
          description: lineDescription(line),
          quantity,
          unitPrice: price,
          extendedPrice,
          ...(line.partNumber ? { partNumber: String(line.partNumber) } : {}),
          ...(line.manufacturer ? { manufacturer: String(line.manufacturer) } : {}),
          ...(line.cost != null ? { cost: toNumber(line.cost) ?? undefined } : {}),
          ...(line.extendedCost != null ? { extendedCost: toNumber(line.extendedCost) ?? undefined } : {}),
        };
      });
    }
    const lh = be.laborHours as Record<string, unknown> | undefined;
    const laborHours = Number(lh?.recommended) || Number(lh?.typical) || Number(lh?.min) || 1;
    const requiredParts = Array.isArray(be.requiredParts) ? (be.requiredParts as string[]) : [];
    return [
      {
        lineType: "labor",
        description: String(be.title || finding.suggestedJobTitle || "Labor"),
        quantity: laborHours,
        unitPrice: 0,
        extendedPrice: 0,
      },
      ...requiredParts.map(part => ({
        lineType: "part",
        description: part,
        quantity: 1,
        unitPrice: 0,
        extendedPrice: 0,
      })),
    ];
  };

  const pushToRo = async (finding: AuditFinding) => {
    const be = builtEstimates[finding.id];
    if (!be || !report?.smsWorkOrderId) return;
    const lines = pushLinesForEstimate(be, finding);
    if (Boolean(be.sourceCandidateId) && (Boolean(be.incompleteLines) || lines.some(line => lineIsIncomplete(line)))) {
      setPushErrors(prev => ({
        ...prev,
        [finding.id]: "This selected existing job has incomplete line pricing. Review the candidate before adding it to the RO.",
      }));
      return;
    }
    setPushingFindingId(finding.id);
    setPushErrors(prev => ({ ...prev, [finding.id]: "" }));
    try {
      const sourceObject = be.sourceIdentity && typeof be.sourceIdentity === "object"
        ? be.sourceIdentity as Record<string, unknown>
        : be.source && typeof be.source === "object"
          ? be.source as Record<string, unknown>
          : null;
      const sourceText = String(sourceObject?.kind || be.source || "").toLowerCase();
      const source = sourceText.includes("canned")
        ? "canned"
        : sourceText.includes("history") || sourceText.includes("existing")
          ? "lookup"
          : "lookup";
      const response = await fetch("/api/jobs/add-to-ro", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workOrderGuid: report.smsWorkOrderId,
          job: {
            title: String(be.title || finding.suggestedJobTitle || ""),
            description: String(be.customerDescription || be.description || ""),
            code: be.code ? String(be.code) : undefined,
            lines,
          },
          // The existing add workflow remains the only provider write path.
          // Keep source identity and audited vehicle metadata beside it for
          // provider analytics and for the historical/canned distinction.
          source,
          ...(be.sourceCandidateId && sourceObject
            ? { auditSelection: { source: sourceObject } }
            : {}),
          vehicle: vehicleForReport(report),
        }),
      });
      const data = await response.json();
      if (response.ok && !data.error) {
        if (data.mode === "handoff" && data.openUrl) {
          // Tekmetric hand-off: the RO is open — jump straight to it.
          window.open(String(data.openUrl), "_blank", "noopener");
          setHandoffFindings(prev => ({ ...prev, [finding.id]: String(data.openUrl) }));
        } else {
          setPushedFindings(prev => ({ ...prev, [finding.id]: true }));
        }
      } else {
        setPushErrors(prev => ({ ...prev, [finding.id]: data.error || "Couldn't add the job to the work order." }));
      }
    } catch {
      setPushErrors(prev => ({ ...prev, [finding.id]: "Couldn't add the job to the work order. Check your connection and try again." }));
    }
    setPushingFindingId(null);
  };

  // Push the Smart Job Builder's built package onto the audited RO. Uses the
  // same add-to-RO write path (labor priced by the route's labor-rate chain,
  // parts at $0 so the shop sets real pricing in the SMS).
  const pushBuilderToRo = async () => {
    const be = jobBuilderResult;
    if (!be || !report?.smsWorkOrderId) return;
    setPushingBuilder(true);
    setPushBuilderError("");
    try {
      const lh = be.laborHours as Record<string, unknown> | undefined;
      const laborHours = Number(lh?.recommended) || Number(lh?.typical) || Number(lh?.min) || 1;
      const requiredParts = Array.isArray(be.requiredParts) ? (be.requiredParts as string[]) : [];
      const lines = [
        {
          lineType: "labor",
          description: String(be.title || jobBuilderQuery || "Labor"),
          quantity: laborHours,
          unitPrice: 0,
          extendedPrice: 0,
        },
        ...requiredParts.map(part => ({
          lineType: "part",
          description: part,
          quantity: 1,
          unitPrice: 0,
          extendedPrice: 0,
        })),
      ];
      const response = await fetch("/api/jobs/add-to-ro", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workOrderGuid: report.smsWorkOrderId,
          job: {
            title: String(be.title || jobBuilderQuery || ""),
            description: String(be.customerDescription || be.technicalDescription || ""),
            lines,
          },
          source: be.source === "generated_fallback" ? "lookup" : undefined,
          vehicle: vehicleForReport(report),
        }),
      });
      const data = await response.json();
      if (response.ok && !data.error) {
        if (data.mode === "handoff" && data.openUrl) {
          // Tekmetric hand-off: the RO is open — jump straight to it.
          window.open(String(data.openUrl), "_blank", "noopener");
          setBuilderHandoffUrl(String(data.openUrl));
        } else {
          setPushedBuilder(true);
        }
      } else {
        setPushBuilderError(data.error || "Couldn't add the job to the work order.");
      }
    } catch {
      setPushBuilderError("Couldn't add the job to the work order. Check your connection and try again.");
    }
    setPushingBuilder(false);
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

  const containerClass = embedded ? "p-1" : "max-w-6xl mx-auto p-6";

  if (featureAllowed === null) {
    return (
      <div className={containerClass}>
        <div className="flex items-center justify-center py-24 text-gray-400 text-sm">
          Loading…
        </div>
      </div>
    );
  }

  if (featureAllowed === false) {
    return (
      <div className={containerClass}>
        <div className="max-w-lg mx-auto mt-16 bg-white rounded-lg border border-gray-200 p-10 text-center">
          <div className="mx-auto mb-4 w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center">
            <svg className="w-6 h-6 text-gray-500" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-gray-900">Estimate Assist</h1>
          <p className="text-gray-600 mt-2">
            This feature is not included in your current subscription.
          </p>
          <p className="text-gray-500 text-sm mt-1">
            Upgrade your plan to build smart estimates and audit work orders for completeness.
          </p>
          <p className="text-gray-500 text-sm mt-6">
            Contact support at{" "}
            <a href="mailto:support@myoilsticker.com" className="text-blue-600 underline hover:text-blue-700">
              support@myoilsticker.com
            </a>{" "}
            to change your plan.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={containerClass}>
      {!embedded && (
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Estimate Assist</h1>
          <p className="text-gray-500 mt-1">Build accurate estimates and audit existing work orders for completeness</p>
        </div>
      )}

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
              <div className="flex-1 relative" ref={pickerContainerRef}>
                <input
                  type="text"
                  value={workOrderId}
                  onChange={(e) => {
                    setWorkOrderId(e.target.value);
                    setPickerOpen(true);
                  }}
                  onFocus={() => setPickerOpen(true)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") runAudit();
                    if (e.key === "Escape") setPickerOpen(false);
                  }}
                  placeholder="Search by RO number, customer, or vehicle — or type an RO number..."
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
                {pickerOpen && (
                  <div className="absolute z-20 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-80 overflow-y-auto">
                    <div className="px-3 py-2 text-xs text-gray-400 border-b border-gray-100 flex items-center justify-between">
                      <span>{workOrderId.trim() ? "Matching work orders" : "Recent work orders"}</span>
                      {pickerLoading && <span>Searching…</span>}
                    </div>
                    {pickerResults.length === 0 && !pickerLoading ? (
                      <div className="px-3 py-4 text-sm text-gray-500 text-center">
                        {workOrderId.trim()
                          ? "No synced work orders match. You can still press Enter to try the exact RO number."
                          : "No synced work orders yet."}
                      </div>
                    ) : (
                      pickerResults.map(wo => {
                        const vehicle = [wo.vehicle.year, wo.vehicle.make, wo.vehicle.model].filter(Boolean).join(" ");
                        const when = wo.closedAt || wo.updatedAt;
                        return (
                          <button
                            key={wo.id}
                            onClick={() => {
                              setWorkOrderId(wo.workOrderNumber || wo.id);
                              setPickerOpen(false);
                              runAudit(wo.id);
                            }}
                            className="w-full px-3 py-2.5 flex items-center justify-between gap-3 text-left hover:bg-blue-50 border-b border-gray-50 last:border-b-0"
                          >
                            <div className="min-w-0">
                              <div className="text-sm font-medium text-gray-900">
                                {wo.workOrderNumber ? `RO #${wo.workOrderNumber}` : "RO (no number)"}
                                {wo.customerName && <span className="font-normal text-gray-600"> &middot; {wo.customerName}</span>}
                              </div>
                              <div className="text-xs text-gray-500 truncate">
                                {vehicle || "Unknown vehicle"}
                                {wo.vin && <span className="text-gray-400"> &middot; {wo.vin}</span>}
                              </div>
                            </div>
                            <div className="flex flex-col items-end shrink-0">
                              {wo.status && (
                                <span className="text-xs px-2 py-0.5 bg-gray-100 text-gray-600 rounded-full">{wo.status}</span>
                              )}
                              {when && (
                                <span className="text-xs text-gray-400 mt-0.5">{new Date(when).toLocaleDateString()}</span>
                              )}
                            </div>
                          </button>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
              <button
                onClick={() => runAudit()}
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

              {(report.vehicleDisplay || report.vehicle) && (
                <div className="text-sm text-gray-500 mb-4">
                  Vehicle: <span className="font-medium text-gray-700">
                    {report.vehicleDisplay ||
                      [report.vehicle?.year, report.vehicle?.make, report.vehicle?.model].filter(Boolean).join(" ") ||
                      "Unknown vehicle"}
                  </span>
                  {report.vehicle?.vin && (
                    <> &middot; VIN <span className="font-medium text-gray-700">{report.vehicle.vin}</span></>
                  )}
                  {report.workOrderNumber && (
                    <> &middot; WO# <span className="font-medium text-gray-700">{report.workOrderNumber}</span></>
                  )}
                </div>
              )}

              {report.vhiComparison?.status === "skipped" && (
                <div className="text-xs text-gray-500 mb-4 bg-gray-50 border border-gray-200 rounded-md px-3 py-2">
                  VHI comparison skipped{report.vhiComparison.reason ? ` — ${report.vhiComparison.reason}` : ""}.
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
                              disabled={recommendationStates[finding.id]?.loading || !!builtEstimates[finding.id]}
                              className={`px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap ${
                                builtEstimates[finding.id]
                                  ? "bg-green-600 text-white cursor-default"
                                  : "bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                              }`}
                            >
                              {recommendationStates[finding.id]?.loading ? "Finding existing jobs..." :
                               builtEstimates[finding.id] ? "Added" : "+ Review matches"}
                            </button>
                            <button
                              onClick={() => {
                                setJobBuilderQuery(finding.suggestedJobTitle || "");
                                if (report.vehicle?.vin) setJobBuilderVin(report.vehicle.vin);
                                setActiveTab("builder");
                              }}
                              className="px-3 py-1.5 text-xs font-medium bg-white border border-gray-300 rounded-lg hover:bg-gray-50 whitespace-nowrap"
                            >
                              View Details
                            </button>
                          </div>
                        )}
                      </div>
                      {recommendationStates[finding.id] && !builtEstimates[finding.id] && (() => {
                        const resolution = recommendationStates[finding.id];
                        const status = resolutionStatus(resolution.status);
                        const hasCandidates = resolutionHasCandidates(resolution);
                        const selectedCandidate = resolution.candidates.find(
                          (candidate, index) =>
                            candidateId(candidate, index) === resolution.selectedCandidateId,
                        );
                        const selectedCandidateHasNoLines =
                          Boolean(selectedCandidate) && candidateLines(selectedCandidate!).length === 0;
                        const canFallback = !hasCandidates && !resolution.loading &&
                          (status === "no_match" || status === "no_suitable_match" ||
                            status === "not_found" || status === "unavailable" || status === "error" ||
                            status === "nomatch") ||
                          (!resolution.loading &&
                            !resolution.previewingCandidateId &&
                            Boolean(resolution.selectedCandidateUnusable) &&
                            selectedCandidateHasNoLines);
                        return (
                          <div className="mt-3 p-3 bg-white rounded-lg border border-blue-200" data-testid={`recommendation-review-${finding.id}`}>
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-sm font-semibold text-gray-800">Existing job review</p>
                              <span className={`text-xs px-2 py-0.5 rounded-full ${
                                status === "unavailable" ? "bg-amber-100 text-amber-800" :
                                hasCandidates ? "bg-blue-100 text-blue-800" : "bg-gray-100 text-gray-700"
                              }`}>
                                {resolution.loading ? "Checking…" :
                                 status === "unavailable" ? "Lookup unavailable" :
                                 hasCandidates ? `${resolution.candidates.length} candidate${resolution.candidates.length === 1 ? "" : "s"}` :
                                 "No suitable match"}
                              </span>
                            </div>
                            <p className="text-xs text-gray-500 mt-1">
                              Select an existing job and confirm it before it can be added. Nothing is written to the RO during lookup.
                            </p>
                            {resolution.error && (
                              <p className="text-xs text-amber-700 mt-2">{resolution.error}</p>
                            )}
                            {resolution.warnings.length > 0 && (
                              <div className="mt-2 rounded border border-amber-200 bg-amber-50 p-2">
                                <p className="text-xs font-semibold text-amber-800">Review warnings</p>
                                <ul className="mt-1 list-disc pl-4 text-xs text-amber-800 space-y-0.5">
                                  {resolution.warnings.map((warning, index) => <li key={index}>{warning}</li>)}
                                </ul>
                              </div>
                            )}
                            {hasCandidates && (
                              <div className="mt-3 space-y-2">
                                {resolution.candidates.map((candidate, index) => {
                                  const id = candidateId(candidate, index);
                                  const lines = candidateLines(candidate);
                                  const total = candidateTotal(candidate);
                                  const relevance = candidate.vehicleRelevance ?? candidate.relevance ?? candidate.vehicleMatch ?? candidate.vehicle?.relevance;
                                  const candidateWarnings = Array.isArray(candidate.warnings)
                                    ? candidate.warnings.map(warningText)
                                    : [];
                                  return (
                                    <label
                                      key={id}
                                      className={`block rounded-lg border p-3 cursor-pointer ${
                                        resolution.selectedCandidateId === id
                                          ? "border-blue-500 bg-blue-50"
                                          : "border-gray-200 hover:border-blue-300"
                                      }`}
                                    >
                                      <div className="flex items-start gap-2">
                                        <input
                                          type="radio"
                                          name={`recommendation-${finding.id}`}
                                          value={id}
                                          checked={resolution.selectedCandidateId === id}
                                          onChange={() => selectRecommendationCandidate(finding, candidate, index)}
                                          className="mt-1"
                                        />
                                        <div className="min-w-0 flex-1">
                                          <div className="flex items-start justify-between gap-2">
                                            <p className="text-sm font-semibold text-gray-900">{candidateTitle(candidate)}</p>
                                            <span className="text-xs font-medium text-gray-700 shrink-0">
                                              {formatMoney(total)}
                                            </span>
                                          </div>
                                          <p className="text-xs text-gray-500 mt-0.5">
                                            Source: <span className="font-medium text-gray-700">{candidateSourceLabel(candidate)}</span>
                                          </p>
                                          {relevance != null && (
                                            <p className="text-xs text-gray-500 mt-0.5">
                                              Vehicle relevance: <span className="font-medium text-gray-700">
                                                {relevanceText(relevance)}
                                              </span>
                                            </p>
                                          )}
                                          <div className="mt-2 border-t border-gray-100 pt-2">
                                            <p className="text-xs font-semibold text-gray-500 uppercase">Source lines</p>
                                            {lines.length > 0 ? (
                                              <ul className="mt-1 space-y-1">
                                                {lines.map((line, lineIndex) => (
                                                  <li key={lineIndex} className={`flex items-center justify-between gap-2 text-xs ${
                                                    lineIsIncomplete(line) ? "text-amber-700" : "text-gray-600"
                                                  }`}>
                                                    <span className="truncate">
                                                      {lineDescription(line)} · qty {String(line.quantity ?? line.hours ?? 1)}
                                                    </span>
                                                    <span className="shrink-0">{formatMoney(linePrice(line))}</span>
                                                  </li>
                                                ))}
                                              </ul>
                                            ) : (
                                              <p className="text-xs text-amber-700 mt-1">
                                                {resolution.previewingCandidateId === id
                                                  ? "Loading selected job details…"
                                                  : resolution.selectedCandidateUnusable && resolution.selectedCandidateId === id
                                                    ? "Selected details are unavailable — use the generated fallback below."
                                                    : "Selecting this candidate will load its current job details."}
                                              </p>
                                            )}
                                          </div>
                                          {candidateWarnings.length > 0 && (
                                            <ul className="mt-2 list-disc pl-4 text-xs text-amber-700">
                                              {candidateWarnings.map((warning, warningIndex) => <li key={warningIndex}>{warning}</li>)}
                                            </ul>
                                          )}
                                        </div>
                                      </div>
                                    </label>
                                  );
                                })}
                                <button
                                  onClick={() => confirmRecommendation(finding)}
                                  disabled={
                                    !resolution.selectedCandidateId ||
                                    Boolean(resolution.previewingCandidateId) ||
                                    selectedCandidateHasNoLines ||
                                    Boolean(resolution.selectedCandidateUnusable)
                                  }
                                  className="px-3 py-1.5 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                  Confirm selected existing job
                                </button>
                                {resolution.error && <p className="text-xs text-red-600">{resolution.error}</p>}
                              </div>
                            )}
                            {canFallback && !resolution.fallbackUsed && (
                              <div className="mt-3 border-t border-gray-100 pt-3">
                                <p className="text-xs text-gray-600">
                                  {status === "unavailable"
                                    ? "The existing-job lookup is unavailable."
                                    : "No suitable reusable job was found."}{" "}
                                  You can explicitly use the generated builder fallback; it will retain the audited vehicle context.
                                </p>
                                <button
                                  onClick={() => buildGeneratedFallback(finding)}
                                  disabled={buildingFindingId === finding.id}
                                  className="mt-2 px-3 py-1.5 text-xs font-medium bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-50"
                                >
                                  {buildingFindingId === finding.id ? "Building generated fallback…" : "Use generated estimate fallback"}
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })()}
                      {builtEstimates[finding.id] && (() => {
                        const be = builtEstimates[finding.id];
                        const lh = be.laborHours as Record<string, unknown> | undefined;
                        return (
                          <div className="mt-3 p-3 bg-white rounded-lg border border-green-200">
                            <div className="flex items-center gap-2 mb-2">
                              <span className="text-xs font-semibold text-green-700 bg-green-50 px-2 py-0.5 rounded-full">Estimate Line Item</span>
                              <span className="text-xs text-gray-400">{String(be.category || "")}</span>
                              {Boolean(be.sourceLabel) && (
                                <span className="text-xs font-medium text-blue-700 bg-blue-50 px-2 py-0.5 rounded-full">
                                  {String(be.sourceLabel)}
                                </span>
                              )}
                            </div>
                            <p className="text-sm font-semibold text-gray-900">{String(be.title || "")}</p>
                            <p className="text-xs text-gray-600 mt-1">{String(be.description || "")}</p>
                            {Array.isArray(be.lines) && (be.lines as Array<Record<string, unknown>>).length > 0 && (
                              <div className="mt-2 rounded border border-blue-100 bg-blue-50/40 p-2">
                                <p className="text-xs font-semibold text-gray-500 uppercase">Selected source lines</p>
                                <ul className="mt-1 space-y-1">
                                  {(be.lines as Array<Record<string, unknown>>).map((line, lineIndex) => (
                                    <li key={lineIndex} className={`flex items-center justify-between gap-2 text-xs ${
                                      lineIsIncomplete(line) ? "text-amber-700" : "text-gray-600"
                                    }`}>
                                      <span className="truncate">{lineDescription(line)}</span>
                                      <span className="shrink-0">{formatMoney(linePrice(line))}</span>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            {Boolean(be.incompleteLines) && (
                              <div className="mt-2">
                                <p className="text-xs text-amber-700">
                                  Some source lines are incomplete or missing prices. Review them before adding this package to the RO.
                                </p>
                                <button
                                  onClick={() => buildGeneratedFallback(finding)}
                                  disabled={buildingFindingId === finding.id}
                                  className="mt-1 px-2 py-1 text-xs font-medium bg-white border border-amber-300 text-amber-800 rounded hover:bg-amber-50 disabled:opacity-50"
                                >
                                  Use generated fallback instead
                                </button>
                              </div>
                            )}
                            <div className="flex gap-4 mt-2 text-xs text-gray-500">
                              <span>Labor: <strong className="text-gray-700">{String(lh?.typical || 0)}h</strong> ({String(lh?.min || 0)}-{String(lh?.max || 0)}h)</span>
                              {Array.isArray(be.requiredParts) && (be.requiredParts as string[]).length > 0 && (
                                <span>Parts: <strong className="text-gray-700">{(be.requiredParts as string[]).join(", ")}</strong></span>
                              )}
                            </div>
                            {canPushToRo ? (
                              <div className="mt-3 flex items-center gap-3">
                                <button
                                  onClick={() => pushToRo(finding)}
                                  disabled={pushingFindingId === finding.id || !!pushedFindings[finding.id] || Boolean(be.incompleteLines)}
                                  className={`px-3 py-1.5 text-xs font-medium rounded-lg ${
                                    pushedFindings[finding.id]
                                      ? "bg-green-600 text-white cursor-default"
                                      : "bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-50"
                                  }`}
                                >
                                  {pushingFindingId === finding.id
                                    ? (pushProvider === "tekmetric" ? "Checking RO..." : "Adding to RO...")
                                    : pushedFindings[finding.id]
                                      ? `Added to RO${report?.workOrderNumber ? ` #${report.workOrderNumber}` : ""} ✓`
                                      : pushProvider === "tekmetric"
                                        ? (handoffFindings[finding.id]
                                            ? `Reopen RO${report?.workOrderNumber ? ` #${report.workOrderNumber}` : ""} in Tekmetric ↗`
                                            : `Open RO${report?.workOrderNumber ? ` #${report.workOrderNumber}` : ""} in Tekmetric ↗`)
                                        : `Add to RO${report?.workOrderNumber ? ` #${report.workOrderNumber}` : ""}`}
                                </button>
                                {!pushedFindings[finding.id] && (
                                  <span className="text-xs text-gray-400">
                                    {pushProvider === "tekmetric"
                                      ? handoffFindings[finding.id]
                                        ? "Add this package on the RO in Tekmetric — its API doesn't allow adding jobs directly."
                                        : "Tekmetric's API doesn't allow adding jobs directly — this checks the RO is open, then opens it in Tekmetric so you can add the package there."
                                      : be.sourceCandidateId
                                        ? "Selected source lines and prices are preserved through the existing add workflow."
                                        : "Labor uses your shop rate; parts are added at $0 — set pricing in Protractor."}
                                  </span>
                                )}
                              </div>
                            ) : report?.provider && report.provider !== "protractor" ? (
                              <p className="mt-3 text-xs text-gray-400">
                                Adding this job to the RO from the dashboard is available for Protractor and Tekmetric shops. For other systems, use the MOS browser extension to push jobs.
                              </p>
                            ) : null}
                            {pushErrors[finding.id] && (
                              <p className="mt-2 text-xs text-red-600">{pushErrors[finding.id]}</p>
                            )}
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
                onClick={() => runJobBuilder()}
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
            {jobBuilderError && <p className="text-red-600 text-sm mt-3">{jobBuilderError}</p>}
          </div>

          {est && (
            <div className="space-y-4">
              <div className="bg-white rounded-lg border border-gray-200 p-6">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-medium px-2 py-0.5 bg-gray-100 text-gray-600 rounded-full">
                    {String(est.category || "")}
                  </span>
                  {Boolean(est.safetyRelated) && (
                    <span className="text-xs font-medium px-2 py-0.5 bg-red-100 text-red-600 rounded-full">
                      Safety Related
                    </span>
                  )}
                  {Boolean(est.aiEnhanced) && (
                    <span className="text-xs font-medium px-2 py-0.5 bg-purple-100 text-purple-600 rounded-full">
                      AI Enhanced
                    </span>
                  )}
                </div>
                <div className="flex items-start justify-between gap-3 mb-2">
                  <h3 className="text-lg font-bold text-gray-900">{String(est.title || "")}</h3>
                  {canPushToRo && (
                    <button
                      onClick={pushBuilderToRo}
                      disabled={pushingBuilder || pushedBuilder}
                      className={`shrink-0 px-4 py-2 text-sm font-medium rounded-lg ${
                        pushedBuilder
                          ? "bg-green-100 text-green-700 cursor-default"
                          : "bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                      }`}
                      title={
                        pushProvider === "tekmetric"
                          ? `Tekmetric's API doesn't allow adding jobs directly — this checks RO ${report?.workOrderNumber || ""} is open, then opens it in Tekmetric so you can add the package there`
                          : `Add this job package to RO ${report?.workOrderNumber || ""}`
                      }
                    >
                      {pushingBuilder
                        ? (pushProvider === "tekmetric" ? "Checking RO..." : "Adding...")
                        : pushedBuilder
                          ? "✓ Added to Work Order"
                          : pushProvider === "tekmetric"
                            ? (builderHandoffUrl ? "Reopen in Tekmetric ↗" : "Open RO in Tekmetric ↗")
                            : "Add to Work Order"}
                    </button>
                  )}
                </div>
                {pushBuilderError && (
                  <p className="text-red-600 text-sm mb-2">{pushBuilderError}</p>
                )}

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
                    const source = String(lh?.recommendedSource || "typical");
                    const sourceLabel =
                      source === "shop_vehicle_history" ? "From your shop's history on this vehicle" :
                      source === "ai_vehicle" ? "AI-adjusted for this vehicle" :
                      source === "shop_history" ? "From your shop's history" :
                      "Generic typical";
                    const rationale = lh?.aiVehicleRationale ? String(lh.aiVehicleRationale) : "";
                    return (
                      <>
                        <div className={`rounded-lg p-3 ${source === "typical" ? "bg-gray-50" : "bg-emerald-50"}`}>
                          <p className="text-xs text-gray-500">Labor Hours (recommended)</p>
                          <p className="text-lg font-bold text-gray-900">{String(lh?.recommended ?? lh?.typical ?? 0)}h</p>
                          <p className="text-xs text-gray-400" title={rationale || undefined}>{sourceLabel}</p>
                          <p className="text-xs text-gray-400">Generic: {String(lh?.typical || 0)}h (range {String(lh?.min || 0)}-{String(lh?.max || 0)}h)</p>
                        </div>
                        {lh?.shopAverage && (
                          <div className="bg-green-50 rounded-lg p-3">
                            <p className="text-xs text-gray-500">{lh?.shopAverageVehicleScoped ? "Shop Average (this vehicle)" : "Shop Average"}</p>
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
                          {Boolean(job.safetyRelated) && (
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
                onClick={() => loadHistory(0)}
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
                                  // Saved reports may predate vehicle metadata;
                                  // resolveRecommendation handles that safely
                                  // and the fallback remains explicitly labeled.
                                  resetRecommendationState();
                                  setReport(item.report);
                                  setWorkOrderId(item.workOrderNumber || item.workOrderId || "");
                                  setActiveTab("audit");
                                  resolveRecommendation(finding, item.report);
                                }}
                                className="mt-2 px-2 py-1 text-xs font-medium bg-white border border-gray-300 rounded hover:bg-gray-50"
                              >
                                Review existing job match
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
              {history.length < historyTotal && (
                <div className="text-center pt-2">
                  <button
                    onClick={() => loadHistory(history.length)}
                    disabled={historyLoadingMore}
                    className="px-5 py-2 bg-white border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 disabled:opacity-50"
                  >
                    {historyLoadingMore
                      ? "Loading..."
                      : `Load more (showing ${history.length} of ${historyTotal})`}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
