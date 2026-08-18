/**
 * Task #1145 — pure RO-line ↔ VHI matcher for the Estimate Assist audit.
 *
 * Given the titles of the service jobs already on a repair order and the
 * due/due-soon items from the vehicle's cached VHI plan, this module works
 * out which recommended services the advisor has NOT put in front of the
 * customer yet ("Due on VHI but not on this ticket").
 *
 * Matching strategy (deliberately conservative — a false "missing" flag is
 * worse than a missed one):
 *   1. Canonical service-key match: the plan item's serviceKey (or keys
 *      derived from its title) against keys derived from each RO line title
 *      via toKeyFromName + toKeyFromFreeText.
 *   2. Normalized-token fallback: the item is treated as quoted when its
 *      title tokens are a subset of some RO line's tokens, or vice versa.
 *
 * Rules from the task:
 *   - Declined/unauthorized jobs count as quoted. Callers pass EVERY line on
 *     the ticket (including declined ones) — this module never filters lines
 *     by authorization status.
 *   - Inspection-only VHI items (inspectOnly flag or an inspect-class action
 *     verb) are never flagged as missing quotes.
 *
 * Kept free of `server-only` / DB imports so it runs under tsx
 * (see tests/estimate-audit-vhi-match.smoke.ts).
 */

import {
  toKeyFromName,
  toKeyFromFreeText,
  isInspectionAction,
  parseServiceAction,
  type ServiceAction,
} from "@/lib/service-keys";
import { normalizeTokens } from "@/lib/last-performed-match";
import type { AuditFinding } from "@/lib/estimate-assist/audit-engine";

export type VhiItemStatus = "overdue" | "due_soon";

/** One due/due-soon item from the cached VHI plan buckets. */
export interface VhiComparisonItem {
  title: string;
  serviceKey?: string | null;
  status: VhiItemStatus;
  dueAtMiles?: number | null;
  /** ISO date string, when the plan knows a due date. */
  dueAtDate?: string | null;
  /** Task #198 inspect-only OEM rows — never flagged as missing quotes. */
  inspectOnly?: boolean;
  /** Verb from the source row ("inspect", "replace", ...). */
  action?: string | null;
}

export interface MissingVhiItem {
  title: string;
  serviceKey: string | null;
  status: VhiItemStatus;
  dueAtMiles: number | null;
  dueAtDate: string | null;
}

/** Result of the whole comparison, persisted on the audit report. */
export interface VhiComparison {
  status: "compared" | "skipped";
  /** Why the comparison was skipped (no VIN, no cached plan, lookup error). */
  reason?: string;
  /** Number of due/due-soon items not found on the ticket (compared only). */
  missingCount?: number;
}

/** True when a plan item is inspection-only and must not be flagged. */
export function isInspectOnlyVhiItem(item: VhiComparisonItem): boolean {
  if (item.inspectOnly) return true;
  const action: ServiceAction | null = item.action
    ? (item.action as ServiceAction)
    : parseServiceAction(item.title);
  return isInspectionAction(action);
}

/** All canonical service keys derivable from a free-form job/line title. */
function keysFromTitle(title: string): string[] {
  const keys = new Set<string>();
  const named = toKeyFromName(title);
  if (named) keys.add(named);
  for (const k of toKeyFromFreeText(title)) keys.add(k);
  return Array.from(keys);
}

/** Subset check: every token of `a` present in `b` (both non-empty). */
function tokensSubset(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  for (const t of a) if (!b.has(t)) return false;
  return true;
}

/**
 * Return the due/due-soon VHI items that are NOT quoted on the ticket.
 * `roLineTitles` must include every job on the RO (declined ones too —
 * declined counts as quoted). Inspection-only items are excluded.
 */
export function findMissingVhiItems(
  roLineTitles: Array<string | null | undefined>,
  planItems: VhiComparisonItem[],
): MissingVhiItem[] {
  const roKeys = new Set<string>();
  const roTokenSets: Set<string>[] = [];
  for (const raw of roLineTitles || []) {
    const title = String(raw || "").trim();
    if (!title) continue;
    for (const k of keysFromTitle(title)) roKeys.add(k);
    const tokens = normalizeTokens(title);
    if (tokens.size > 0) roTokenSets.push(tokens);
  }

  const missing: MissingVhiItem[] = [];
  for (const item of planItems || []) {
    const title = String(item?.title || "").trim();
    if (!title) continue;
    if (isInspectOnlyVhiItem(item)) continue;

    // 1. Canonical service-key match.
    const itemKeys = new Set<string>();
    if (item.serviceKey && !item.serviceKey.startsWith("misc_")) {
      itemKeys.add(item.serviceKey);
    }
    for (const k of keysFromTitle(title)) itemKeys.add(k);
    let quoted = false;
    for (const k of itemKeys) {
      if (roKeys.has(k)) {
        quoted = true;
        break;
      }
    }

    // 2. Normalized-token fallback (either direction of containment).
    if (!quoted) {
      const itemTokens = normalizeTokens(title);
      quoted = roTokenSets.some(
        (lineTokens) =>
          tokensSubset(itemTokens, lineTokens) || tokensSubset(lineTokens, itemTokens),
      );
    }

    if (!quoted) {
      missing.push({
        title,
        serviceKey: item.serviceKey || null,
        status: item.status,
        dueAtMiles: item.dueAtMiles ?? null,
        dueAtDate: item.dueAtDate ?? null,
      });
    }
  }
  return missing;
}

function fmtDue(item: MissingVhiItem, distLabel: string): string {
  const bits: string[] = [];
  if (item.dueAtMiles != null && item.dueAtMiles > 0) {
    bits.push(`due at ${Math.round(item.dueAtMiles).toLocaleString()} ${distLabel}`);
  }
  if (item.dueAtDate) {
    const d = new Date(item.dueAtDate);
    if (!isNaN(d.getTime())) {
      bits.push(
        `by ${d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}`,
      );
    }
  }
  return bits.length > 0 ? ` (${bits.join(", ")})` : "";
}

/** Category shared by all missing-VHI findings (drives dedupe + UI grouping). */
export const VHI_FINDING_CATEGORY = "Due on VHI, Not on Ticket";

/**
 * Convert missing items into audit findings. Overdue → warning, due soon →
 * info, so the existing score math (−5/warning, −1/info) folds them in.
 * Ids continue from `startId` (the caller's running finding counter).
 */
export function buildMissingVhiFindings(
  missing: MissingVhiItem[],
  startId: number,
  distLabel: string = "mi",
): AuditFinding[] {
  let id = startId;
  return (missing || []).map((item) => {
    const overdue = item.status === "overdue";
    return {
      id: `f-${++id}`,
      severity: overdue ? ("warning" as const) : ("info" as const),
      category: VHI_FINDING_CATEGORY,
      title: `"${item.title}" is ${overdue ? "overdue" : "due soon"} but not on this ticket`,
      description: `The vehicle's health inspection plan shows ${item.title}${fmtDue(item, distLabel)} as ${overdue ? "overdue" : "due soon"}, but no matching job is quoted on this repair order.`,
      suggestedAction: `Recommend "${item.title}" to the customer or add it to the estimate.`,
      suggestedJobTitle: item.title,
      confidence: overdue ? 0.85 : 0.7,
    };
  });
}
