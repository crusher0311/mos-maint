import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { sendEmail } from "@/lib/email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Backfill chunk-speed health monitor.
 *
 * Reads the same per-chunk roll-up the platform-admin sync-health view shows
 * (`recentChunkMetrics` on each provider's progress row) and pages on-call
 * when a shop's chunk metrics breach a threshold:
 *   - slow_p95         — p95 chunk wall-clock > SLOW_P95_THRESHOLD_MS
 *   - high_backoff     — average per-chunk 429 backoff > HIGH_BACKOFF_AVG_MS
 *   - low_cache_hit    — any cache (jobs/vehicles/customers) hit rate
 *                        is below LOW_CACHE_HIT_RATE on a meaningful sample
 *
 * Covers all three providers (Tekmetric, Protractor, Shop-Ware). The
 * `tekmetric-backfill-health` cron previously inlined a slow_chunk_p95 reason
 * for Tekmetric; that has been removed in favor of this dedicated cron so a
 * Tekmetric shop with only a slow-p95 problem is not double-paged.
 *
 * Dedup strategy (state-based, per provider+shop+reason set, NOT date-based,
 * so the same already-known regression doesn't re-page every day):
 *   - One row per (provider, shopId) in `backfill_chunk_speed_alerts`.
 *   - Email is sent only when the row is first inserted, OR when the shop's
 *     reasons change (e.g. went from `slow_p95` to `slow_p95+high_backoff`).
 *   - When a previously alerted shop is no longer breaching thresholds, its
 *     alert row is deleted so it can re-page if it regresses again later.
 *
 * The notification links back to the platform-admin sync-health page so
 * on-call can drill into the offending shop's chunk-speed table directly.
 *
 * Auth: standard `Authorization: Bearer ${CRON_SECRET}` (same as the other
 * crons under /api/cron/).
 *
 * Trigger: daily via the in-process node-cron scheduler — registered in
 * `lib/cron/jobs.cjs` (CRON_JOBS) and bootstrapped by
 * `src/instrumentation.ts` whenever ENABLE_INPROCESS_CRON=true. Scheduled
 * after the 01:00/02:00/03:00 UTC backfill runs and after the 06:30 UTC
 * tekmetric-backfill-health cron so it sees fresh `recentChunkMetrics`.
 */

// Slow chunk p95 threshold. Matches `SLOW_P95_THRESHOLD_MS` in
// `app/api/admin/sync-health/route.ts` so the alert and the dashboard's
// "slow" badge can never disagree on which shops are slow.
const SLOW_P95_THRESHOLD_MS = 10 * 60 * 1000;

// Average per-chunk 429-backoff threshold. A shop that is consistently
// being rate-limited spends real wall-clock waiting on retries; an average
// over a minute per chunk indicates persistent backpressure that the cache
// can't absorb. Note: 429 backoff is approximate when multiple shops run
// concurrently (one shop's backoff can leak into another's chunk delta), so
// we deliberately use a high threshold to keep false positives down.
const HIGH_BACKOFF_AVG_MS = 60 * 1000;

// Cache hit rate floor. The chunk-speed roll-up exposes per-cache hit rates
// (jobs, vehicles, customers) as fractions in [0..1]. A healthy backfill
// runs at >70% on every cache; below 50% means the cache layer is missing
// most lookups and the chunk is largely API-bound. Page when any cache
// drops below this floor.
const LOW_CACHE_HIT_RATE = 0.5;

// Minimum samples in a cache before low-hit-rate is considered. A shop
// that just started will have a tiny sample and shouldn't page. The
// chunk-speed roll-up sums hits+misses across the rolling 25-chunk window
// so 50 lookups is roughly "two real chunks worth of API calls".
const LOW_CACHE_MIN_LOOKUPS = 50;

// Avoid paging on a single anomalous chunk. Min sample count before any
// chunk-level threshold (slow_p95, high_backoff) is allowed to fire. The
// rolling window cap is 25, so 3 is enough to make p95 / averages
// meaningful without blocking detection on shops that are still ramping up.
const MIN_CHUNK_SAMPLES = 3;

type ProviderKey = "tekmetric" | "protractor" | "shopware";

type ProviderConfig = {
  key: ProviderKey;
  label: string;
  collectionName: string;
};

const PROVIDERS: ProviderConfig[] = [
  { key: "tekmetric", label: "Tekmetric", collectionName: "tekmetric_backfill_progress" },
  { key: "protractor", label: "Protractor", collectionName: "backfill_progress" },
  { key: "shopware", label: "Shop-Ware", collectionName: "shopware_backfill_progress" },
];

type ChunkRollup = {
  chunkSampleCount: number;
  p95DurationMs: number | null;
  avgBackoff429Ms: number | null;
  jobsCacheHitRate: number | null;
  jobsCacheTotal: number;
  vehiclesCacheHitRate: number | null;
  vehiclesCacheTotal: number;
  customersCacheHitRate: number | null;
  customersCacheTotal: number;
};

type SlowShop = {
  provider: ProviderKey;
  providerLabel: string;
  shopId: number;
  name: string;
  reasons: string[];
  reasonsKey: string;
  rollup: ChunkRollup;
};

// Inclusive percentile from a sorted-ascending array. Matches the
// implementation in `app/api/admin/sync-health/route.ts` so the alert
// thresholds and the admin "slow shop" badge always agree.
function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

function summarize(recent: any[]): ChunkRollup | null {
  if (!Array.isArray(recent) || recent.length === 0) return null;
  const durations: number[] = [];
  let jobsHits = 0,
    jobsMisses = 0;
  let vehHits = 0,
    vehMisses = 0;
  let custHits = 0,
    custMisses = 0;
  let backoffMsTotal = 0;
  let backoffSampleCount = 0;
  for (const m of recent) {
    if (typeof m?.durationMs === "number" && Number.isFinite(m.durationMs)) {
      durations.push(m.durationMs);
    }
    jobsHits += Number(m?.jobsCacheHits || 0);
    jobsMisses += Number(m?.jobsCacheMisses || 0);
    vehHits += Number(m?.vehiclesCacheHits || 0);
    vehMisses += Number(m?.vehiclesCacheMisses || 0);
    custHits += Number(m?.customersCacheHits || 0);
    custMisses += Number(m?.customersCacheMisses || 0);
    if (typeof m?.backoff429Ms === "number") {
      backoffMsTotal += m.backoff429Ms;
      backoffSampleCount++;
    }
  }
  durations.sort((a, b) => a - b);
  const p95 = percentile(durations, 95);
  const jobsTotal = jobsHits + jobsMisses;
  const vehTotal = vehHits + vehMisses;
  const custTotal = custHits + custMisses;
  return {
    chunkSampleCount: recent.length,
    p95DurationMs: p95 == null ? null : Math.round(p95),
    avgBackoff429Ms: backoffSampleCount > 0
      ? Math.round(backoffMsTotal / backoffSampleCount)
      : null,
    jobsCacheHitRate: jobsTotal > 0 ? jobsHits / jobsTotal : null,
    jobsCacheTotal: jobsTotal,
    vehiclesCacheHitRate: vehTotal > 0 ? vehHits / vehTotal : null,
    vehiclesCacheTotal: vehTotal,
    customersCacheHitRate: custTotal > 0 ? custHits / custTotal : null,
    customersCacheTotal: custTotal,
  };
}

function evaluateShop(
  provider: ProviderConfig,
  progressRow: any,
  shopNamesById: Map<number, string>,
): SlowShop | null {
  // Only evaluate in-flight shops. A completed shop legitimately stops
  // running and its stale roll-up isn't actionable.
  if (progressRow.completed) return null;

  const rollup = summarize(progressRow.recentChunkMetrics);
  if (!rollup) return null;

  const reasons: string[] = [];

  if (
    rollup.chunkSampleCount >= MIN_CHUNK_SAMPLES &&
    rollup.p95DurationMs != null &&
    rollup.p95DurationMs > SLOW_P95_THRESHOLD_MS
  ) {
    reasons.push("slow_p95");
  }

  if (
    rollup.chunkSampleCount >= MIN_CHUNK_SAMPLES &&
    rollup.avgBackoff429Ms != null &&
    rollup.avgBackoff429Ms > HIGH_BACKOFF_AVG_MS
  ) {
    reasons.push("high_backoff");
  }

  // Cache hit rate check: only fire when the cache has been used enough
  // for the rate to be meaningful. We check each cache independently and
  // emit one reason per offender so the alert payload makes the offender
  // explicit (e.g. "low_jobs_cache+low_vehicles_cache").
  if (
    rollup.jobsCacheHitRate != null &&
    rollup.jobsCacheTotal >= LOW_CACHE_MIN_LOOKUPS &&
    rollup.jobsCacheHitRate < LOW_CACHE_HIT_RATE
  ) {
    reasons.push("low_jobs_cache");
  }
  if (
    rollup.vehiclesCacheHitRate != null &&
    rollup.vehiclesCacheTotal >= LOW_CACHE_MIN_LOOKUPS &&
    rollup.vehiclesCacheHitRate < LOW_CACHE_HIT_RATE
  ) {
    reasons.push("low_vehicles_cache");
  }
  if (
    rollup.customersCacheHitRate != null &&
    rollup.customersCacheTotal >= LOW_CACHE_MIN_LOOKUPS &&
    rollup.customersCacheHitRate < LOW_CACHE_HIT_RATE
  ) {
    reasons.push("low_customers_cache");
  }

  if (reasons.length === 0) return null;

  const shopId = Number(progressRow.shopId);
  return {
    provider: provider.key,
    providerLabel: provider.label,
    shopId,
    name: shopNamesById.get(shopId) || `Shop ${shopId}`,
    reasons,
    reasonsKey: [...reasons].sort().join(","),
    rollup,
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatMs(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function formatRate(rate: number | null, total: number): string {
  if (rate == null || total === 0) return "—";
  return `${(rate * 100).toFixed(0)}% (n=${total})`;
}

function syncHealthUrl(): string {
  const base =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.APP_BASE_URL ||
    "https://mostools.io";
  return `${base.replace(/\/+$/, "")}/platform-admin/sync-health`;
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") || "";
  const expected = process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : "";
  if (expected && auth !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = await getDb();

  // Pull progress rows for all three providers in parallel.
  const [tekmetricRows, protractorRows, shopwareRows] = await Promise.all([
    db.collection(PROVIDERS[0].collectionName).find({}).toArray(),
    db.collection(PROVIDERS[1].collectionName).find({}).toArray(),
    db.collection(PROVIDERS[2].collectionName).find({}).toArray(),
  ]);

  const providerRows: Array<{ provider: ProviderConfig; rows: any[] }> = [
    { provider: PROVIDERS[0], rows: tekmetricRows },
    { provider: PROVIDERS[1], rows: protractorRows },
    { provider: PROVIDERS[2], rows: shopwareRows },
  ];

  // Resolve human-readable shop names for every shopId we'll consider.
  const candidateShopIds = new Set<number>();
  for (const { rows } of providerRows) {
    for (const r of rows as any[]) {
      if (!r.completed) candidateShopIds.add(Number(r.shopId));
    }
  }
  const shopDocs =
    candidateShopIds.size > 0
      ? await db
          .collection("shops")
          .find(
            { shopId: { $in: Array.from(candidateShopIds) } },
            { projection: { shopId: 1, name: 1, locationIdentifier: 1 } },
          )
          .toArray()
      : [];
  const shopNamesById = new Map<number, string>();
  for (const s of shopDocs as any[]) {
    const display = s.locationIdentifier
      ? `${s.name || "(unnamed)"} — ${s.locationIdentifier}`
      : s.name || "(unnamed)";
    shopNamesById.set(Number(s.shopId), display);
  }

  // Evaluate every (provider, shop) pair.
  const slow: SlowShop[] = [];
  for (const { provider, rows } of providerRows) {
    for (const row of rows as any[]) {
      const result = evaluateShop(provider, row, shopNamesById);
      if (result) slow.push(result);
    }
  }

  // State-based dedup, keyed on (provider, shopId). Re-alert only on first
  // detection or when reasons change. Resolved shops are removed so they
  // can re-page later if they regress again.
  const alertsCollection = db.collection("backfill_chunk_speed_alerts");
  await alertsCollection
    .createIndex(
      { provider: 1, shopId: 1 },
      { unique: true, name: "uniq_provider_shopId" },
    )
    .catch(() => {});

  const slowKeySet = new Set(slow.map((s) => `${s.provider}:${s.shopId}`));
  const existingDocs = await alertsCollection.find({}).toArray();
  const existingByKey = new Map<string, any>();
  for (const d of existingDocs as any[]) {
    existingByKey.set(`${d.provider}:${Number(d.shopId)}`, d);
  }

  // Auto-clear: drop dedup rows for shops that are no longer breaching.
  const resolvedKeys: Array<{ provider: ProviderKey; shopId: number }> = [];
  for (const d of existingDocs as any[]) {
    const key = `${d.provider}:${Number(d.shopId)}`;
    if (!slowKeySet.has(key)) {
      resolvedKeys.push({ provider: d.provider, shopId: Number(d.shopId) });
    }
  }
  if (resolvedKeys.length > 0) {
    await alertsCollection.deleteMany({
      $or: resolvedKeys.map((k) => ({ provider: k.provider, shopId: k.shopId })),
    });
  }

  const newlySlow: SlowShop[] = [];
  const reasonsChanged: SlowShop[] = [];
  const now = new Date();

  for (const s of slow) {
    const key = `${s.provider}:${s.shopId}`;
    const existing = existingByKey.get(key);
    if (!existing) {
      newlySlow.push(s);
      await alertsCollection.updateOne(
        { provider: s.provider, shopId: s.shopId },
        {
          $set: {
            provider: s.provider,
            shopId: s.shopId,
            reasonsKey: s.reasonsKey,
            reasons: s.reasons,
            firstAlertedAt: now,
            lastAlertedAt: now,
          },
        },
        { upsert: true },
      );
    } else if (existing.reasonsKey !== s.reasonsKey) {
      reasonsChanged.push(s);
      await alertsCollection.updateOne(
        { provider: s.provider, shopId: s.shopId },
        {
          $set: {
            reasonsKey: s.reasonsKey,
            reasons: s.reasons,
            lastAlertedAt: now,
            previousReasonsKey: existing.reasonsKey,
          },
        },
      );
    } else {
      // Same reasons as last alert — touch lastSeenAt only, don't email.
      await alertsCollection.updateOne(
        { provider: s.provider, shopId: s.shopId },
        { $set: { lastSeenAt: now } },
      );
    }
  }

  const toAlert = [...newlySlow, ...reasonsChanged];

  let emailed = 0;
  if (toAlert.length > 0) {
    const admins = await db
      .collection("users")
      .find(
        { isPlatformAdmin: true, email: { $exists: true, $ne: null } },
        { projection: { email: 1 } },
      )
      .toArray();

    if (admins.length === 0) {
      console.warn(
        "[BackfillChunkSpeedHealth] No platform admins configured; alerts logged only",
      );
    } else {
      const linkBase = syncHealthUrl();
      const rows = toAlert
        .map((s) => {
          const isNew = newlySlow.includes(s);
          return `
        <tr>
          <td style="padding:6px 12px;border:1px solid #ddd">${escapeHtml(s.providerLabel)}</td>
          <td style="padding:6px 12px;border:1px solid #ddd">${escapeHtml(s.name)}</td>
          <td style="padding:6px 12px;border:1px solid #ddd">${s.shopId}</td>
          <td style="padding:6px 12px;border:1px solid #ddd">${escapeHtml(s.reasons.join(", "))}</td>
          <td style="padding:6px 12px;border:1px solid #ddd">${formatMs(s.rollup.p95DurationMs)} (n=${s.rollup.chunkSampleCount})</td>
          <td style="padding:6px 12px;border:1px solid #ddd">${formatMs(s.rollup.avgBackoff429Ms)}</td>
          <td style="padding:6px 12px;border:1px solid #ddd">${formatRate(s.rollup.jobsCacheHitRate, s.rollup.jobsCacheTotal)}</td>
          <td style="padding:6px 12px;border:1px solid #ddd">${formatRate(s.rollup.vehiclesCacheHitRate, s.rollup.vehiclesCacheTotal)}</td>
          <td style="padding:6px 12px;border:1px solid #ddd">${formatRate(s.rollup.customersCacheHitRate, s.rollup.customersCacheTotal)}</td>
          <td style="padding:6px 12px;border:1px solid #ddd">${isNew ? "NEW" : "REASONS CHANGED"}</td>
        </tr>`;
        })
        .join("");
      const html = `
        <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.5">
          <h2>Backfill Chunk-Speed Alert</h2>
          <p>${toAlert.length} shop(s) breached a chunk-speed threshold. Total currently breaching: <strong>${slow.length}</strong>.</p>
          <p>Reasons:
            <code>slow_p95</code> = p95 chunk wall-clock &gt; ${SLOW_P95_THRESHOLD_MS / 60000}m ·
            <code>high_backoff</code> = avg per-chunk 429 backoff &gt; ${HIGH_BACKOFF_AVG_MS / 1000}s ·
            <code>low_jobs_cache</code> / <code>low_vehicles_cache</code> / <code>low_customers_cache</code>
            = cache hit rate &lt; ${(LOW_CACHE_HIT_RATE * 100).toFixed(0)}%
            (with at least ${LOW_CACHE_MIN_LOOKUPS} lookups in the rolling window).
          </p>
          <p>Open the chunk-speed tables for the affected providers:
            <a href="${linkBase}">${linkBase}</a>
          </p>
          <table style="border-collapse:collapse;border:1px solid #ddd">
            <thead>
              <tr>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Provider</th>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Shop</th>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">MOS ID</th>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Reasons</th>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">p95 chunk</th>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Avg backoff</th>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Jobs cache</th>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Veh cache</th>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Cust cache</th>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Status</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
          <p style="margin-top:16px;color:#666;font-size:13px">
            Sent by <code>/api/cron/backfill-chunk-speed-health</code>. Roll-up source:
            <code>/api/admin/sync-health</code>. Already-breaching shops with unchanged reasons
            are deduped — you'll only be re-paged when something new breaks or reasons change.
          </p>
        </div>`;
      for (const admin of admins as Array<{ email: string }>) {
        try {
          await sendEmail({
            to: admin.email,
            subject: `[MOS] Backfill chunk-speed: ${toAlert.length} shop(s) breaching (${slow.length} total)`,
            html,
          });
          emailed++;
        } catch (err: any) {
          console.error(
            `[BackfillChunkSpeedHealth] Email send failed for ${admin.email}:`,
            err?.message,
          );
        }
      }
    }
  }

  console.log(
    `[BackfillChunkSpeedHealth] tekmetric=${tekmetricRows.length} protractor=${protractorRows.length} ` +
      `shopware=${shopwareRows.length} breaching=${slow.length} ` +
      `newAlerts=${newlySlow.length} reasonsChanged=${reasonsChanged.length} ` +
      `resolved=${resolvedKeys.length} emailed=${emailed}`,
  );

  return NextResponse.json({
    scanned: {
      tekmetric: tekmetricRows.length,
      protractor: protractorRows.length,
      shopware: shopwareRows.length,
    },
    breachingTotal: slow.length,
    newAlerts: newlySlow.length,
    reasonsChangedAlerts: reasonsChanged.length,
    resolvedAndCleared: resolvedKeys.length,
    emailed,
    breachingShops: slow.map((s) => ({
      provider: s.provider,
      shopId: s.shopId,
      name: s.name,
      reasons: s.reasons,
      p95DurationMs: s.rollup.p95DurationMs,
      avgBackoff429Ms: s.rollup.avgBackoff429Ms,
      chunkSampleCount: s.rollup.chunkSampleCount,
      jobsCacheHitRate: s.rollup.jobsCacheHitRate,
      vehiclesCacheHitRate: s.rollup.vehiclesCacheHitRate,
      customersCacheHitRate: s.rollup.customersCacheHitRate,
    })),
  });
}
