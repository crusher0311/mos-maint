/**
 * Shared server-side Estimate Assist audit evaluator.
 *
 * This module deliberately does not authenticate callers, enforce an AI
 * budget, resolve live work-order data, or persist a report.  Those remain at
 * the route/worker boundary.  Callers must authorize the shop and reserve the
 * AI budget before invoking it; this keeps automatic evaluation from gaining
 * a path around the manual route's safeguards.
 */
import { getOpenAI, trackOpenAiCall } from "@/lib/ai";
import { withUpstreamTimeout } from "@/lib/with-upstream-timeout";
import { getCachedAuditVhiPlan } from "@/lib/data/repositories/audit-vhi-cache";
import {
  dedupeAndSortFindings,
  runStaticAuditRules,
  summarizeFindings,
  type AuditFinding,
  type AuditLineItem,
  type AuditAiStatus,
  type AuditReport,
  type AuditVehicleMetadata,
} from "@/lib/estimate-assist/audit-engine";
import {
  buildMissingVhiFindings,
  findMissingVhiItems,
  type VhiComparison,
  type VhiComparisonItem,
} from "@/lib/estimate-assist/vhi-audit-match";

export const AUDIT_AI_TIMEOUT_MS = 20_000;
export const AUDIT_VHI_LOOKUP_TIMEOUT_MS = 5_000;
/** Maximum cumulative optional-source wait (VHI cache + AI) per evaluation. */
export const AUDIT_EVALUATOR_TIMEOUT_MS = AUDIT_VHI_LOOKUP_TIMEOUT_MS + AUDIT_AI_TIMEOUT_MS;

export interface AuditEvaluatorVehicleInfo {
  vin?: string;
  year?: number;
  make?: string;
  model?: string;
  drivetrain?: string;
  mileage?: number;
}

/**
 * All resolved data needed to evaluate an audit.  Work-order lookup and live
 * Tekmetric line-item authority intentionally stay with the manual route.
 */
export interface EvaluateAuditInput {
  shopId: number;
  lineItems: AuditLineItem[];
  vehicleInfo?: AuditEvaluatorVehicleInfo | null;
  vehicleVin?: string | null;
  canUseMaintenance: boolean;
  workOrderId?: string;
  workOrderNumber?: string;
  provider?: string;
  smsWorkOrderId?: string;
}

/**
 * Injectable server dependencies.  They make the evaluator testable without
 * a database or AI client; no dependency performs report/history writes.
 */
export interface AuditEvaluatorDeps {
  getDb?: () => Promise<any>;
  getCachedPlan?: (
    db: any,
    vin: string,
    shopId: number,
    currentMiles?: number | null,
  ) => Promise<any>;
  getOpenAI?: () => any;
  trackOpenAiCall?: (
    shopId: number | null | undefined,
    route: string,
    completion: any,
    latencyMs: number,
  ) => void;
  now?: () => Date;
  /**
   * Optional caller deadline (the worker supplies its job AbortSignal).
   * It is combined with the evaluator's AI deadline for cancellable calls.
   */
  signal?: AbortSignal;
}

const defaultDeps: Pick<Required<AuditEvaluatorDeps>, "getOpenAI" | "trackOpenAiCall" | "now"> = {
  getOpenAI,
  trackOpenAiCall,
  now: () => new Date(),
};

/**
 * Evaluate already-authorized, already-budgeted audit input.  VHI is strictly
 * a bounded cached-plan read: this never creates or rebuilds a VHI plan.
 * Static findings always survive optional-source failure.  `evaluation`
 * explicitly marks AI degradation so a caller cannot mistake that partial
 * result for a completed AI review.
 */
export async function evaluateAudit(
  input: EvaluateAuditInput,
  deps: AuditEvaluatorDeps = {},
): Promise<AuditReport> {
  const d = {
    getOpenAI: deps.getOpenAI || defaultDeps.getOpenAI,
    trackOpenAiCall: deps.trackOpenAiCall || defaultDeps.trackOpenAiCall,
    now: deps.now || defaultDeps.now,
  };
  const lineItems = Array.isArray(input.lineItems) ? input.lineItems : [];
  const vehicleInfo = input.vehicleInfo || null;
  const vehicleVin = String(input.vehicleVin || vehicleInfo?.vin || "").trim() || null;
  const findings = runStaticAuditRules(lineItems);
  let findingId = findings.length;

  let vhiComparison: VhiComparison = {
    status: "skipped",
    reason: vehicleVin
      ? "Maintenance access is not available for this shop"
      : "No VIN available for this repair order",
  };
  if (vehicleVin && input.canUseMaintenance) {
    try {
      const cachedPlan = await getCachedAuditVhiPlan(
        {
          shopId: input.shopId,
          vin: vehicleVin,
          currentMiles: vehicleInfo?.mileage ?? null,
          timeoutMs: AUDIT_VHI_LOOKUP_TIMEOUT_MS,
        },
        {
          getDb: deps.getDb,
          getCachedPlan: deps.getCachedPlan,
        },
      );
      const buckets = cachedPlan?.plan?.buckets;
      if (buckets) {
        const planItems: VhiComparisonItem[] = [
          ...(buckets.overdue || []).map((item: any) => ({ ...item, status: "overdue" as const })),
          ...(buckets.dueSoon || []).map((item: any) => ({ ...item, status: "due_soon" as const })),
        ];
        const missing = findMissingVhiItems(lineItems.map((item) => item.title), planItems);
        const distLabel = cachedPlan?.plan?.distanceUnit === "kilometers" ? "km" : "mi";
        const vhiFindings = buildMissingVhiFindings(missing, findingId, distLabel);
        findingId += vhiFindings.length;
        findings.push(...vhiFindings);
        vhiComparison = { status: "compared", missingCount: missing.length };
      } else {
        vhiComparison = { status: "skipped", reason: "No VHI plan is cached for this vehicle yet" };
      }
    } catch (error: any) {
      console.warn(`[Estimate Audit] VHI comparison failed (non-fatal): ${error?.message || error}`);
      vhiComparison = { status: "skipped", reason: "VHI plan lookup failed" };
    }
  }

  let aiFindings: AuditFinding[] = [];
  let aiStatus: AuditAiStatus = { status: "completed" };
  try {
    const openai = d.getOpenAI();
    const startedAt = d.now().getTime();
    // `getOpenAI` is deliberately an injectable structural dependency. Give
    // the timeout helper an explicit result type so its `null` degradation
    // fallback does not narrow an untyped injected completion to `never`.
    const completion = await withUpstreamTimeout<any | null>(
      openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are an expert automotive estimate auditor. Review the estimate line items and identify issues. Focus on:
1. Missing commonly-associated services not already flagged
2. Description improvements for customer communication
3. Safety concerns
4. Internal inconsistencies (e.g. a parts-replacement job with $0 parts, labor listed with no hours)

NEVER judge whether a price is high or low, and NEVER reference "industry standards", "market rates", or "typical pricing" — you have no pricing data, and shop pricing varies legitimately by region, vehicle, and business model. Do not produce pricing/cost findings of any kind.

All line items are on the SAME repair order and will be performed during the SAME visit. The order they are listed in does NOT reflect the order the technician will perform them — shops control execution sequence. Do NOT produce findings about the timing, ordering, or sequencing of services relative to each other.

Return JSON array of findings:
[{
  "severity": "critical"|"warning"|"info",
  "category": "string",
  "title": "string",
  "description": "string",
  "suggestedAction": "string",
  "suggestedJobTitle": "string",
  "confidence": 0.0-1.0,
  "lineItemIndex": number|null
}]

Only include genuinely useful findings. Do not repeat obvious items. Maximum 5 findings.`,
          },
          {
            role: "user",
            content: `Vehicle: ${vehicleDescription(vehicleInfo)}\n\nEstimate Line Items:\n${lineItems.map((item, index) =>
              `${index + 1}. "${item.title}" - Labor: ${item.laborHours || "N/A"}h ($${item.laborTotal || "N/A"}), Parts: $${item.partsTotal || "N/A"}, Total: $${item.total || "N/A"}`,
            ).join("\n")}`,
          },
        ],
        temperature: 0.3,
        max_tokens: 800,
        response_format: { type: "json_object" },
      }, {
        // Cancels the underlying HTTP request at the same boundary as the
        // fallback. maxRetries:0 prevents the SDK from starting extra calls
        // after the evaluator has already degraded this audit.
        signal: aiRequestSignal(deps.signal),
        maxRetries: 0,
      }),
      AUDIT_AI_TIMEOUT_MS,
      "estimate-audit-ai",
      null,
    );

    if (!completion) {
      aiStatus = { status: "unavailable", reason: "AI analysis was unavailable or timed out" };
    } else {
      d.trackOpenAiCall(input.shopId, "/api/estimate-assist/audit", completion, d.now().getTime() - startedAt);
      const content = completion?.choices?.[0]?.message?.content || "{}";
      let parsed: any;
      try {
        parsed = JSON.parse(content);
      } catch {
        aiStatus = { status: "unavailable", reason: "AI analysis returned an invalid response" };
        parsed = null;
      }
      const items = Array.isArray(parsed) ? parsed : (parsed?.findings || parsed?.items || []);
      if (Array.isArray(items)) {
        aiFindings = items
          .filter((item: any) => item && item.title && item.description && !isPricingOpinion(item))
          .map((item: any) => ({
            id: `f-${++findingId}`,
            severity: validSeverity(item.severity),
            category: item.category || "AI Analysis",
            title: String(item.title),
            description: String(item.description),
            suggestedAction: item.suggestedAction,
            suggestedJobTitle: item.suggestedJobTitle,
            confidence: typeof item.confidence === "number" ? item.confidence : 0.5,
            lineItemIndex: validLineIndex(item.lineItemIndex, lineItems.length),
            source: "ai" as const,
            sources: ["ai"],
          }));
      }
    }
  } catch (error: any) {
    console.error("[Estimate Audit] AI analysis failed:", error);
    aiStatus = { status: "unavailable", reason: "AI analysis failed" };
  }

  const mergedFindings = dedupeAndSortFindings([...findings, ...aiFindings]);
  const vehicle: AuditVehicleMetadata | undefined = vehicleInfo || vehicleVin
    ? {
        ...(vehicleVin ? { vin: vehicleVin.toUpperCase() } : {}),
        ...(vehicleInfo?.year != null ? { year: vehicleInfo.year } : {}),
        ...(vehicleInfo?.make ? { make: vehicleInfo.make } : {}),
        ...(vehicleInfo?.model ? { model: vehicleInfo.model } : {}),
      }
    : undefined;
  const vhiWasRequired = Boolean(vehicleVin && input.canUseMaintenance);
  const completeness =
    aiStatus.status === "completed" && (!vhiWasRequired || vhiComparison.status === "compared")
      ? "complete" as const
      : "partial" as const;

  return {
    workOrderId: input.workOrderId,
    workOrderNumber: input.workOrderNumber,
    provider: input.provider,
    smsWorkOrderId: input.smsWorkOrderId,
    vehicleDisplay: vehicleInfo ? vehicleDescription(vehicleInfo, false) : undefined,
    vehicle,
    auditDate: d.now().toISOString(),
    findings: mergedFindings,
    summary: summarizeFindings(mergedFindings),
    vhiComparison,
    completeness,
    aiStatus,
    evaluation: {
      completeness,
      ai: aiStatus,
    },
  };
}

function vehicleDescription(vehicle: AuditEvaluatorVehicleInfo | null, includeMileage = true): string {
  if (!vehicle) return "Unknown vehicle";
  const label = `${vehicle.year || ""} ${vehicle.make || ""} ${vehicle.model || ""}`.trim();
  return includeMileage ? `${label || "Unknown vehicle"} (${vehicle.mileage || "N/A"} miles)` : label;
}

function validSeverity(value: any): AuditFinding["severity"] {
  return value === "critical" || value === "warning" || value === "info" ? value : "info";
}

function validLineIndex(value: any, count: number): number | undefined {
  return Number.isInteger(value) && value >= 0 && value < count ? value : undefined;
}

function isPricingOpinion(finding: any): boolean {
  return /pric/i.test(String(finding?.category || "")) ||
    /industry standard|market rate|typical pricing|(higher|lower) side compared/i.test(
      `${finding?.title || ""} ${finding?.description || ""} ${finding?.suggestedAction || ""}`,
    );
}

/** Abort the HTTP request on either the evaluator or worker deadline. */
function aiRequestSignal(parentSignal?: AbortSignal): AbortSignal {
  const evaluatorSignal = AbortSignal.timeout(AUDIT_AI_TIMEOUT_MS);
  return parentSignal ? AbortSignal.any([parentSignal, evaluatorSignal]) : evaluatorSignal;
}