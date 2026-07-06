/**
 * Task #742: history-aware helpers for the extension DVI pre-fill
 * (`app/api/extension/prefill-dvi/route.ts`).
 *
 * The base pre-fill fills inspection ratings/findings purely from the current
 * VHI maintenance buckets (overdue → red, due-soon → yellow, ok → green). That
 * ignores two signals we already have for Tekmetric:
 *
 *   (a) The vehicle's last-performed anchor (built by triage from CARFAX +
 *       shop history, already inspect-vs-replace guarded — see
 *       `toAnchorKeysFromHistory` / `isInspectOnlyHistoryPhrase` in
 *       lib/service-keys.ts). If a service was *recently* performed we should
 *       mark the DVI task Checked & Okay instead of flagging it for attention.
 *   (b) The vehicle's real prior inspection findings, which are more concrete
 *       than a generic VHI interval projection.
 *
 * These helpers are intentionally pure so they can be unit-tested without a DB
 * or the VHI rebuild pipeline. The route does the Mongo read + orchestration.
 */

import { toKeyFromName } from "@/lib/service-keys";

/**
 * How fresh a last-performed anchor must be to treat the service as "recently
 * done" (so the DVI task pre-fills Checked & Okay even if the VHI interval math
 * still flags it).
 *
 * Mileage is the primary axis because it's the truest wear signal and most
 * Tekmetric shops capture an odometer per RO. No OEM schedules any of the
 * services we track at under ~3,000 mi, so a service performed within 1,000 mi
 * of the current odometer is unambiguously fresh — a safe override.
 *
 * The day-based window is only a FALLBACK for the (rare) case where we have a
 * last-performed date but no mileage on either the anchor or the current RO.
 */
export const RECENT_PERFORMED_MILES = 1000;
export const RECENT_PERFORMED_DAYS = 60;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface LastAnchor {
  miles?: number | null;
  date?: Date | string | null;
  source?: string | null;
}

export interface RecentlyPerformedResult {
  /** True when the service was performed recently enough to mark it OK. */
  performed: boolean;
  /** currentMiles - anchor miles (null when either is unknown). */
  milesAgo: number | null;
  /** Whole days since the anchor date (null when unknown). */
  daysAgo: number | null;
  /** The resolved anchor date (null when absent / unparseable). */
  date: Date | null;
  /** The resolved anchor mileage (null when absent). */
  miles: number | null;
}

function parseAnchorDate(raw: Date | string | null | undefined): Date | null {
  if (!raw) return null;
  const d = raw instanceof Date ? raw : new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Decide whether a service's last-performed anchor is recent enough that the
 * matching DVI task should pre-fill as Checked & Okay.
 *
 * Rule (mileage-primary):
 *   - When we know how many miles ago it was performed, use ONLY that axis:
 *     recent iff 0 ≤ milesAgo ≤ RECENT_PERFORMED_MILES. This deliberately
 *     ignores the date so a hard-driven fleet vehicle (e.g. 6,000 mi in 3
 *     weeks) is NOT called "fresh" just because the calendar date is recent.
 *   - When mileage is unknown, fall back to the date axis:
 *     recent iff 0 ≤ daysAgo ≤ RECENT_PERFORMED_DAYS.
 *
 * The anchor passed in is already inspect-vs-replace guarded by triage, so an
 * "inspected only" event never reaches here as a performed anchor.
 */
export function detectRecentlyPerformed(
  last: LastAnchor | null | undefined,
  currentMiles: number | null | undefined,
  now: Date = new Date(),
): RecentlyPerformedResult {
  const none: RecentlyPerformedResult = {
    performed: false,
    milesAgo: null,
    daysAgo: null,
    date: null,
    miles: null,
  };
  if (!last) return none;

  const lastMiles =
    typeof last.miles === "number" && last.miles > 0 ? last.miles : null;
  const lastDate = parseAnchorDate(last.date);

  let milesAgo: number | null = null;
  if (
    lastMiles != null &&
    typeof currentMiles === "number" &&
    Number.isFinite(currentMiles) &&
    currentMiles > 0
  ) {
    milesAgo = currentMiles - lastMiles;
  }

  let daysAgo: number | null = null;
  if (lastDate) {
    daysAgo = Math.floor((now.getTime() - lastDate.getTime()) / MS_PER_DAY);
  }

  let performed = false;
  if (milesAgo != null) {
    // Mileage-primary: trust the wear axis and ignore the calendar.
    performed = milesAgo >= 0 && milesAgo <= RECENT_PERFORMED_MILES;
  } else if (daysAgo != null) {
    performed = daysAgo >= 0 && daysAgo <= RECENT_PERFORMED_DAYS;
  }

  return { performed, milesAgo, daysAgo, date: lastDate, miles: lastMiles };
}

export interface PastInspectionFinding {
  serviceKey: string;
  /** The raw inspection task name (for display / debugging). */
  taskName: string;
  /** "bad" → RQRSATTN (red), "marginal" → MAYRQRATTN (yellow). */
  rating: "bad" | "marginal";
  /** The tech's free-text note, when present. */
  finding: string | null;
  /** The inspection's date (RO completed/updated/created), when known. */
  date: Date | null;
}

function woDateOf(wo: any): Date | null {
  const raw = wo?.completedDate ?? wo?.updatedDate ?? wo?.createdDate ?? null;
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

/** Newer wins; a finding with no date is treated as the oldest. */
function keepNewer(
  map: Map<string, PastInspectionFinding>,
  candidate: PastInspectionFinding,
): void {
  const existing = map.get(candidate.serviceKey);
  if (!existing) {
    map.set(candidate.serviceKey, candidate);
    return;
  }
  const a = existing.date ? existing.date.getTime() : -Infinity;
  const b = candidate.date ? candidate.date.getTime() : -Infinity;
  if (b > a) map.set(candidate.serviceKey, candidate);
}

/**
 * Collapse a Tekmetric vehicle's prior inspection findings down to the most
 * recent red/yellow finding per canonical service key.
 *
 * Handles both shapes stored on `tekmetric_work_orders.inspections[]`:
 *   - the modern `inspectionTasks[].tasks[]` groups (with `inspectionRating`),
 *   - the legacy flat `items[]` (`status: "bad" | "marginal"`).
 *
 * Only RQRSATTN / MAYRQRATTN (or bad / marginal) findings are collected — a
 * green/pass task is not a "finding" and should not override the VHI pre-fill.
 */
export function extractPastInspectionFindings(
  workOrders: any[],
): Map<string, PastInspectionFinding> {
  const byKey = new Map<string, PastInspectionFinding>();
  if (!Array.isArray(workOrders)) return byKey;

  for (const wo of workOrders) {
    const inspections = Array.isArray(wo?.inspections) ? wo.inspections : [];
    if (inspections.length === 0) continue;
    const date = woDateOf(wo);

    for (const insp of inspections) {
      let foundFromGroups = false;
      const groups = Array.isArray(insp?.inspectionTasks) ? insp.inspectionTasks : [];
      for (const group of groups) {
        for (const task of group?.tasks || []) {
          const code = task?.inspectionRating?.code;
          if (code !== "RQRSATTN" && code !== "MAYRQRATTN") continue;
          const name = task?.name || "";
          const key = toKeyFromName(name);
          if (!key) continue;
          foundFromGroups = true;
          keepNewer(byKey, {
            serviceKey: key,
            taskName: name,
            rating: code === "RQRSATTN" ? "bad" : "marginal",
            finding: typeof task?.finding === "string" ? task.finding : null,
            date,
          });
        }
      }

      if (!foundFromGroups && Array.isArray(insp?.items)) {
        for (const item of insp.items) {
          const status = item?.status;
          if (status !== "bad" && status !== "marginal") continue;
          const name = item?.name || item?.categoryName || "";
          const key = toKeyFromName(name);
          if (!key) continue;
          keepNewer(byKey, {
            serviceKey: key,
            taskName: name,
            rating: status,
            finding: typeof item?.notes === "string" ? item.notes : null,
            date,
          });
        }
      }
    }
  }

  return byKey;
}

/**
 * Whether a past inspection finding has since been remedied — i.e. the service
 * was performed AFTER the inspection flagged it. Uses the last-performed anchor
 * date (already inspect-vs-replace guarded). A remedied finding must NOT be
 * carried forward onto the new DVI.
 */
export function isFindingRemedied(
  finding: Pick<PastInspectionFinding, "date">,
  lastAnchor: LastAnchor | null | undefined,
): boolean {
  if (!finding.date) return false;
  const anchorDate = parseAnchorDate(lastAnchor?.date);
  if (!anchorDate) return false;
  return anchorDate.getTime() > finding.date.getTime();
}
