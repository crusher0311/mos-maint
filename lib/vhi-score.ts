import { Db } from "mongodb";
import { type TriagedItemCache } from "@/lib/plan-cache";
import { isComplimentaryItem } from "@/lib/complimentary-classification";
import { computeIntervalProgress, type IntervalProgress } from "@/lib/vhi-progress";
import { getStatusIconSvg, type IconStatus } from "@/lib/vhi-icons";
import { resolveServiceIconKey, getServiceIconUrl } from "@/lib/service-icons";

export function categoryMultiplier(category: string): number {
  const cat = (category || "").toLowerCase();
  if (cat.includes("brake") || cat.includes("tire") || cat.includes("steering") || cat.includes("suspension")) return 1.5;
  if (cat.includes("engine") || cat.includes("transmission") || cat.includes("drivetrain")) return 1.3;
  if (cat.includes("wiper") || cat.includes("light") || cat.includes("cabin") || cat.includes("body")) return 0.7;
  return 1.0;
}

export function separateComplimentary(buckets: {
  overdue: TriagedItemCache[];
  dueSoon: TriagedItemCache[];
  upcoming: TriagedItemCache[];
}): {
  overdue: TriagedItemCache[];
  dueSoon: TriagedItemCache[];
  upcoming: TriagedItemCache[];
  complimentary: TriagedItemCache[];
} {
  const complimentary: TriagedItemCache[] = [];
  const filter = (items: TriagedItemCache[]) =>
    items.filter((item) => {
      if (isComplimentaryItem(item)) {
        complimentary.push(item);
        return false;
      }
      return true;
    });
  return {
    overdue: filter(buckets.overdue),
    dueSoon: filter(buckets.dueSoon),
    upcoming: filter(buckets.upcoming),
    complimentary,
  };
}

/* -------------------------------------------------------------------------
 * Task #678: proportional, severity-weighted VHI score.
 *
 * The old model started at 100 and subtracted a FIXED number of points per
 * overdue / due-soon item, then clamped with Math.max(0, …). A genuinely
 * neglected vehicle with many overdue safety items bottomed out at exactly
 * 0, which reads to shops and customers like the tool is broken rather than
 * "this vehicle is in rough shape."
 *
 * The redesign scores the vehicle as a RATIO of how unhealthy its applicable
 * service items are vs. how unhealthy they could possibly be:
 *
 *   - Denominator = every applicable item (overdue + due-soon + upcoming,
 *     excluding complimentary), each weighted by its category multiplier so
 *     a vehicle with more tracked items isn't punished for breadth alone.
 *   - Each item contributes a "state factor": overdue items weigh heaviest,
 *     due-soon lighter, healthy/upcoming items contribute nothing. Red bumps
 *     and declined work add a little more.
 *   - The worst an item can be (overdue + red + declined) defines MAX_STATE_
 *     FACTOR, so maxPenalty = "every applicable item at its worst".
 *   - ratio = penalty / maxPenalty ∈ [0, 1]. A mostly-current vehicle has a
 *     small ratio (high score); a vehicle where most items are overdue has a
 *     large ratio (low score).
 *   - The ratio is shaped by a mild non-linear curve and mapped onto a band
 *     whose bottom is SOFT_FLOOR, NOT 0 — so the worst realistic vehicles
 *     land in a believable low range (roughly the teens–low-40s) and a
 *     scoreable vehicle effectively never reads exactly 0.
 *
 * Edge cases:
 *   - Zero applicable items (or only complimentary) → 100 (nothing to fault).
 *   - Only upcoming / healthy items → ratio 0 → 100.
 *
 * NOTE: the customer-facing "Insufficient Service History" state (gray "?")
 * is a SEPARATE concern handled via `dataQuality` / `buildApiScore` — it is
 * the legitimate "we can't score honestly" case and is untouched here.
 * ----------------------------------------------------------------------- */

/** Base weight of an overdue item before category + bump/declined bonuses. */
const OVERDUE_BASE = 1.0;
/** Base weight of a due-soon item (always lighter than overdue). */
const DUE_SOON_BASE = 0.4;
/** Extra weight for a red-bump overdue item. */
const OVERDUE_RED_BONUS = 0.15;
/** Extra weight for a previously-declined overdue item. */
const OVERDUE_DECLINED_BONUS = 0.1;
/** Extra weight for a red/yellow-bump due-soon item. */
const DUE_SOON_RED_BONUS = 0.1;
const DUE_SOON_YELLOW_BONUS = 0.05;
/** The worst a single item can be — defines the per-item max penalty. */
const MAX_STATE_FACTOR = OVERDUE_BASE + OVERDUE_RED_BONUS + OVERDUE_DECLINED_BONUS; // 1.25
/** Soft floor: the worst realistic vehicle lands here, never at 0. */
const SOFT_FLOOR = 12;
/** Non-linear shaping exponent applied to the unhealthy ratio. */
const CURVE_EXPONENT = 1.15;

export function computeScore(buckets: {
  overdue: TriagedItemCache[];
  dueSoon: TriagedItemCache[];
  // Optional so legacy callers that only pass the two priced buckets still
  // work, but the canonical callers (separateComplimentary output) pass it so
  // healthy items dilute the ratio. Omitting it makes the denominator smaller
  // (a more pessimistic score), which is the safe direction.
  upcoming?: TriagedItemCache[];
}): number {
  let penalty = 0;
  let maxPenalty = 0;

  const accrue = (item: TriagedItemCache, stateFactor: number) => {
    if (isComplimentaryItem(item)) return; // complimentary items never score
    const weight = categoryMultiplier(item.category || "");
    penalty += weight * stateFactor;
    maxPenalty += weight * MAX_STATE_FACTOR;
  };

  for (const item of buckets.overdue) {
    let s = OVERDUE_BASE;
    if (item.bump === "red") s += OVERDUE_RED_BONUS;
    if (item.declined) s += OVERDUE_DECLINED_BONUS;
    accrue(item, s);
  }

  for (const item of buckets.dueSoon) {
    let s = DUE_SOON_BASE;
    if (item.bump === "red") s += DUE_SOON_RED_BONUS;
    else if (item.bump === "yellow") s += DUE_SOON_YELLOW_BONUS;
    accrue(item, s);
  }

  for (const item of buckets.upcoming ?? []) {
    accrue(item, 0); // healthy items dilute the ratio but never add penalty
  }

  // No applicable items at all (or only complimentary) → nothing to fault.
  if (maxPenalty <= 0) return 100;

  const ratio = Math.min(1, Math.max(0, penalty / maxPenalty));
  const score = 100 - (100 - SOFT_FLOOR) * Math.pow(ratio, CURVE_EXPONENT);
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function getScoreTier(score: number): { label: string; color: string } {
  if (score >= 90) return { label: "Excellent", color: "green" };
  if (score >= 80) return { label: "Good", color: "lime" };
  if (score >= 70) return { label: "Needs Attention", color: "amber" };
  if (score >= 60) return { label: "Poor", color: "orange" };
  return { label: "Critical", color: "red" };
}

/**
 * Task #439: Shape of `score` in API responses, including the softened
 * "Insufficient Data" representation. `value` is null when we don't
 * have enough anchors to score the vehicle honestly; `computed` always
 * carries the raw numeric score for ops/observability so we never lose
 * the internal signal.
 */
export interface ApiScorePayload {
  value: number | null;
  tier: string;
  color: string;
  computed: number;
}

/**
 * Task #439: produce the customer-facing `score` payload for any API
 * response that includes a VHI score. When `dataQuality.sufficient`
 * is explicitly false, we hide the numeric score behind a gray
 * "Insufficient Data" tier so partner integrations, the Detect Dog
 * overlay, the VHR shareable report, and our own dashboard all see
 * the same softened representation — Brandon's call (2026-05-19) was
 * that the API must agree with the UI, not just the UI hiding it.
 *
 * The raw computed score is always preserved on `.computed` so ops
 * tooling and webhooks can still see what we calculated.
 *
 * Legacy / missing `dataQuality` is treated as sufficient so existing
 * responses keep showing through unchanged.
 */
export function buildApiScore(
  rawScore: number,
  dataQuality?: { sufficient: boolean } | null
): ApiScorePayload {
  if (dataQuality && dataQuality.sufficient === false) {
    return {
      value: null,
      tier: "Insufficient Data",
      color: "gray",
      computed: rawScore,
    };
  }
  const tier = getScoreTier(rawScore);
  return {
    value: rawScore,
    tier: tier.label,
    color: tier.color,
    computed: rawScore,
  };
}

export interface FormatVhiItemOptions {
  /** Current odometer in the plan's distance unit. Required to emit `progress`. */
  currentMiles?: number | null;
  /** "Now" reference for time-axis math. Defaults to new Date(). */
  today?: Date;
  /**
   * Bucket the item came from — used to pick the icon when it's better than
   * the per-axis progress status (e.g. "deferred" items get the deferred
   * icon, not derived from interval math).
   */
  bucket?: "overdue" | "dueSoon" | "upcoming" | "complimentary" | "deferred";
  /**
   * Set true to inline the status SVG on every item. Default false — the
   * top-level `icons` map on the response is the cheaper, canonical source.
   * Only enable when the consumer can't fetch the top-level map (e.g.
   * row-by-row streaming).
   */
  includeIconSvg?: boolean;
}

/**
 * Task #730: human-readable "detail" string for an item, primarily for partner
 * overlays (e.g. AppFueled) that would otherwise have nothing but the raw
 * status color to show for a DVI finding. Prefers a real note / recommendation;
 * for a DVI finding with no note it derives a readable phrase from the finding
 * name plus a plain-language condition ("Needs attention" / "Monitor") instead
 * of leaking the bare "red"/"yellow" bump. Returns null for non-DVI items with
 * nothing meaningful to add (partners keep their existing interval-based copy).
 */
export function buildItemDetail(item: {
  notes?: string | null;
  recommendedReason?: string | null;
  source?: string | null;
  category?: string | null;
  title?: string | null;
  bump?: string | null;
}): string | null {
  const note = (item.notes ?? "").trim();
  if (note) return note;

  const reason = (item.recommendedReason ?? "").trim();
  if (reason) return reason;

  const isDvi = item.source === "dvi" || item.category === "DVI Finding";
  if (!isDvi) return null;

  const condition =
    item.bump === "yellow" ? "Monitor" : "Needs attention";
  const name = (item.title ?? "").trim();
  return name ? `${name} — ${condition}` : condition;
}

function bucketToStatus(b?: FormatVhiItemOptions["bucket"]): IconStatus | null {
  if (b === "overdue") return "overdue";
  if (b === "dueSoon") return "soon";
  if (b === "upcoming" || b === "complimentary") return "ok";
  if (b === "deferred") return "deferred";
  return null;
}

/**
 * Item shape returned to API consumers. Status semantics:
 *
 *   - `progress.status` and `progress.{miles,time}.status` are derived purely
 *     from interval math (overdue / soon / ok). Use these to render bars and
 *     headlines.
 *   - `iconStatus` is the *triage* status — it follows the bucket the system
 *     placed the item in (overdue / soon / ok / deferred). It can disagree
 *     with `progress.status` (for example, a deferred item still shows the
 *     blue deferred icon even when its interval math reads "ok"). Use this
 *     to pick the SVG from the top-level `icons` map.
 */
export function formatVhiItem(item: TriagedItemCache, opts: FormatVhiItemOptions = {}) {
  const { currentMiles = null, today = new Date(), bucket, includeIconSvg = false } = opts;

  let progress: IntervalProgress | null = null;
  if (currentMiles != null || item.intervalMonths) {
    progress = computeIntervalProgress(item, currentMiles, today);
  }

  const iconStatus: IconStatus | null = bucketToStatus(bucket) ?? progress?.status ?? null;

  // Task #392: per-axis trigger status. Prefer the live progress math
  // (covers freshly-built plans whether or not the cache row carried the
  // fields). Fall back to the persisted byMiles/byTime so older cached
  // entries that pre-date Task #392 still surface something useful.
  const byMiles = progress?.miles.status ?? item.byMiles ?? null;
  const byTime = progress?.time.status ?? item.byTime ?? null;

  const serviceIconKey = resolveServiceIconKey(item.serviceKey, item.title);

  return {
    key: item.key,
    serviceKey: item.serviceKey,
    title: item.title,
    category: item.category || null,
    intervalMiles: item.intervalMiles ?? null,
    intervalMonths: item.intervalMonths ?? null,
    last: item.last
      ? {
          miles: item.last.miles ?? null,
          date: item.last.date ?? null,
          source: item.last.source ?? null,
        }
      : null,
    dueAtMiles: item.dueAtMiles ?? null,
    dueAtDate: item.dueAtDate ?? null,
    milesToGo: item.milesToGo ?? null,
    daysToGo: item.daysToGo ?? null,
    bump: item.bump ?? null,
    source: item.source ?? null,
    dviSource: item.dviSource ?? null,
    declined: !!item.declined,
    action: item.action ?? null,
    notes: item.notes ?? null,
    recommendedDefault: !!item.recommendedDefault,
    recommendedReason: item.recommendedReason ?? null,
    /**
     * Task #730: a partner-facing human-readable description. For DVI findings
     * it is the real inspection note when present, otherwise a derived phrase
     * ("<finding> — Needs attention/Monitor") so partner overlays never have to
     * fall back to showing the raw status color ("red"/"yellow"). Null for
     * non-DVI items with no note so partners keep their interval-based copy.
     * The customer-facing report ignores this field (it builds its own copy).
     */
    detail: buildItemDetail(item),
    progress,
    iconStatus,
    iconSvg: includeIconSvg ? getStatusIconSvg(iconStatus) : null,
    /**
     * Task #675: the per-service PICTOGRAM key (oil drop, differential, cabin
     * air filter, etc.), resolved the same way our customer-facing VHI does.
     * Partners look this up in the response's top-level `serviceIcons` map to
     * render the same icon. This is DISTINCT from `iconStatus`/`iconSvg`, which
     * is the red/amber/green status indicator. Always a real key present in
     * `serviceIcons` (falls back to the general icon), so it never resolves to
     * a missing icon.
     */
    serviceIconKey,
    /**
     * Absolute URL to the per-service pictogram artwork. Partners (e.g.
     * AppFueled) save this URL in their own DB instead of the inline `iconSvg`
     * blob. Always populated (resolves the service key to a hosted file, with
     * a general-icon fallback), so it never points at a missing image.
     */
    serviceIconUrl: getServiceIconUrl(serviceIconKey),
    /**
     * Task #392: per-axis trigger statuses so partners can render
     * "Overdue by time" / "Overdue by mileage" themselves. Either field
     * can be null when the axis has no data (e.g. no time interval, or
     * no current odometer). The top-level `status` from `progress`
     * stays the worst-of-the-two so existing consumers don't break.
     */
    triggers: { byMiles, byTime },
  };
}

export interface AnalysisCacheVhiResult {
  score: { value: number; tier: string; color: string };
  summary: { overdue: number; dueSoon: number; upcoming: number; complimentary?: number };
  buckets: { overdue: any[]; dueSoon: any[]; upcoming: any[]; complimentary?: any[] };
  vehicle: { year: number | null; make: string | null; model: string | null; engine: string | null };
  currentMiles: number | null;
  distanceUnit: string;
  customerName: string | null;
  cachedAt: Date;
  /**
   * Task #384: surface the persisted mileage source so external VHI
   * responses served from the analysis cache include the same fields as
   * the on-demand and cached_plan branches. Legacy entries that predate
   * the persistence change default to "actual" / null.
   */
  mileageSource: "actual" | "estimated_carfax" | "estimated_annual";
  mileageEstimateDetails: Record<string, unknown> | null;
  /**
   * Task #391: mileage rollback warning if detected at analysis time.
   * Legacy entries default to null (no flag).
   */
  mileageDiscrepancy: {
    currentMiles: number;
    priorMiles: number;
    priorSource: string;
    priorDate: string | null;
    gapMiles: number;
  } | null;
}

const ANALYSIS_CACHE_MAX_AGE_MS = 1000 * 60 * 60 * 4; // 4 hours

export async function getVhiFromAnalysisCache(
  db: Db,
  vin: string,
  shopId: number,
  currentMiles?: number | null
): Promise<AnalysisCacheVhiResult | null> {
  const doc = await db.collection("maintenance_analysis_cache").findOne({
    vin: vin.toUpperCase(),
    shopId: { $in: [String(shopId), Number(shopId)] },
  });

  if (!doc || !doc.recommendations || !Array.isArray(doc.recommendations) || doc.recommendations.length === 0) {
    return null;
  }

  const analyzedAt = doc.analyzedAt ? new Date(doc.analyzedAt).getTime() : 0;
  if (Date.now() - analyzedAt > ANALYSIS_CACHE_MAX_AGE_MS) {
    console.log(`[VHI] Analysis cache expired for ${vin} (age: ${Math.round((Date.now() - analyzedAt) / 60000)}m)`);
    return null;
  }

  if (currentMiles != null && currentMiles > 0 && doc.mileageAtAnalysis) {
    const diff = Math.abs(currentMiles - doc.mileageAtAnalysis);
    if (diff > 500) {
      console.log(`[VHI] Analysis cache mileage stale for ${vin} (cached: ${doc.mileageAtAnalysis}, current: ${currentMiles})`);
      return null;
    }
  }

  const recs = doc.recommendations;
  const overdue = recs.filter((r: any) => r.status === "overdue");
  const dueSoon = recs.filter((r: any) => r.status === "due_soon");
  const upcoming = recs.filter((r: any) => r.status === "upcoming");

  const rawBuckets = {
    overdue: overdue.map(convertRecToTriaged),
    dueSoon: dueSoon.map(convertRecToTriaged),
    upcoming: upcoming.map(convertRecToTriaged),
  };

  const separated = separateComplimentary(rawBuckets);
  const score = computeScore(separated);
  const tier = getScoreTier(score);

  const vehicleDoc = await db.collection("vehicles").findOne(
    { vin: vin.toUpperCase(), shopId: { $in: [String(shopId), Number(shopId)] } },
    { projection: { year: 1, make: 1, model: 1, engine: 1, customerName: 1 } }
  );

  return {
    score: { value: score, tier: tier.label, color: tier.color },
    summary: {
      overdue: separated.overdue.length,
      dueSoon: separated.dueSoon.length,
      upcoming: separated.upcoming.length,
      complimentary: separated.complimentary.length,
    },
    buckets: {
      overdue: separated.overdue.map((it) =>
        formatVhiItem(it, { currentMiles: doc.mileageAtAnalysis ?? null, bucket: "overdue" })
      ),
      dueSoon: separated.dueSoon.map((it) =>
        formatVhiItem(it, { currentMiles: doc.mileageAtAnalysis ?? null, bucket: "dueSoon" })
      ),
      upcoming: separated.upcoming.map((it) =>
        formatVhiItem(it, { currentMiles: doc.mileageAtAnalysis ?? null, bucket: "upcoming" })
      ),
      complimentary: separated.complimentary.map((it) =>
        formatVhiItem(it, { currentMiles: doc.mileageAtAnalysis ?? null, bucket: "complimentary" })
      ),
    },
    vehicle: {
      year: vehicleDoc?.year ?? null,
      make: vehicleDoc?.make ?? null,
      model: vehicleDoc?.model ?? null,
      engine: vehicleDoc?.engine ?? null,
    },
    currentMiles: doc.mileageAtAnalysis ?? null,
    distanceUnit: "miles",
    customerName: vehicleDoc?.customerName ?? null,
    cachedAt: doc.analyzedAt ? new Date(doc.analyzedAt) : new Date(),
    // Task #384: legacy entries that predate persistence default to actual.
    mileageSource: (doc.mileageSource as AnalysisCacheVhiResult["mileageSource"]) ?? "actual",
    mileageEstimateDetails:
      (doc.mileageSource ?? "actual") === "actual"
        ? null
        : (doc.mileageEstimateDetails ?? null),
    // Task #391: legacy analysis-cache rows have no discrepancy field.
    mileageDiscrepancy: doc.mileageDiscrepancy ?? null,
  };
}

function convertRecToTriaged(rec: any): TriagedItemCache {
  return {
    key: rec.serviceKey || rec.service || "",
    serviceKey: rec.serviceKey || "",
    title: rec.service || rec.name || "",
    category: rec.category || undefined,
    intervalMiles: rec.intervalMiles ?? rec.interval ?? null,
    intervalMonths: rec.intervalMonths ?? null,
    last: rec.last || undefined,
    dueAtMiles: rec.dueMileage ?? null,
    dueAtDate: null,
    milesToGo: rec.milesToGo ?? null,
    daysToGo: null,
    bump: rec.bump || null,
    source: rec.source === "shop" ? "oem" : rec.source === "oe" ? "oem" : rec.source === "dvi" ? "dvi" : "oem",
    dviSource: rec.dviSource || undefined,
    action: rec.action ?? null,
    notes: rec.notes ?? null,
    recommendedDefault: !!rec.recommendedDefault,
    recommendedReason: rec.recommendedReason ?? null,
  };
}
