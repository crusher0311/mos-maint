import {
  toKeyFromName,
  toAnchorKeysFromHistory,
  splitServicePhrases,
  isInspectOnlyHistoryPhrase,
} from "@/lib/service-keys";
import { computeAnchorMiles } from "@/lib/plan-build/triage";

/**
 * Task #743 — pure matching layer for the "last performed" lookup.
 *
 * This module holds the data-store-free logic: normalizing a history record,
 * matching a job/repair name against a preloaded vehicle history, and building
 * the advisor-facing result. It deliberately has NO `server-only` marker and
 * NO database access so it can be unit-tested directly (see
 * tests/last-performed-match.smoke.ts). The server/db side (loading history
 * from job_index + CARFAX) lives in `lib/last-performed.ts`, which re-exports
 * the pieces here.
 *
 * Fact-only: `matchLastPerformed` returns `null` when there is no record, so
 * the caller renders no badge and never shows a false "never done".
 */

export type LastPerformedSource = "shop" | "carfax";

export type LastPerformedResult = {
  /** ISO date (yyyy-mm-dd) of the most recent performed occurrence, if known. */
  date: string | null;
  /** Human-friendly date, e.g. "Mar 5, 2024". */
  displayDate: string | null;
  /** Odometer at time of service — actual when recorded, else estimated. */
  miles: number | null;
  /** True when `miles` was estimated from the date (not a recorded odometer). */
  milesEstimated: boolean;
  /** Where the record came from. */
  source: LastPerformedSource;
  /** Advisor-facing source phrase: "at your shop" | "via CARFAX". */
  sourceLabel: string;
  /** How the match was made. */
  matchType: "service_key" | "name";
  /** The matched history record's service name (for tooltip/debugging). */
  matchedName: string;
  /** Ready-to-render one-liner, e.g. "Last performed Mar 5, 2024 · ~48,200 mi · at your shop". */
  summary: string;
};

/** A single performed-service record normalized from any history source. */
export type PerformedRecord = {
  source: LastPerformedSource;
  serviceName: string;
  date: Date | null;
  miles: number | null;
  /** Canonical service keys this record anchors (inspect-only already stripped). */
  anchorKeys: string[];
  /** Normalized tokens from the performed (non-inspect) phrases, for free-text match. */
  performedTokens: Set<string>;
};

export type VehicleHistory = {
  records: PerformedRecord[];
  currentMiles: number | null;
  milesPerDay: number | null;
};

const STOPWORDS = new Set([
  "replace", "replaced", "replacement", "replacing",
  "remove", "removal", "removed", "install", "installed", "installation",
  "inspect", "inspected", "inspection", "check", "checked", "checking",
  "service", "serviced", "servicing", "repair", "repaired", "repairing",
  "perform", "performed", "flush", "flushed", "flushing",
  "change", "changed", "changing", "replaces",
  "new", "and", "or", "the", "a", "an", "of", "for", "with", "to",
  "kit", "assembly", "complete", "both", "all", "set", "each",
  "rr", "recommend", "recommended", "per", "as", "needed",
]);

/** Lowercase → alnum tokens, drop stopwords/short tokens, singularize. */
export function normalizeTokens(text: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  const raw = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  for (let t of raw) {
    if (t.length < 2) continue;
    if (STOPWORDS.has(t)) continue;
    if (t.length > 3 && t.endsWith("s")) t = t.slice(0, -1);
    if (STOPWORDS.has(t)) continue;
    out.add(t);
  }
  return out;
}

export function toPosNum(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function buildRecord(
  source: LastPerformedSource,
  serviceName: string,
  date: Date | null,
  miles: number | null,
): PerformedRecord {
  const anchorKeys = toAnchorKeysFromHistory(serviceName);
  const performedTokens = new Set<string>();
  for (const phrase of splitServicePhrases(serviceName)) {
    if (isInspectOnlyHistoryPhrase(phrase)) continue;
    for (const t of normalizeTokens(phrase)) performedTokens.add(t);
  }
  return { source, serviceName, date, miles, anchorKeys, performedTokens };
}

function fmtDisplayDate(d: Date): string {
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

/**
 * Match a single job/repair name against a preloaded vehicle history and
 * return the most recent performed occurrence, or `null` when there is no
 * record (no false "never done").
 */
export function matchLastPerformed(
  history: VehicleHistory,
  jobName: string,
  jobCode?: string,
): LastPerformedResult | null {
  const name = String(jobName || "").trim();
  if (!name && !jobCode) return null;

  const queryKey = name ? toKeyFromName(name) : null;
  const queryTokens = Array.from(normalizeTokens(name));

  // Nothing to match on → no badge (conservative).
  if (!queryKey && queryTokens.length === 0) return null;

  let best: { rec: PerformedRecord; matchType: "service_key" | "name" } | null = null;

  for (const rec of history.records) {
    const keyed = !!queryKey && rec.anchorKeys.includes(queryKey);
    const named =
      queryTokens.length > 0 && queryTokens.every((t) => rec.performedTokens.has(t));
    if (!keyed && !named) continue;

    const matchType: "service_key" | "name" = keyed ? "service_key" : "name";

    if (!best) {
      best = { rec, matchType };
      continue;
    }
    // Prefer the more recent record; records with a date always beat undated.
    const a = rec.date ? rec.date.getTime() : -Infinity;
    const b = best.rec.date ? best.rec.date.getTime() : -Infinity;
    if (a > b) best = { rec, matchType };
  }

  if (!best) return null;

  const rec = best.rec;
  const now = new Date();

  let miles = rec.miles ?? null;
  let milesEstimated = false;
  if (miles == null) {
    const est = computeAnchorMiles(
      { miles: rec.miles, date: rec.date },
      history.currentMiles,
      history.milesPerDay,
      now,
    );
    if (est != null && est > 0) {
      miles = Math.round(est);
      milesEstimated = true;
    }
  }

  const sourceLabel = rec.source === "carfax" ? "via CARFAX" : "at your shop";
  const date = rec.date ? rec.date.toISOString().slice(0, 10) : null;
  const displayDate = rec.date ? fmtDisplayDate(rec.date) : null;

  const parts: string[] = ["Last performed"];
  if (displayDate) parts.push(displayDate);
  const head = parts.join(" ");
  const bits: string[] = [head];
  if (miles != null) bits.push(`${milesEstimated ? "~" : ""}${miles.toLocaleString()} mi`);
  bits.push(sourceLabel);
  const summary = bits.join(" · ");

  return {
    date,
    displayDate,
    miles,
    milesEstimated,
    source: rec.source,
    sourceLabel,
    matchType: best.matchType,
    matchedName: rec.serviceName,
    summary,
  };
}
