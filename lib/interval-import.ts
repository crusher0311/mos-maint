/**
 * Pure inference logic for the Settings → Intervals "Import from document"
 * flow. Takes an AI transcription of a shop's mileage-based maintenance
 * guide (services listed per milestone) and converts it into proposed
 * recurring per-service intervals keyed to the COMMON_SERVICES key set.
 *
 * Deliberately free of "server-only" / DB imports so it can be unit-tested
 * under tsx (see tests/interval-import.smoke.ts).
 */

import { parseServiceAction, toKeyFromName, INSPECTION_SERVICE_KEYS } from "@/lib/service-keys";
import { COMMON_SERVICE_KEYS, COMMON_SERVICE_NAME_BY_KEY } from "@/lib/interval-common-services";

export type ExtractedService = {
  /** Service line as written in the document (without the parenthetical). */
  name: string;
  /** Inline note / parenthetical, e.g. "Every 2 years or 30k", "If applicable". */
  note?: string | null;
};

export type ExtractedMilestone = {
  /** Milestone mileage, e.g. 30000 for the "30,000 Mile Service" section. */
  miles: number;
  services: ExtractedService[];
};

export type DocExtraction = {
  milestones: ExtractedMilestone[];
};

export type ProposalConfidence = "high" | "medium" | "low";

export type IntervalProposal = {
  /** Canonical service key (guaranteed to be in COMMON_SERVICE_KEYS). */
  key: string;
  /** Display name of the matched common service. */
  serviceName: string;
  /** Distinct source names from the document that mapped to this key. */
  sourceNames: string[];
  /** Proposed recurring interval in miles (null = no mileage cadence). */
  miles: number | null;
  /** Proposed recurring interval in months (null = no time cadence). */
  months: number | null;
  confidence: ProposalConfidence;
  /** Human-readable caveats: "If applicable", "One-time milestone", etc. */
  flags: string[];
  /** True when the service appeared at a single milestone only. */
  oneTime: boolean;
  /** Milestones (miles) where the service appeared. */
  appearedAt: number[];
};

export type FlaggedReason = "unmatched" | "inspect_only" | "not_adjustable" | "implausible";

export type FlaggedItem = {
  name: string;
  reason: FlaggedReason;
  detail: string;
  appearedAt: number[];
};

export type InferenceResult = {
  ok: true;
  proposals: IntervalProposal[];
  flagged: FlaggedItem[];
  /** Doc names that resolved to no service key (for synonym-growth logging). */
  unmatchedNames: string[];
  milestones: number[];
} | {
  ok: false;
  error: string;
};

/** Plausibility bounds for proposed intervals. */
export const MIN_INTERVAL_MILES = 1000;
export const MAX_INTERVAL_MILES = 150000;
export const MIN_INTERVAL_MONTHS = 1;
export const MAX_INTERVAL_MONTHS = 120;

const CONDITIONAL_PATTERNS: Array<{ rx: RegExp; label: string }> = [
  { rx: /if\s+applicable/i, label: "If applicable" },
  { rx: /if\s+equipped/i, label: "If equipped" },
  { rx: /where\s+applicable/i, label: "Where applicable" },
  { rx: /as\s+needed/i, label: "As needed" },
  { rx: /non[-\s]?electric/i, label: "Non-electric only" },
];

/**
 * Parse an inline recurrence rule like "Every 2 years or 30k",
 * "Every 5 years", "every 30,000 miles". Only fires when the text
 * actually contains an "every" cadence keyword — bare numbers in a
 * service name (e.g. "100k Service") never count as a rule.
 */
export function parseInlineRule(text: string | null | undefined): { miles: number | null; months: number | null } {
  const t = (text || "").toLowerCase();
  if (!/\bevery\b/.test(t)) return { miles: null, months: null };

  let months: number | null = null;
  let miles: number | null = null;

  const yr = t.match(/(\d+(?:\.\d+)?)\s*(?:years?|yrs?)\b/);
  if (yr) months = Math.round(parseFloat(yr[1]) * 12);
  const mo = t.match(/(\d+)\s*months?\b/);
  if (mo) months = parseInt(mo[1], 10);

  const mk = t.match(/(\d+(?:\.\d+)?)\s*k\b/);
  if (mk) {
    miles = Math.round(parseFloat(mk[1]) * 1000);
  } else {
    const mm = t.match(/(\d{1,3}(?:,\d{3})+|\d{4,6})\s*(?:miles?|mi)\b/);
    if (mm) miles = parseInt(mm[1].replace(/,/g, ""), 10);
  }

  return { miles, months };
}

/**
 * Map a document service name to a canonical service key.
 *
 * Pre-passes the drivetrain gear-oil phrasings BEFORE the shared
 * `toKeyFromName`, because that matcher checks the `oil` synonym list
 * first and "Rear Differential Gear Oil Service" contains "oil service"
 * → would mis-map to `oil`. The pre-pass is contained to the import path
 * so history-anchoring behavior elsewhere is untouched.
 */
export function mapImportServiceNameToKey(name: string): string | null {
  const n = name.toLowerCase();
  if (n.includes("transfer case")) return "transfer_case";
  if (n.includes("front differential")) return "front_differential";
  if (n.includes("rear differential")) return "rear_differential";
  if (n.includes("differential")) return "rear_differential";
  return toKeyFromName(n);
}

/**
 * Infer a recurring mileage interval from the milestones where a service
 * appears, relative to the full set of milestones in the document.
 */
export function inferRecurrenceMiles(
  appearances: number[],
  allMilestones: number[],
): { miles: number | null; oneTime: boolean; confidence: ProposalConfidence; note: string | null } {
  const uniq = Array.from(new Set(appearances)).sort((a, b) => a - b);
  if (uniq.length === 0) return { miles: null, oneTime: false, confidence: "low", note: null };
  if (uniq.length === 1) {
    return {
      miles: uniq[0],
      oneTime: true,
      confidence: "low",
      note: `Listed once, at the ${uniq[0].toLocaleString()}-mile milestone — may not be a recurring interval`,
    };
  }

  const gaps: number[] = [];
  for (let i = 1; i < uniq.length; i++) gaps.push(uniq[i] - uniq[i - 1]);
  const allEqual = gaps.every((g) => g === gaps[0]);

  if (allEqual) {
    return {
      miles: gaps[0],
      oneTime: false,
      confidence: uniq.length >= 3 ? "high" : "medium",
      note: uniq.length >= 3 ? null : "Based on only two milestones",
    };
  }

  // Irregular gaps but present at (nearly) every milestone in the doc →
  // "do this at each visit"; propose the first milestone as the cadence.
  const totalMilestones = Array.from(new Set(allMilestones)).length;
  if (totalMilestones > 0 && uniq.length / totalMilestones >= 0.7) {
    return {
      miles: uniq[0],
      oneTime: false,
      confidence: "medium",
      note: "Listed at every milestone — proposed the smallest milestone as the cadence",
    };
  }

  // Fall back to the most common gap (ties → smallest).
  const counts = new Map<number, number>();
  for (const g of gaps) counts.set(g, (counts.get(g) || 0) + 1);
  let best = gaps[0];
  let bestCount = 0;
  for (const [g, c] of Array.from(counts.entries()).sort((a, b) => a[0] - b[0])) {
    if (c > bestCount) {
      best = g;
      bestCount = c;
    }
  }
  return {
    miles: best,
    oneTime: false,
    confidence: "low",
    note: "Milestone spacing is irregular — check the proposed interval",
  };
}

function plausibleMiles(m: number | null): boolean {
  return m == null || (m >= MIN_INTERVAL_MILES && m <= MAX_INTERVAL_MILES);
}
function plausibleMonths(m: number | null): boolean {
  return m == null || (m >= MIN_INTERVAL_MONTHS && m <= MAX_INTERVAL_MONTHS);
}

/** Validate the raw shape the AI returned. Throws on structural garbage. */
export function sanitizeExtraction(raw: any): DocExtraction | null {
  if (!raw || !Array.isArray(raw.milestones)) return null;
  const milestones: ExtractedMilestone[] = [];
  for (const m of raw.milestones) {
    const miles = Number(m?.miles);
    if (!Number.isFinite(miles) || miles <= 0 || miles > 500000) continue;
    const services: ExtractedService[] = [];
    for (const s of Array.isArray(m?.services) ? m.services : []) {
      const name = String(s?.name ?? "").trim();
      if (!name || name.length > 200) continue;
      const note = s?.note == null ? null : String(s.note).trim() || null;
      services.push({ name, note });
    }
    if (services.length > 0) milestones.push({ miles: Math.round(miles), services });
  }
  if (milestones.length === 0) return null;
  milestones.sort((a, b) => a.miles - b.miles);
  return { milestones };
}

/**
 * Core inference: extraction → proposals + flagged items. Nothing here
 * writes anywhere; the caller decides what to do with the output.
 */
export function buildIntervalProposals(extraction: DocExtraction): InferenceResult {
  const milestones = Array.from(new Set(extraction.milestones.map((m) => m.miles))).sort((a, b) => a - b);
  const totalServices = extraction.milestones.reduce((n, m) => n + m.services.length, 0);

  if (milestones.length < 2 || totalServices < 3) {
    return {
      ok: false,
      error:
        "The document doesn't look like a mileage-based maintenance guide (need at least two mileage milestones with services listed under each).",
    };
  }

  type Group = {
    key: string;
    sourceNames: Set<string>;
    appearances: number[];
    ruleMiles: number | null;
    ruleMonths: number | null;
    conditionalFlags: Set<string>;
  };
  const groups = new Map<string, Group>();

  type FlagAgg = { reason: FlaggedReason; detail: string; appearedAt: Set<number> };
  const flaggedByName = new Map<string, FlagAgg>();
  const unmatched = new Set<string>();

  const addFlag = (name: string, milestone: number, reason: FlaggedReason, detail: string) => {
    const k = `${reason}:${name.toLowerCase()}`;
    const existing = flaggedByName.get(k);
    if (existing) {
      existing.appearedAt.add(milestone);
    } else {
      flaggedByName.set(k, { reason, detail, appearedAt: new Set([milestone]) });
    }
  };
  const flagName = (k: string) => k.slice(k.indexOf(":") + 1);

  for (const milestone of extraction.milestones) {
    for (const svc of milestone.services) {
      const name = svc.name.trim();
      const note = svc.note ?? null;
      const fullText = note ? `${name} (${note})` : name;

      const action = parseServiceAction(name);
      const key = mapImportServiceNameToKey(name);

      // Verb guard: an "Inspect …" line never sets a replacement interval.
      // (Exception: keys whose scheduled item IS an inspection, e.g. emissions.)
      if (action === "inspect" && !(key && INSPECTION_SERVICE_KEYS.has(key))) {
        addFlag(
          name,
          milestone.miles,
          "inspect_only",
          key
            ? `Inspect-only item — not used to set a ${COMMON_SERVICE_NAME_BY_KEY[key] ?? key} replacement interval`
            : "Inspect-only item — no interval proposed",
        );
        continue;
      }

      if (!key) {
        unmatched.add(name);
        addFlag(name, milestone.miles, "unmatched", "Couldn't match this to a known service — review manually");
        continue;
      }

      if (!COMMON_SERVICE_KEYS.has(key)) {
        addFlag(
          name,
          milestone.miles,
          "not_adjustable",
          "Recognized the service, but it isn't one of the adjustable shop intervals",
        );
        continue;
      }

      let group = groups.get(key);
      if (!group) {
        group = {
          key,
          sourceNames: new Set(),
          appearances: [],
          ruleMiles: null,
          ruleMonths: null,
          conditionalFlags: new Set(),
        };
        groups.set(key, group);
      }
      group.sourceNames.add(name);
      group.appearances.push(milestone.miles);

      const rule = parseInlineRule(fullText);
      if (rule.miles != null) group.ruleMiles = rule.miles;
      if (rule.months != null) group.ruleMonths = rule.months;

      for (const { rx, label } of CONDITIONAL_PATTERNS) {
        if (rx.test(fullText)) group.conditionalFlags.add(label);
      }
    }
  }

  const proposals: IntervalProposal[] = [];
  const flagged: FlaggedItem[] = [];

  for (const group of groups.values()) {
    const inferred = inferRecurrenceMiles(group.appearances, milestones);
    const flags = Array.from(group.conditionalFlags);

    let miles: number | null;
    let months: number | null = group.ruleMonths;
    let confidence: ProposalConfidence;
    let oneTime = false;

    if (group.ruleMiles != null) {
      miles = group.ruleMiles;
      confidence = "high";
      flags.push("Interval taken from the document's inline rule");
    } else {
      miles = inferred.miles;
      confidence = inferred.confidence;
      oneTime = inferred.oneTime;
      if (inferred.note) flags.push(inferred.note);
    }
    if (oneTime) flags.push("One-time milestone — doesn't fit a recurring interval");

    // Sanity bounds — implausible values become flagged items, never proposals.
    if (!plausibleMiles(miles) || !plausibleMonths(months)) {
      flagged.push({
        name: Array.from(group.sourceNames).join(" / "),
        reason: "implausible",
        detail: `Extracted interval (${miles ?? "—"} mi / ${months ?? "—"} mo) is outside plausible bounds`,
        appearedAt: Array.from(new Set(group.appearances)).sort((a, b) => a - b),
      });
      continue;
    }
    if (miles == null && months == null) continue;

    proposals.push({
      key: group.key,
      serviceName: COMMON_SERVICE_NAME_BY_KEY[group.key] ?? group.key,
      sourceNames: Array.from(group.sourceNames),
      miles,
      months,
      confidence,
      flags,
      oneTime,
      appearedAt: Array.from(new Set(group.appearances)).sort((a, b) => a - b),
    });
  }

  for (const [k, agg] of flaggedByName) {
    flagged.push({
      name: flagName(k),
      reason: agg.reason,
      detail: agg.detail,
      appearedAt: Array.from(agg.appearedAt).sort((a, b) => a - b),
    });
  }

  proposals.sort((a, b) => a.serviceName.localeCompare(b.serviceName));
  flagged.sort((a, b) => a.name.localeCompare(b.name));

  if (proposals.length === 0) {
    return {
      ok: false,
      error: "Couldn't confidently map any services in the document to your shop's interval list.",
    };
  }

  return { ok: true, proposals, flagged, unmatchedNames: Array.from(unmatched), milestones };
}
