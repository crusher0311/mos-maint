import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { sendEmail } from "@/lib/email";
import {
  HIGH_BACKOFF_AVG_MS,
  LOW_CACHE_HIT_RATE,
  LOW_CACHE_MIN_LOOKUPS,
  MIN_CHUNK_SAMPLES,
  P95_BASELINE_LOOKBACK,
  P95_BASELINE_MIN_SAMPLES,
  P95_HISTORY_CAP,
  P95_REGRESSION_MULTIPLIER,
  P95_REGRESSION_NOISE_FLOOR_MS,
  P95Snapshot,
  PROVIDERS,
  ProviderKey,
  SLOW_P95_THRESHOLD_MS,
  SlowShop,
  appendP95Snapshot,
  classifyDedup,
  evaluateShop,
  summarize,
} from "./lib";

/**
 * Test seam: the route handler dereferences `__deps.getDb` /
 * `__deps.sendEmail` at call time so the route-level smoke test can swap in
 * fakes without spinning up Mongo or Resend. Production callers should
 * never touch this object — it defaults to the real implementations and is
 * only mutated by `tests/backfill-chunk-speed-health.route.smoke.ts`.
 */
export const __deps = {
  getDb,
  sendEmail,
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Backfill chunk-speed health monitor.
 *
 * Reads the same per-chunk roll-up the platform-admin sync-health view shows
 * (`recentChunkMetrics` on each provider's progress row) and pages on-call
 * when a shop's chunk metrics breach a threshold:
 *   - slow_p95         — p95 chunk wall-clock > SLOW_P95_THRESHOLD_MS
 *   - regressed_p95    — current p95 > P95_REGRESSION_MULTIPLIER × the
 *                        shop's own rolling baseline (median of the prior
 *                        daily p95 snapshots) AND current p95 above the
 *                        noise floor. Catches "1m → 8m" regressions that
 *                        the absolute slow_p95 threshold would miss.
 *   - high_backoff     — average per-chunk 429 backoff > HIGH_BACKOFF_AVG_MS
 *   - low_cache_hit    — any cache (jobs/vehicles/customers) hit rate
 *                        is below LOW_CACHE_HIT_RATE on a meaningful sample
 *
 * The relative regression rule needs day-over-day history. Each cron run
 * snapshots every in-flight shop's current p95 into the
 * `backfill_chunk_p95_history` Mongo collection (one row per
 * provider+shop, capped at P95_HISTORY_CAP entries). The history is kept
 * in a *separate* collection from the alert dedup rows because the alert
 * rows auto-delete on recovery — the baseline must survive that.
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
 *
 * Threshold evaluation and dedup classification live in `./lib` so they can
 * be unit-tested without spinning up Mongo or Next.js.
 */

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

  const db = await __deps.getDb();

  // Pull progress rows for all three providers in parallel.
  const [tekmetricRows, protractorRows, shopwareRows] = await Promise.all([
    db.collection(PROVIDERS[0].collectionName).find({}).toArray(),
    db.collection(PROVIDERS[1].collectionName).find({}).toArray(),
    db.collection(PROVIDERS[2].collectionName).find({}).toArray(),
  ]);

  const providerRows: Array<{ provider: typeof PROVIDERS[number]; rows: any[] }> = [
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

  // Load the per-shop p95 snapshot history that powers the relative
  // `regressed_p95` rule. Lives in a *separate* collection because the
  // alerts collection below auto-deletes rows on recovery — we must not
  // lose the rolling baseline when a shop briefly clears its alert.
  const p95HistoryCollection = db.collection("backfill_chunk_p95_history");
  await p95HistoryCollection
    .createIndex(
      { provider: 1, shopId: 1 },
      { unique: true, name: "uniq_provider_shopId" },
    )
    .catch(() => {});
  const historyDocs = await p95HistoryCollection.find({}).toArray();
  const historyByKey = new Map<string, P95Snapshot[]>();
  for (const d of historyDocs as any[]) {
    const raw: any[] = Array.isArray(d.history) ? d.history : [];
    const parsed: P95Snapshot[] = raw
      .map((h) => ({
        at: new Date(h.at),
        p95Ms: Number(h.p95Ms),
        sampleCount: Number(h.sampleCount || 0),
      }))
      .filter((h) => !Number.isNaN(h.at.getTime()) && Number.isFinite(h.p95Ms))
      .sort((a, b) => a.at.getTime() - b.at.getTime());
    historyByKey.set(`${d.provider}:${Number(d.shopId)}`, parsed);
  }

  const now = new Date();

  // Evaluate every (provider, shop) pair, and along the way collect the
  // updated p95 history we'll persist back. We snapshot *every* in-flight
  // shop with a usable p95 (not just breaching ones) so the baseline is
  // continuously refreshed, mirroring the perm-failed RO countHistory
  // pattern.
  const slow: SlowShop[] = [];
  const historyUpdates: Array<{
    provider: ProviderKey;
    shopId: number;
    history: P95Snapshot[];
  }> = [];
  for (const { provider, rows } of providerRows) {
    for (const row of rows as any[]) {
      const shopId = Number(row.shopId);
      const key = `${provider.key}:${shopId}`;
      const priorHistory = historyByKey.get(key) ?? [];

      const result = evaluateShop(provider, row, shopNamesById, priorHistory);
      if (result) slow.push(result);

      // Independently compute the rollup so we can snapshot p95 even for
      // shops that aren't currently breaching. evaluateShop short-circuits
      // on completed shops, so we mirror that here.
      if (row.completed) continue;
      const rollup = summarize(row.recentChunkMetrics);
      if (
        rollup &&
        rollup.chunkSampleCount >= MIN_CHUNK_SAMPLES &&
        rollup.p95DurationMs != null &&
        Number.isFinite(rollup.p95DurationMs)
      ) {
        const updated = appendP95Snapshot(priorHistory, {
          at: now,
          p95Ms: rollup.p95DurationMs,
          sampleCount: rollup.chunkSampleCount,
        });
        historyUpdates.push({ provider: provider.key, shopId, history: updated });
      }
    }
  }

  // Persist updated p95 history. Bulk-write keeps Mongo round-trips bounded
  // even when hundreds of shops produce snapshots.
  if (historyUpdates.length > 0) {
    await p95HistoryCollection.bulkWrite(
      historyUpdates.map((u) => ({
        updateOne: {
          filter: { provider: u.provider, shopId: u.shopId },
          update: {
            $set: {
              provider: u.provider,
              shopId: u.shopId,
              history: u.history,
              lastSnapshotAt: now,
            },
          },
          upsert: true,
        },
      })),
    );
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

  const existingDocs = await alertsCollection.find({}).toArray();
  const { newlySlow, reasonsChanged, unchanged, resolved } = classifyDedup(
    slow,
    existingDocs as any[],
  );
  const existingByKey = new Map<string, any>();
  for (const d of existingDocs as any[]) {
    existingByKey.set(`${d.provider}:${Number(d.shopId)}`, d);
  }

  // Defensive Mongo Date parsing: rows written by older cron versions or
  // direct Mongo edits may contain non-Date values; reject anything that
  // can't be coerced to a finite epoch so the recovery email's
  // .toISOString() never crashes the cron.
  const parseDateSafe = (v: any): Date | null => {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v as any);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const parseFiniteNumber = (v: any): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;

  // Tekmetric-only recovery emails. Two transitions count as recovery:
  //   (a) Full auto-clear — the row is in `resolved` and its prior reasons
  //       included `slow_p95` (shop dropped under the p95 threshold OR
  //       completed its backfill).
  //   (b) Partial recovery — the row is in `reasonsChanged` and its prior
  //       reasons included `slow_p95` but the new reasons don't (shop
  //       still has another non-slow reason like `high_backoff`, but the
  //       p95 regression itself cleared).
  // The brief calls out both: "transitions back to no reasons (or no slow
  // reason at all)". Captured BEFORE deleteMany so the prior reasonsKey
  // and last-seen p95 are still available; the `reasonsChanged` updates
  // overwrite those fields below.
  type TekmetricRecovery = {
    shopId: number;
    previousReasons: string[];
    lastSeenP95Ms: number | null;
    lastSeenAt: Date | null;
    transition: "auto_clear" | "reasons_changed";
  };
  const tekmetricRecoveries: TekmetricRecovery[] = [];

  for (const k of resolved) {
    if (k.provider !== "tekmetric") continue;
    const existing = existingByKey.get(`tekmetric:${k.shopId}`);
    const reasonsKey = String(existing?.reasonsKey || "");
    const previousReasons = reasonsKey ? reasonsKey.split(",") : [];
    if (!previousReasons.includes("slow_p95")) continue;
    tekmetricRecoveries.push({
      shopId: k.shopId,
      previousReasons,
      lastSeenP95Ms: parseFiniteNumber(existing?.lastSeenP95Ms),
      lastSeenAt:
        parseDateSafe(existing?.lastSeenAt) ??
        parseDateSafe(existing?.lastAlertedAt),
      transition: "auto_clear",
    });
  }

  for (const s of reasonsChanged) {
    if (s.provider !== "tekmetric") continue;
    const existing = existingByKey.get(`tekmetric:${s.shopId}`);
    const priorKey = String(existing?.reasonsKey || "");
    const priorReasons = priorKey ? priorKey.split(",") : [];
    const hadSlow = priorReasons.includes("slow_p95");
    const stillSlow = s.reasons.includes("slow_p95");
    if (!hadSlow || stillSlow) continue;
    tekmetricRecoveries.push({
      shopId: s.shopId,
      previousReasons: priorReasons,
      lastSeenP95Ms: parseFiniteNumber(existing?.lastSeenP95Ms),
      lastSeenAt:
        parseDateSafe(existing?.lastSeenAt) ??
        parseDateSafe(existing?.lastAlertedAt),
      transition: "reasons_changed",
    });
  }

  // Auto-clear: drop dedup rows for shops that are no longer breaching.
  // Deleting after capturing recoveries above means a re-pageable shop
  // starts from a clean slate — if it slows down again, it inserts a new
  // row (newlySlow) and pages, then resolving again will fire another
  // recovery email. That gives "at most once per recovery" naturally.
  if (resolved.length > 0) {
    await alertsCollection.deleteMany({
      $or: resolved.map((k) => ({ provider: k.provider, shopId: k.shopId })),
    });
  }

  for (const s of newlySlow) {
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
          lastSeenAt: now,
          lastSeenP95Ms: s.rollup.p95DurationMs,
        },
      },
      { upsert: true },
    );
  }
  for (const s of reasonsChanged) {
    const existing = existingByKey.get(`${s.provider}:${s.shopId}`);
    await alertsCollection.updateOne(
      { provider: s.provider, shopId: s.shopId },
      {
        $set: {
          reasonsKey: s.reasonsKey,
          reasons: s.reasons,
          lastAlertedAt: now,
          lastSeenAt: now,
          lastSeenP95Ms: s.rollup.p95DurationMs,
          previousReasonsKey: existing?.reasonsKey,
        },
      },
    );
  }
  for (const s of unchanged) {
    // Same reasons as last alert — don't email, but still keep lastSeenAt
    // and lastSeenP95Ms fresh so the recovery email (if/when this row
    // auto-clears) reports the most recent slow p95 we observed.
    await alertsCollection.updateOne(
      { provider: s.provider, shopId: s.shopId },
      { $set: { lastSeenAt: now, lastSeenP95Ms: s.rollup.p95DurationMs } },
    );
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
          // For shops that tripped the relative regression rule, show the
          // baseline and the multiplier inline with the p95 cell so on-call
          // can see at a glance how far the shop has degraded — the whole
          // point of the rule is that the absolute number alone might not
          // look alarming yet.
          const p95Cell =
            s.p95Baseline != null && s.rollup.p95DurationMs != null
              ? `${formatMs(s.rollup.p95DurationMs)} (n=${s.rollup.chunkSampleCount}, ` +
                `${(s.rollup.p95DurationMs / s.p95Baseline).toFixed(1)}× baseline ${formatMs(s.p95Baseline)})`
              : `${formatMs(s.rollup.p95DurationMs)} (n=${s.rollup.chunkSampleCount})`;
          return `
        <tr>
          <td style="padding:6px 12px;border:1px solid #ddd">${escapeHtml(s.providerLabel)}</td>
          <td style="padding:6px 12px;border:1px solid #ddd">${escapeHtml(s.name)}</td>
          <td style="padding:6px 12px;border:1px solid #ddd">${s.shopId}</td>
          <td style="padding:6px 12px;border:1px solid #ddd">${escapeHtml(s.reasons.join(", "))}</td>
          <td style="padding:6px 12px;border:1px solid #ddd">${p95Cell}</td>
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
            <code>regressed_p95</code> = p95 &gt; ${P95_REGRESSION_MULTIPLIER}× rolling baseline
            (median of the last ${P95_BASELINE_LOOKBACK} daily snapshots, min ${P95_BASELINE_MIN_SAMPLES}),
            with current p95 also &gt; ${P95_REGRESSION_NOISE_FLOOR_MS / 60000}m ·
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
          await __deps.sendEmail({
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

  // Resolve names for any recovered Tekmetric shops not already in
  // shopNamesById (e.g. a shop that completed its backfill while it had a
  // slow_p95 alert is excluded from the in-flight name lookup above).
  let recoveryEmailed = 0;
  if (tekmetricRecoveries.length > 0) {
    const missingNameIds = tekmetricRecoveries
      .filter((r) => !shopNamesById.has(r.shopId))
      .map((r) => r.shopId);
    if (missingNameIds.length > 0) {
      const extra = await db
        .collection("shops")
        .find(
          { shopId: { $in: missingNameIds } },
          { projection: { shopId: 1, name: 1, locationIdentifier: 1 } },
        )
        .toArray();
      for (const s of extra as any[]) {
        const display = s.locationIdentifier
          ? `${s.name || "(unnamed)"} — ${s.locationIdentifier}`
          : s.name || "(unnamed)";
        shopNamesById.set(Number(s.shopId), display);
      }
    }

    const admins = await db
      .collection("users")
      .find(
        { isPlatformAdmin: true, email: { $exists: true, $ne: null } },
        { projection: { email: 1 } },
      )
      .toArray();
    if (admins.length === 0) {
      console.warn(
        "[BackfillChunkSpeedHealth] No platform admins configured; recovery emails logged only",
      );
    } else {
      const linkBase = syncHealthUrl();
      for (const r of tekmetricRecoveries) {
        const name = shopNamesById.get(r.shopId) || `Shop ${r.shopId}`;
        const lastP95 = formatMs(r.lastSeenP95Ms);
        const lastSeen = r.lastSeenAt ? r.lastSeenAt.toISOString() : "—";
        const otherReasons = r.previousReasons.filter((x) => x !== "slow_p95");
        const isFullClear = r.transition === "auto_clear";
        // For partial recovery the dedup row stays alive (the row was just
        // updated to the new reasons in `reasonsChanged`); for full clear
        // the row was deleted just above. Wording matches each case so
        // on-call understands whether anything still needs attention.
        const stateNote = isFullClear
          ? `<p>The dedup row has been cleared, so the shop can re-page if it
              slows down again.</p>`
          : `<p>Other reasons still active: <code>${escapeHtml(
              otherReasons.length > 0 ? otherReasons.join(", ") : "(none)",
            )}</code>. The dedup row remains so those won't re-page; a fresh
              <code>slow_p95</code> regression will trigger another alert.</p>`;
        const otherReasonsBlock =
          isFullClear && otherReasons.length > 0
            ? `<p>Previous reasons also included:
                <code>${escapeHtml(otherReasons.join(", "))}</code>.
                Those cleared too in this auto-clear.</p>`
            : "";
        const html = `
          <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.5">
            <h2>Tekmetric Slow-Chunk Recovery</h2>
            <p><strong>${escapeHtml(name)}</strong> (MOS shop ${r.shopId})
              has dropped back under the
              ${SLOW_P95_THRESHOLD_MS / 60000}-minute p95 chunk threshold.</p>
            <p>Last-seen p95 before recovery: <strong>${lastP95}</strong>
              (observed at ${escapeHtml(lastSeen)}).</p>
            ${otherReasonsBlock}
            ${stateNote}
            <p><a href="${linkBase}">${linkBase}</a></p>
            <p style="margin-top:16px;color:#666;font-size:13px">
              Sent by <code>/api/cron/backfill-chunk-speed-health</code>
              on ${isFullClear ? "auto-clear of" : "slow_p95 drop in"}
              <code>backfill_chunk_speed_alerts</code>.
            </p>
          </div>`;
        for (const admin of admins as Array<{ email: string }>) {
          try {
            await __deps.sendEmail({
              to: admin.email,
              subject: `[MOS] Tekmetric slow-chunk recovered: ${name}`,
              html,
            });
            recoveryEmailed++;
          } catch (err: any) {
            console.error(
              `[BackfillChunkSpeedHealth] Recovery email send failed for ${admin.email}:`,
              err?.message,
            );
          }
        }
      }
    }
  }

  console.log(
    `[BackfillChunkSpeedHealth] tekmetric=${tekmetricRows.length} protractor=${protractorRows.length} ` +
      `shopware=${shopwareRows.length} breaching=${slow.length} ` +
      `newAlerts=${newlySlow.length} reasonsChanged=${reasonsChanged.length} ` +
      `resolved=${resolved.length} emailed=${emailed} ` +
      `tekmetricRecoveries=${tekmetricRecoveries.length} recoveryEmailed=${recoveryEmailed} ` +
      `p95Snapshots=${historyUpdates.length} historyCap=${P95_HISTORY_CAP}`,
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
    resolvedAndCleared: resolved.length,
    emailed,
    tekmetricRecoveries: tekmetricRecoveries.map((r) => ({
      shopId: r.shopId,
      name: shopNamesById.get(r.shopId) || `Shop ${r.shopId}`,
      lastSeenP95Ms: r.lastSeenP95Ms,
      previousReasons: r.previousReasons,
      transition: r.transition,
    })),
    recoveryEmailed,
    p95Snapshots: historyUpdates.length,
    breachingShops: slow.map((s) => ({
      provider: s.provider,
      shopId: s.shopId,
      name: s.name,
      reasons: s.reasons,
      p95DurationMs: s.rollup.p95DurationMs,
      p95BaselineMs: s.p95Baseline,
      avgBackoff429Ms: s.rollup.avgBackoff429Ms,
      chunkSampleCount: s.rollup.chunkSampleCount,
      jobsCacheHitRate: s.rollup.jobsCacheHitRate,
      vehiclesCacheHitRate: s.rollup.vehiclesCacheHitRate,
      customersCacheHitRate: s.rollup.customersCacheHitRate,
    })),
  });
}
