// Repository for reading extension telemetry events (Task #1112).
//
// The write side lives in `app/api/extension/telemetry/route.ts` (an
// allowlisted legacy direct-db route). This is the ONLY other layer that
// touches the `extension_telemetry_events` Mongo collection; the
// /platform-admin telemetry API reads through it.
//
// Query shape is kept index-friendly: every query anchors on either the
// `{ mosShopId, event, occurredAt }` compound index or the `{ event,
// occurredAt }` / TTL `{ occurredAt }` indexes that the write route
// creates — no unindexed scans over the 30-day window.
import { getDb } from "@/lib/data/db";

const COLLECTION = "extension_telemetry_events";

export interface TelemetryEventRow {
  id: string;
  event: string;
  provider: string | null;
  mosShopId: number | null;
  smsShopId: string | null;
  shopName: string | null;
  endpoint: string | null;
  userEmail: string | null;
  extensionVersion: string | null;
  payload: Record<string, unknown>;
  occurredAt: string;
}

export interface TelemetryShopRollup {
  mosShopId: number | null;
  shopName: string | null;
  totalEvents: number;
  errorCount: number;
  slowCallCount: number;
  fetchFailureCount: number;
  p95DurationMs: number | null;
  lastOccurredAt: string | null;
}

export interface TelemetryQueryFilters {
  /** MOS shop id to filter on (null/undefined = all shops). */
  shopId?: number | null;
  /** Exact event name (null/undefined = all events). */
  event?: string | null;
  /** Look-back window in hours (clamped 1..720 by the caller). */
  hours: number;
  /** Max events returned by listRecentEvents. */
  limit?: number;
}

function buildMatch(filters: TelemetryQueryFilters): Record<string, unknown> {
  const since = new Date(Date.now() - filters.hours * 60 * 60 * 1000);
  const match: Record<string, unknown> = { occurredAt: { $gte: since } };
  if (filters.shopId != null) match.mosShopId = filters.shopId;
  if (filters.event) match.event = filters.event;
  return match;
}

async function resolveShopNames(
  db: any,
  shopIds: Array<number | null>,
): Promise<Map<string, string>> {
  const ids = Array.from(new Set(shopIds.filter((id) => id != null))) as number[];
  const names = new Map<string, string>();
  if (ids.length === 0) return names;
  const docs = await db
    .collection("shops")
    .find(
      {
        $or: [
          { shopId: { $in: ids.map(String) } },
          { shopId: { $in: ids } },
        ],
      },
      { projection: { shopId: 1, name: 1 } },
    )
    .toArray();
  for (const s of docs as any[]) {
    names.set(String(s.shopId), s.name || "");
  }
  return names;
}

/** Recent raw events, newest first, honoring shop/event/time filters. */
export async function listRecentTelemetryEvents(
  filters: TelemetryQueryFilters,
): Promise<TelemetryEventRow[]> {
  const db = await getDb();
  const limit = Math.min(Math.max(filters.limit ?? 200, 1), 500);
  const docs = await db
    .collection(COLLECTION)
    .find(buildMatch(filters))
    .sort({ occurredAt: -1 })
    .limit(limit)
    .toArray();

  const names = await resolveShopNames(db, docs.map((d: any) => d.mosShopId ?? null));

  return (docs as any[]).map((d) => ({
    id: String(d._id),
    event: d.event,
    provider: d.provider ?? null,
    mosShopId: d.mosShopId ?? null,
    smsShopId: d.smsShopId ?? null,
    shopName: d.mosShopId != null ? names.get(String(d.mosShopId)) || null : null,
    endpoint: d.endpoint ?? null,
    userEmail: d.userEmail ?? null,
    extensionVersion: d.extensionVersion ?? null,
    payload: d.payload || {},
    occurredAt: d.occurredAt instanceof Date ? d.occurredAt.toISOString() : String(d.occurredAt),
  }));
}

// p95 over a sorted ascending array (nearest-rank).
export function p95(sortedAsc: number[]): number | null {
  if (!sortedAsc.length) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil(sortedAsc.length * 0.95) - 1);
  return sortedAsc[Math.max(0, idx)];
}

/**
 * Occurrence-weighted p95 (nearest-rank over cumulative weight). A
 * throttled document carrying count=100 represents 100 occurrences of
 * (approximately) that duration, so it must weigh 100× a count=1 doc —
 * unweighted p95 over stored documents materially misstates latency for
 * throttled shops. Never expands weights into an array (bounded work).
 */
export function weightedP95(pairs: Array<{ d: number; w: number }>): number | null {
  const valid = pairs.filter(
    (p) => typeof p.d === "number" && Number.isFinite(p.d) && Number.isFinite(p.w) && p.w > 0,
  );
  if (!valid.length) return null;
  valid.sort((a, b) => a.d - b.d);
  const totalW = valid.reduce((a, p) => a + p.w, 0);
  const target = totalW * 0.95;
  let cum = 0;
  for (const p of valid) {
    cum += p.w;
    if (cum >= target) return p.d;
  }
  return valid[valid.length - 1].d;
}

// One Mongo group per (shop, event). `occurrences` sums the throttle's
// suppressed-count carry-over (`payload.count`, default 1 per doc) so a
// throttled burst — e.g. one stored client.error doc carrying count=50 —
// is not underreported as a single event.
export interface TelemetryRollupGroup {
  mosShopId: number | null;
  event: string;
  docs: number;
  occurrences: number;
  lastOccurredAt: Date | string | null;
  /** Occurrence-weighted duration samples: `w` = payload.count (default 1). */
  durations: Array<{ d: number; w: number }>;
}

/**
 * Pure per-shop combiner over (shop, event) groups. Exported separately
 * so the occurrence-vs-document counting rules are unit-testable without
 * a live Mongo (see tests/extension-telemetry-throttle.smoke.ts).
 */
export function combineTelemetryRollupGroups(
  groups: TelemetryRollupGroup[],
): Omit<TelemetryShopRollup, "shopName">[] {
  const byShop = new Map<string, Omit<TelemetryShopRollup, "shopName"> & { _durations: Array<{ d: number; w: number }> }>();
  for (const g of groups) {
    const key = String(g.mosShopId ?? "null");
    let row = byShop.get(key);
    if (!row) {
      row = {
        mosShopId: g.mosShopId ?? null,
        totalEvents: 0,
        errorCount: 0,
        slowCallCount: 0,
        fetchFailureCount: 0,
        p95DurationMs: null,
        lastOccurredAt: null,
        _durations: [],
      };
      byShop.set(key, row);
    }
    const occ = Number.isFinite(g.occurrences) && g.occurrences > 0 ? g.occurrences : g.docs;
    row.totalEvents += occ;
    if (g.event === "client.error") row.errorCount += occ;
    if (g.event === "api.slow_call") row.slowCallCount += occ;
    if (g.event === "api.fetch_failure") row.fetchFailureCount += occ;
    const last = g.lastOccurredAt
      ? (g.lastOccurredAt instanceof Date ? g.lastOccurredAt.toISOString() : String(g.lastOccurredAt))
      : null;
    if (last && (!row.lastOccurredAt || last > row.lastOccurredAt)) row.lastOccurredAt = last;
    for (const s of g.durations || []) {
      if (s && typeof s.d === "number" && Number.isFinite(s.d)) {
        row._durations.push({ d: s.d, w: Number.isFinite(s.w) && s.w > 0 ? s.w : 1 });
      }
    }
  }
  const rows = Array.from(byShop.values()).map((r) => {
    const { _durations, ...rest } = r;
    return { ...rest, p95DurationMs: weightedP95(_durations) };
  });
  rows.sort((a, b) => b.totalEvents - a.totalEvents);
  return rows.slice(0, 200);
}

/**
 * Duration histogram resolution for the rollup p95 (ms). Durations are
 * bucketed to this width IN MONGO (`floor(durationMs / width) * width`),
 * so the aggregation sums weights over the COMPLETE matched population —
 * no `$push`/`$slice` sampling, which would silently drop an unbounded
 * (and unordered, i.e. biased) share of the distribution for busy shops.
 * Bucket cardinality per (shop, event) is bounded by the duration range
 * (e.g. a 0–120s spread is ≤ 2400 buckets), and the reported p95 is the
 * bucket floor — at most `width` ms below the true value.
 */
export const ROLLUP_DURATION_BUCKET_MS = 50;

export async function getTelemetryShopRollup(
  filters: TelemetryQueryFilters,
): Promise<TelemetryShopRollup[]> {
  const db = await getDb();
  const grouped = await db
    .collection(COLLECTION)
    .aggregate([
      { $match: buildMatch(filters) },
      {
        // One group per (shop, event, duration-bucket). Docs/occurrence
        // totals are partitioned across buckets and re-summed by the pure
        // combiner, while the summed per-bucket weight gives an exact
        // occurrence-weighted histogram of ALL matched durations.
        $group: {
          _id: {
            shop: "$mosShopId",
            event: "$event",
            bucket: {
              $cond: [
                { $isNumber: "$payload.durationMs" },
                {
                  $multiply: [
                    { $floor: { $divide: ["$payload.durationMs", ROLLUP_DURATION_BUCKET_MS] } },
                    ROLLUP_DURATION_BUCKET_MS,
                  ],
                },
                null,
              ],
            },
          },
          docs: { $sum: 1 },
          // Throttled events carry suppressed occurrences in payload.count.
          occurrences: {
            $sum: { $cond: [{ $isNumber: "$payload.count" }, "$payload.count", 1] },
          },
          lastOccurredAt: { $max: "$occurredAt" },
          durationWeight: {
            $sum: {
              $cond: [
                { $isNumber: "$payload.durationMs" },
                { $cond: [{ $isNumber: "$payload.count" }, "$payload.count", 1] },
                0,
              ],
            },
          },
        },
      },
    ])
    .toArray();

  const groups: TelemetryRollupGroup[] = (grouped as any[]).map((g) => ({
    mosShopId: g._id?.shop ?? null,
    event: g._id?.event ?? "",
    docs: g.docs || 0,
    occurrences: g.occurrences || 0,
    lastOccurredAt: g.lastOccurredAt ?? null,
    durations:
      typeof g._id?.bucket === "number" && g.durationWeight > 0
        ? [{ d: g._id.bucket, w: g.durationWeight }]
        : [],
  }));

  const rows = combineTelemetryRollupGroups(groups);
  const names = await resolveShopNames(db, rows.map((r) => r.mosShopId));
  return rows.map((r) => ({
    ...r,
    shopName: r.mosShopId != null ? names.get(String(r.mosShopId)) || null : null,
  }));
}

/** Distinct event names in the window (for the filter dropdown). */
export async function listTelemetryEventNames(hours: number): Promise<string[]> {
  const db = await getDb();
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const names = await db
    .collection(COLLECTION)
    .distinct("event", { occurredAt: { $gte: since } });
  return (names as string[]).sort();
}
