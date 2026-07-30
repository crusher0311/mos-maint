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
  auditDate: string;
  findings: AuditFinding[];
  summary: AuditSummary;
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

  return findings;
}

/**
 * Drop duplicate findings (same category + title, first wins) and sort by
 * severity (critical → warning → info), then confidence descending.
 */
export function dedupeAndSortFindings(findings: AuditFinding[]): AuditFinding[] {
  const existingTitles = new Set<string>();
  const deduped = findings.filter(f => {
    const key = `${f.category}:${f.title}`;
    if (existingTitles.has(key)) return false;
    existingTitles.add(key);
    return true;
  });

  deduped.sort((a, b) => {
    const severityOrder = { critical: 0, warning: 1, info: 2 };
    const diff = severityOrder[a.severity] - severityOrder[b.severity];
    if (diff !== 0) return diff;
    return b.confidence - a.confidence;
  });

  return deduped;
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
