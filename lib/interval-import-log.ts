/**
 * In-memory tally of maintenance-guide service names that did not resolve
 * to any canonical service key during a Settings → Intervals document
 * import. Mirrors the proven `lib/carfax-match-log.ts` pattern (which in
 * turn mirrors `recordUnmatchedMake` in lib/oe-logos.ts):
 *   - keyed by the normalized name so casing/spacing variants collapse,
 *   - bounded to avoid unbounded growth,
 *   - `console.warn`s only the first time a normalized name is seen so
 *     the miss lands in the log feed for synonym-growth review,
 *   - per Node process, resets on redeploy.
 */

export interface UnmatchedIntervalImportEntry {
  key: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  samples: string[];
  shopIds: string[];
}

const MAX_ENTRIES = 500;
const MAX_SAMPLES = 5;

const tally = new Map<string, UnmatchedIntervalImportEntry>();

function normalizeName(raw: string | null | undefined): string {
  return String(raw ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function pushBounded(arr: string[], value: string | null | undefined): void {
  const v = String(value ?? "").trim();
  if (!v) return;
  if (arr.length < MAX_SAMPLES && !arr.includes(v)) arr.push(v);
}

/** Record one unmatched document service name. */
export function recordUnmatchedIntervalImportName(
  rawName: string | null | undefined,
  ctx?: { shopId?: string | number | null },
): void {
  const key = normalizeName(rawName);
  if (!key) return;

  const now = new Date().toISOString();
  const existing = tally.get(key);
  if (existing) {
    existing.count += 1;
    existing.lastSeen = now;
    pushBounded(existing.samples, String(rawName ?? ""));
    if (ctx?.shopId != null) pushBounded(existing.shopIds, String(ctx.shopId));
    return;
  }

  if (tally.size >= MAX_ENTRIES) return;

  const entry: UnmatchedIntervalImportEntry = {
    key,
    count: 1,
    firstSeen: now,
    lastSeen: now,
    samples: [],
    shopIds: [],
  };
  pushBounded(entry.samples, String(rawName ?? ""));
  if (ctx?.shopId != null) pushBounded(entry.shopIds, String(ctx.shopId));
  tally.set(key, entry);

  console.warn(
    `[interval-import] No service key for document service ` +
      `${JSON.stringify(String(rawName ?? ""))} (shop ${ctx?.shopId ?? "?"}). ` +
      `Add wording to SERVICE_KEYS in lib/service-keys.ts (keep ` +
      `toKeyFromName / toKeyFromFreeText in sync).`,
  );
}

/** Snapshot for admin views, sorted by count then recency. */
export function getUnmatchedIntervalImportTally(): UnmatchedIntervalImportEntry[] {
  return Array.from(tally.values())
    .map((e) => ({ ...e, samples: [...e.samples], shopIds: [...e.shopIds] }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : b.lastSeen.localeCompare(a.lastSeen)));
}

/** Reset the tally (tests / admin clear). */
export function clearUnmatchedIntervalImportTally(): void {
  tally.clear();
}
