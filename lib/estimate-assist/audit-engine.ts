/**
 * Pure static-rule engine for the Estimate Assist audit.
 *
 * Extracted from `app/api/estimate-assist/audit/route.ts` so the rules and
 * score math are unit-testable without the route's auth / Mongo / OpenAI
 * dependencies (the route imports `lib/auth` which is `server-only` and
 * cannot load under tsx). The route stays thin: it resolves line items,
 * calls these functions, then layers optional AI findings on top.
 *
 * No imports here may pull in `server-only` (directly or transitively).
 */
import {
  getJobKnowledgeBase,
  searchJobs,
  JobKnowledgeEntry,
} from "@/lib/estimate-assist/job-knowledge-base";
import { toKeyFromFreeText, toKeyFromName } from "@/lib/service-keys";

export type AuditFindingSource = "static" | "vhi" | "ai";

/**
 * Stable, machine-readable evidence retained when equivalent findings from
 * different evaluators are combined.  It intentionally contains only RO
 * line/service references, never an unbounded AI explanation.
 */
export interface AuditFindingEvidence {
  lineItemIndexes?: number[];
  lineItemTitles?: string[];
  serviceKeys?: string[];
  affectedJobTitles?: string[];
  operation?: string;
}

export interface AuditFinding {
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
  /** Evaluator that first raised this finding (legacy reports omit this). */
  source?: AuditFindingSource;
  /** All evaluators whose evidence was merged into this one issue. */
  sources?: AuditFindingSource[];
  /** Conservative service/line evidence used for identity and review. */
  evidence?: AuditFindingEvidence;
}

/**
 * Vehicle identity captured at audit time.  This is deliberately metadata
 * only: audit rules must continue to operate on line items and may not use
 * these fields to change their findings.
 *
 * The property is optional so audits saved before recommendation resolution
 * was introduced remain readable.
 */
export interface AuditVehicleMetadata {
  vin?: string;
  year?: number;
  make?: string;
  model?: string;
}

export interface AuditReport {
  workOrderId?: string;
  workOrderNumber?: string;
  /** SMS the audited RO came from (normalized provenance.sourceSystem). */
  provider?: string;
  /**
   * The provider's own primary id for this RO (e.g. the Protractor WO GUID
   * from provenance idType "invoice_id"). Lets the dashboard push built
   * estimate lines back to the RO via the existing add-to-RO routes.
   */
  smsWorkOrderId?: string;
  vehicleDisplay?: string;
  /** Vehicle identity used when reviewing or falling back from a finding. */
  vehicle?: AuditVehicleMetadata;
  auditDate: string;
  findings: AuditFinding[];
  summary: AuditSummary;
  /**
   * Task #1145: outcome of the VHI-plan comparison. `compared` means the
   * cached VHI plan was checked for due/overdue items missing from the
   * ticket (any gaps appear as findings); `skipped` (with `reason`) means
   * the comparison couldn't run — no VIN, no cached plan, or a bounded
   * lookup timeout. Missing on audits saved before this task.
   */
  vhiComparison?: {
    status: "compared" | "skipped";
    reason?: string;
    missingCount?: number;
  };
  /** Overall result completeness for current evaluator reports. */
  completeness: AuditCompleteness;
  /** Explicit optional-AI outcome; unavailable means static/VHI findings remain useful but partial. */
  aiStatus: AuditAiStatus;
  /**
   * An audit can still return useful static findings when an optional
   * evaluator is unavailable.  Consumers must not present such a result as a
   * fully completed AI review.
   */
  evaluation?: AuditEvaluationStatus;
}

export interface AuditEvaluationStatus {
  completeness: AuditCompleteness;
  ai: AuditAiStatus;
}

export type AuditCompleteness = "complete" | "partial";

export interface AuditAiStatus {
  status: "completed" | "unavailable";
  reason?: string;
}

export interface AuditSummary {
  totalFindings: number;
  critical: number;
  warnings: number;
  info: number;
  score: number;
}

export interface AuditLineItem {
  title: string;
  description?: string;
  type?: string;
  laborHours?: number;
  laborTotal?: number;
  partsTotal?: number;
  parts?: Array<{ description: string; quantity: number; unitPrice: number }>;
  total?: number;
}

/** Labor-hours sanity thresholds relative to the KB range. */
export const LOW_LABOR_FACTOR = 0.5; // below min * 0.5 → under-billing warning
export const HIGH_LABOR_FACTOR = 1.5; // above max * 1.5 → info

/** A labor-only line is exempt from the missing-parts rule when it looks diagnostic. */
export function isDiagnosticLine(item: AuditLineItem): boolean {
  return (
    item.type === "diagnostic" ||
    item.type === "inspection" ||
    /diagnostic|inspection|check|test|scan/i.test(item.title)
  );
}

/**
 * Run every static (non-AI) audit rule over the line items.
 * Returns findings with sequential ids `f-1..f-n`; the caller continues
 * numbering from `findings.length` for any AI findings it appends.
 */
export function runStaticAuditRules(lineItems: AuditLineItem[]): AuditFinding[] {
  const findings: AuditFinding[] = [];
  let findingId = 0;

  const knowledgeBase = getJobKnowledgeBase();

  for (let i = 0; i < lineItems.length; i++) {
    const item = lineItems[i];
    const matchedKbJobs = searchJobs(item.title, 3);
    const primaryMatch = matchedKbJobs[0];

    if (item.laborTotal && item.laborTotal > 0 && (!item.partsTotal || item.partsTotal <= 0)) {
      const isDiag = isDiagnosticLine(item);
      if (!isDiag && primaryMatch && primaryMatch.requiredParts.length > 0) {
        findings.push({
          id: `f-${++findingId}`,
          severity: "critical",
          category: "Missing Parts",
          title: `No parts on "${item.title}"`,
          description: `This job has $${item.laborTotal} labor but no parts listed. Typical parts for this job include: ${primaryMatch.requiredParts.join(", ")}.`,
          suggestedAction: `Add required parts: ${primaryMatch.requiredParts.join(", ")}`,
          suggestedJobId: primaryMatch.jobId,
          confidence: 0.85,
          lineItemIndex: i,
        });
      }
    }

    if (item.partsTotal && item.partsTotal > 0 && (!item.laborTotal || item.laborTotal <= 0)) {
      findings.push({
        id: `f-${++findingId}`,
        severity: "warning",
        category: "Missing Labor",
        title: `No labor on "${item.title}"`,
        description: `This job has $${item.partsTotal} in parts but no labor charged. Parts typically require installation labor.`,
        suggestedAction: primaryMatch ? `Add labor: typically ${primaryMatch.laborHoursTypical} hours for this job` : "Add appropriate labor time",
        confidence: 0.8,
        lineItemIndex: i,
      });
    }

    if (primaryMatch && item.laborHours) {
      if (item.laborHours < primaryMatch.laborHoursMin * LOW_LABOR_FACTOR) {
        findings.push({
          id: `f-${++findingId}`,
          severity: "warning",
          category: "Labor Hours",
          title: `Low labor hours on "${item.title}"`,
          description: `${item.laborHours}h charged, typical range is ${primaryMatch.laborHoursMin}-${primaryMatch.laborHoursMax}h. This may indicate under-billing.`,
          suggestedAction: `Review labor time. Typical: ${primaryMatch.laborHoursTypical}h`,
          confidence: 0.7,
          lineItemIndex: i,
        });
      } else if (item.laborHours > primaryMatch.laborHoursMax * HIGH_LABOR_FACTOR) {
        findings.push({
          id: `f-${++findingId}`,
          severity: "info",
          category: "Labor Hours",
          title: `High labor hours on "${item.title}"`,
          description: `${item.laborHours}h charged, typical range is ${primaryMatch.laborHoursMin}-${primaryMatch.laborHoursMax}h. Verify if additional complications justified extra time.`,
          confidence: 0.6,
          lineItemIndex: i,
        });
      }
    }

    if (primaryMatch && primaryMatch.safetyRelated) {
      for (const compId of primaryMatch.companionJobs) {
        const compJob = knowledgeBase.find((j: JobKnowledgeEntry) => j.jobId === compId);
        if (compJob && compJob.safetyRelated) {
          const isOnEstimate = lineItems.some(li =>
            li.title.toLowerCase().includes(compJob.title.toLowerCase().split(" ")[0]) ||
            compJob.tags.some(t => li.title.toLowerCase().includes(t))
          );
          if (!isOnEstimate) {
            const existingFinding = findings.find(f =>
              f.suggestedJobId === compId && f.category === "Missing Companion Service"
            );
            if (!existingFinding) {
              findings.push({
                id: `f-${++findingId}`,
                severity: "warning",
                category: "Missing Companion Service",
                title: `Consider adding "${compJob.title}"`,
                description: `"${item.title}" is commonly performed with "${compJob.title}" for complete service.`,
                suggestedAction: `Add "${compJob.title}" to the estimate`,
                suggestedJobId: compJob.jobId,
                suggestedJobTitle: compJob.title,
                confidence: 0.65,
              });
            }
          }
        }
      }
    }

    if (!item.description || item.description.trim().length < 10) {
      findings.push({
        id: `f-${++findingId}`,
        severity: "info",
        category: "Description Quality",
        title: `Incomplete description on "${item.title}"`,
        description: "Adding a detailed description improves customer communication and protects the shop legally.",
        suggestedAction: primaryMatch
          ? `Suggested: "${primaryMatch.customerDescription.substring(0, 100)}..."`
          : "Add a clear description of the work to be performed",
        confidence: 0.9,
        lineItemIndex: i,
      });
    }
  }

  const brakeJob = lineItems.find(li =>
    /brake.*pad|pad.*replace|brake.*rotor|rotor.*replace/i.test(li.title)
  );
  if (brakeJob) {
    const hasBrakeFlush = lineItems.some(li => /brake.*fluid|fluid.*flush|brake.*flush/i.test(li.title));
    if (!hasBrakeFlush) {
      findings.push({
        id: `f-${++findingId}`,
        severity: "warning",
        category: "Missing Companion Service",
        title: "Consider Brake Fluid Flush",
        description: "Brake pad/rotor replacement is commonly paired with a brake fluid flush for complete brake service.",
        suggestedAction: "Add brake fluid flush to the estimate",
        suggestedJobId: "brake-fluid-flush",
        suggestedJobTitle: "Brake Fluid Flush",
        confidence: 0.75,
      });
    }
  }

  const timingBeltJob = lineItems.find(li => /timing.*belt/i.test(li.title));
  if (timingBeltJob) {
    const hasWaterPump = lineItems.some(li => /water.*pump/i.test(li.title));
    if (!hasWaterPump) {
      findings.push({
        id: `f-${++findingId}`,
        severity: "warning",
        category: "Missing Companion Service",
        title: "Consider Water Pump Replacement",
        description: "The water pump is commonly replaced during timing belt service since it's already accessible and prevents future labor duplication.",
        suggestedAction: "Add water pump replacement to the estimate",
        suggestedJobId: "water-pump",
        suggestedJobTitle: "Water Pump Replacement",
        confidence: 0.85,
      });
    }
  }

  return findings.map((finding) => ({
    ...finding,
    source: "static",
    sources: ["static"],
    evidence: {
      lineItemIndexes:
        typeof finding.lineItemIndex === "number" ? [finding.lineItemIndex] : undefined,
      lineItemTitles:
        typeof finding.lineItemIndex === "number" && lineItems[finding.lineItemIndex]?.title
          ? [lineItems[finding.lineItemIndex].title]
          : undefined,
      affectedJobTitles: finding.suggestedJobTitle ? [finding.suggestedJobTitle] : undefined,
      operation: findingOperation(finding),
    },
  }));
}

/**
 * Return narrow, stable identity keys for a finding.  A line-specific issue
 * needs the same line and operation; an unscoped recommendation needs an
 * exact service key and operation.  The final category/title key preserves
 * legacy exact-deduplication without fuzzy-title collapse.
 */
export function findingIdentityKeys(finding: AuditFinding): string[] {
  const operation = finding.evidence?.operation || findingOperation(finding);
  const keys: string[] = [];
  const hasConcreteOperation = !operation.startsWith("category:");
  const indexes = finding.evidence?.lineItemIndexes?.length
    ? finding.evidence.lineItemIndexes
    : typeof finding.lineItemIndex === "number"
      ? [finding.lineItemIndex]
      : [];
  for (const index of indexes) {
    // An AI finding with only a broad category (for example "AI Analysis")
    // has not supplied enough operation evidence to merge solely because it
    // names the same line. Recognized operations are deliberately narrower.
    if (hasConcreteOperation && Number.isInteger(index) && index >= 0) {
      keys.push(`line:${index}:operation:${operation}`);
    }
  }

  // Do not infer an arbitrary component from free text.  Service keys are
  // only used for missing-service/companion recommendations, where an exact
  // canonical identity is meaningful.
  if (operation === "missing_service" || operation === "missing_companion") {
    for (const serviceKey of findingServiceKeys(finding)) {
      keys.push(`service:${serviceKey}:operation:${operation}`);
    }
  }

  // An exact legacy key is safe only if this finding has no stronger affected
  // line/component evidence.  Otherwise two identical-looking findings on
  // separate brake-pad lines, for example, must remain two issues.
  const hasLineEvidence = indexes.some((index) => Number.isInteger(index) && index >= 0);
  const hasServiceEvidence = keys.some((key) => key.startsWith("service:"));
  if (!hasLineEvidence && !hasServiceEvidence) {
    keys.push(
      `exact:${normalizeFindingText(finding.category)}:${normalizeFindingText(finding.title)}`,
    );
  } else if (hasLineEvidence && !hasConcreteOperation) {
    // For unknown operations exact text can still collapse a retransmitted
    // duplicate, but affected-line identity remains part of the key.
    for (const index of indexes) {
      if (Number.isInteger(index) && index >= 0) {
        keys.push(
          `exact-line:${index}:${normalizeFindingText(finding.category)}:${normalizeFindingText(finding.title)}`,
        );
      }
    }
  }
  return keys;
}

/**
 * Merge only findings with a shared conservative identity, then sort by
 * severity (critical → warning → info) and confidence.  This happens before
 * score calculation so one issue cannot lower the score multiple times just
 * because static, VHI, and AI passes described it differently.
 */
export function dedupeAndSortFindings(findings: AuditFinding[]): AuditFinding[] {
  const deduped: AuditFinding[] = [];
  const identities = new Map<string, number>();
  for (const finding of findings) {
    const keys = findingIdentityKeys(finding);
    const existingIndex = keys.map((key) => identities.get(key)).find(
      (index): index is number => index != null,
    );
    if (existingIndex == null) {
      const index = deduped.push(normalizeFindingEvidence(finding)) - 1;
      for (const key of keys) identities.set(key, index);
      continue;
    }
    const merged = mergeFindings(deduped[existingIndex], finding);
    deduped[existingIndex] = merged;
    for (const key of findingIdentityKeys(merged)) identities.set(key, existingIndex);
  }

  deduped.sort((a, b) => {
    const severityOrder = { critical: 0, warning: 1, info: 2 };
    const diff = severityOrder[a.severity] - severityOrder[b.severity];
    if (diff !== 0) return diff;
    return b.confidence - a.confidence;
  });

  return deduped;
}

function normalizeFindingText(value: string | undefined): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findingOperation(finding: AuditFinding): string {
  const text = `${finding.category || ""} ${finding.title || ""} ${finding.description || ""}`.toLowerCase();
  if (/missing\s+parts|no\s+parts|parts?\s+(?:are\s+)?missing/.test(text)) return "missing_parts";
  if (/missing\s+labor|no\s+labor|labor\s+(?:is\s+)?missing/.test(text)) return "missing_labor";
  if (/low\s+labor\s+hours/.test(text)) return "low_labor_hours";
  if (/high\s+labor\s+hours/.test(text)) return "high_labor_hours";
  if (/description\s+quality|incomplete\s+description/.test(text)) return "description_quality";
  if (/due\s+on\s+vhi|not\s+on\s+(?:this\s+)?ticket/.test(text)) return "missing_service";
  if (/companion|commonly.associated|consider\s+(?:adding|brake|water)/.test(text)) {
    return "missing_companion";
  }
  return `category:${normalizeFindingText(finding.category)}`;
}

function findingServiceKeys(finding: AuditFinding): string[] {
  const keys = new Set<string>(
    (finding.evidence?.serviceKeys || []).map((key) => String(key).trim()).filter(Boolean),
  );
  if (finding.suggestedJobId) keys.add(`job:${normalizeFindingText(finding.suggestedJobId).replace(/\s+/g, "-")}`);
  for (const text of [finding.suggestedJobTitle, finding.title]) {
    if (!text) continue;
    const named = toKeyFromName(text);
    // A combined recommendation can legitimately mention multiple services
    // (for example, wheel balance *and* rotation).  Do not use an ambiguous
    // free-text result as an identity, or it could collapse either component
    // into a different single-service finding. Exact one-key extraction is
    // safe; the name mapper is only used when free-text sees no service.
    const inferred = toKeyFromFreeText(text);
    if (inferred.length === 1) keys.add(inferred[0]);
    else if (inferred.length === 0 && named) keys.add(named);
  }
  return Array.from(keys);
}

function normalizeFindingEvidence(finding: AuditFinding): AuditFinding {
  const lineItemIndexes = new Set<number>(finding.evidence?.lineItemIndexes || []);
  if (typeof finding.lineItemIndex === "number") lineItemIndexes.add(finding.lineItemIndex);
  const sources = new Set<AuditFindingSource>(finding.sources || []);
  if (finding.source) sources.add(finding.source);
  return {
    ...finding,
    ...(sources.size > 0 ? { sources: Array.from(sources) } : {}),
    evidence: {
      ...finding.evidence,
      ...(lineItemIndexes.size > 0 ? { lineItemIndexes: Array.from(lineItemIndexes).sort((a, b) => a - b) } : {}),
      operation: finding.evidence?.operation || findingOperation(finding),
    },
  };
}

function mergeFindings(first: AuditFinding, second: AuditFinding): AuditFinding {
  const a = normalizeFindingEvidence(first);
  const b = normalizeFindingEvidence(second);
  const severityOrder = { critical: 0, warning: 1, info: 2 };
  // Preserve the stronger presentation, while retaining all source evidence.
  const primary = severityOrder[a.severity] <= severityOrder[b.severity] ? a : b;
  const secondary = primary === a ? b : a;
  const union = (left?: string[], right?: string[]) => {
    const values = Array.from(new Set([...(left || []), ...(right || [])].filter(Boolean)));
    return values.length ? values : undefined;
  };
  const indexes = Array.from(new Set([
    ...(a.evidence?.lineItemIndexes || []),
    ...(b.evidence?.lineItemIndexes || []),
  ])).sort((x, y) => x - y);
  return {
    ...primary,
    confidence: Math.max(a.confidence || 0, b.confidence || 0),
    source: primary.source || secondary.source,
    sources: union(a.sources, b.sources) as AuditFindingSource[] | undefined,
    lineItemIndex:
      indexes.length === 1 ? indexes[0] : primary.lineItemIndex,
    evidence: {
      lineItemIndexes: indexes.length ? indexes : undefined,
      lineItemTitles: union(a.evidence?.lineItemTitles, b.evidence?.lineItemTitles),
      serviceKeys: union(findingServiceKeys(a), findingServiceKeys(b)),
      affectedJobTitles: union(a.evidence?.affectedJobTitles, b.evidence?.affectedJobTitles),
      operation: a.evidence?.operation || b.evidence?.operation || findingOperation(primary),
    },
  };
}

/** Score math: 100 − 15/critical − 5/warning − 1/info, clamped to [0, 100]. */
export function summarizeFindings(findings: AuditFinding[]): AuditSummary {
  const critical = findings.filter(f => f.severity === "critical").length;
  const warnings = findings.filter(f => f.severity === "warning").length;
  const info = findings.filter(f => f.severity === "info").length;

  let score = 100;
  score -= critical * 15;
  score -= warnings * 5;
  score -= info * 1;
  score = Math.max(0, Math.min(100, score));

  return {
    totalFindings: findings.length,
    critical,
    warnings,
    info,
    score,
  };
}
