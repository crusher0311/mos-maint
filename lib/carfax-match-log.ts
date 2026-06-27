/**
 * Task #655: in-memory tally of CARFAX service descriptions that did not
 * resolve to any canonical service key (`toKeyFromFreeText`) and did not
 * match an implies-reset parent (`findImpliesResetMatches`). Shops report
 * CARFAX services showing as "not done" in VHI when the free-text /
 * category description doesn't map to a key — this records those misses so
 * an operator can review which wordings still need to be added to
 * `SERVICE_KEYS` (and mirrored across `toKeyFromName` / `toKeyFromFreeText`).
 *
 * Mirrors the proven `recordUnmatchedMake` pattern in `lib/oe-logos.ts`:
 *  - Keyed by the *normalized* description (lowercased, single-spaced) so
 *    "Oil and Filter" and "oil and  filter" collapse into one entry.
 *  - Keeps a handful of raw samples + the VINs / shops that produced them
 *    so on-call can reproduce the miss against a real vehicle.
 *  - Bounded by `MAX_UNMATCHED_TALLY_ENTRIES` to avoid unbounded growth.
 *  - `console.warn`s only the *first* time a normalized key is seen, so we
 *    don't spam logs on every plan build.
 *  - Tally is per Node process and resets on redeploy (same as oe-logos).
 */

export interface UnmatchedCarfaxEntry {
  /** Normalized description (lowercase, single-spaced). */
  key: string;
  /** Number of times this description has been seen unmatched. */
  count: number;
  /** ISO timestamp of the first miss for this key. */
  firstSeen: string;
  /** ISO timestamp of the most recent miss for this key. */
  lastSeen: string;
  /** Whether the miss came from a per-record line or the category rollup. */
  sources: Array<"record" | "category">;
  /** Up to a handful of raw description strings (original casing). */
  samples: string[];
  /** Up to a handful of VINs that produced this miss. */
  vins: string[];
  /** Up to a handful of shop ids that produced this miss. */
  shopIds: string[];
}

const MAX_UNMATCHED_TALLY_ENTRIES = 500;
const MAX_SAMPLES_PER_ENTRY = 5;

const unmatchedCarfaxTally = new Map<string, UnmatchedCarfaxEntry>();

/** Normalize a description to a stable tally key. Exported for tests. */
export function normalizeCarfaxDescription(raw: string | null | undefined): string {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function pushBounded(arr: string[], value: string | null | undefined): void {
  const v = String(value ?? "").trim();
  if (!v) return;
  if (arr.length < MAX_SAMPLES_PER_ENTRY && !arr.includes(v)) arr.push(v);
}

/**
 * Record one unmatched CARFAX description. Deduped by normalized text and
 * bounded; logs once per distinct normalized description. No-ops on blank
 * input.
 */
export function recordUnmatchedCarfaxDescription(
  rawDesc: string | null | undefined,
  ctx?: {
    vin?: string | null;
    shopId?: string | number | null;
    source?: "record" | "category";
  },
): void {
  const key = normalizeCarfaxDescription(rawDesc);
  if (!key) return;

  const now = new Date().toISOString();
  const source = ctx?.source ?? "record";
  const existing = unmatchedCarfaxTally.get(key);

  if (existing) {
    existing.count += 1;
    existing.lastSeen = now;
    if (!existing.sources.includes(source)) existing.sources.push(source);
    pushBounded(existing.samples, String(rawDesc ?? ""));
    if (ctx?.vin) pushBounded(existing.vins, String(ctx.vin).toUpperCase());
    if (ctx?.shopId != null) pushBounded(existing.shopIds, String(ctx.shopId));
    return;
  }

  if (unmatchedCarfaxTally.size >= MAX_UNMATCHED_TALLY_ENTRIES) {
    // Tally full; drop further new keys rather than evicting data an
    // operator may still be reviewing.
    return;
  }

  const entry: UnmatchedCarfaxEntry = {
    key,
    count: 1,
    firstSeen: now,
    lastSeen: now,
    sources: [source],
    samples: [],
    vins: [],
    shopIds: [],
  };
  pushBounded(entry.samples, String(rawDesc ?? ""));
  if (ctx?.vin) pushBounded(entry.vins, String(ctx.vin).toUpperCase());
  if (ctx?.shopId != null) pushBounded(entry.shopIds, String(ctx.shopId));
  unmatchedCarfaxTally.set(key, entry);

  console.warn(
    `[carfax-match] No service key for CARFAX ${source} ` +
      `${JSON.stringify(String(rawDesc ?? ""))} ` +
      `(shop ${ctx?.shopId ?? "?"}, VIN ${ctx?.vin ?? "?"}). ` +
      `Add wording to SERVICE_KEYS in lib/service-keys.ts (keep ` +
      `toKeyFromName / toKeyFromFreeText in sync).`,
  );
}

/**
 * Snapshot of the current unmatched-CARFAX tally, sorted by miss count
 * descending then most-recently-seen. Safe to call from admin views.
 */
export function getUnmatchedCarfaxTally(): UnmatchedCarfaxEntry[] {
  return Array.from(unmatchedCarfaxTally.values())
    .map((e) => ({
      ...e,
      sources: [...e.sources],
      samples: [...e.samples],
      vins: [...e.vins],
      shopIds: [...e.shopIds],
    }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return b.lastSeen.localeCompare(a.lastSeen);
    });
}

/** Reset the tally. For admin "clear" actions and tests. */
export function clearUnmatchedCarfaxTally(): void {
  unmatchedCarfaxTally.clear();
}
