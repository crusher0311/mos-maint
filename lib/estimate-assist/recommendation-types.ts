/**
 * Client-safe contracts for resolving an actionable Estimate Audit finding.
 *
 * This module deliberately contains types and constants only.  It is imported
 * by dashboard/extension clients, so it must never import auth, Mongo, a
 * provider adapter, or any other server-only module.
 */

export type RecommendationResolutionStatus =
  | "candidates"
  | "no_match"
  | "unavailable";

export type RecommendationResolutionMode = "search" | "preview";

export type RecommendationSourceKind = "canned" | "history";

export type RecommendationLineType = "labor" | "part" | "sublet" | "other";

export interface RecommendationVehicle {
  vin?: string;
  year?: number | string;
  make?: string;
  model?: string;
  engine?: string;
}

export interface RecommendationFinding {
  suggestedJobTitle: string;
  suggestedJobId?: string | null;
}

export interface RecommendationRequest {
  finding: RecommendationFinding;
  vehicle?: RecommendationVehicle;
}

/** Server-side detail preview for a candidate selected by source identity. */
export interface RecommendationPreviewRequest {
  selection: AuditSelection;
  vehicle?: RecommendationVehicle;
}

export interface RecommendationPreviewResponse {
  ok: true;
  candidate: RecommendationCandidate;
  resolution: RecommendationResolution;
}

export interface RecommendationPreviewSelection {
  source: RecommendationSourceIdentity;
}

export interface RecommendationResolveOptions {
  mode?: RecommendationResolutionMode;
  selection?: RecommendationPreviewSelection;
}

/**
 * This is an opaque, server-revalidated identity.  The additional display
 * fields are intentionally non-authoritative and are useful for a stable
 * client selection payload / audit trail only.
 */
export interface RecommendationSourceIdentity {
  kind: RecommendationSourceKind;
  shopId: number;
  id: string;
  sourceSystem?: string | null;
  workOrderId?: string | null;
  workOrderNumber?: string | null;
  title?: string | null;
  listSource?: string | null;
}

export interface RecommendationLine {
  lineType: RecommendationLineType;
  description: string;
  quantity: number;
  unitPrice: number | null;
  extendedPrice: number | null;
  cost?: number | null;
  extendedCost?: number | null;
  partNumber?: string | null;
  manufacturer?: string | null;
  /** Labor hours when a provider/history row supplies them separately. */
  hours?: number | null;
}

export type RecommendationWarningCode =
  | "missing_lines"
  | "missing_prices"
  | "incomplete_lines"
  | "vehicle_specific_parts"
  | "historical_pricing_review"
  | "stale_cache"
  | "detail_unavailable";

export interface RecommendationWarning {
  code: RecommendationWarningCode | string;
  message: string;
}

export interface RecommendationRelevance {
  score: number;
  /** Existing history scorer output when this candidate came from job history. */
  historicalScore?: number;
  band: "strong" | "likely" | "possible";
  serviceMatch: "exact" | "related" | "none";
  vehicleMatch: "vin" | "exact" | "make_model" | "make" | "unknown";
  reason?: string;
}

export interface RecommendationCandidate {
  source: RecommendationSourceIdentity;
  /** Alias retained for clients that call this field sourceIdentity. */
  sourceIdentity?: RecommendationSourceIdentity;
  title: string;
  description?: string | null;
  lines: RecommendationLine[];
  warnings: RecommendationWarning[];
  relevance: RecommendationRelevance;
}

export interface RecommendationResolution {
  status: RecommendationResolutionStatus;
  candidates: RecommendationCandidate[];
  warnings: RecommendationWarning[];
}

export interface RecommendationResolveResponse {
  ok: true;
  resolution: RecommendationResolution;
}

export interface AuditSelection {
  source: RecommendationSourceIdentity;
  /**
   * Optional client preview.  The add route ignores title/lines/prices and
   * rehydrates them from the source identity before any provider write.
   */
  title?: string | null;
  lines?: RecommendationLine[];
}
