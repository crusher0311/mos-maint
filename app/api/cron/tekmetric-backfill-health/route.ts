import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { sendEmail } from "@/lib/email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Tekmetric backfill health monitor — follow-up to Task #20 verification,
 * which uncovered 35-of-38 incomplete shops silently stuck for weeks/months
 * with nobody paged. Reuses the same diagnostics logic that powers
 * `/api/admin/sync-health` and `scripts/verify-tekmetric-backfill.ts`.
 *
 * A shop is flagged as stuck if any of:
 *   - lastRunAt is missing or older than 48h, OR
 *   - lastError is non-null (with the 24h "persistent" sub-bucket called out
 *     so on-call sees that the cron's own 6h auto-clear never won), OR
 *   - cursor (lastCursorMoveAt) hasn't moved in > 3 days.
 *
 * Slow-chunk regressions (p95, backoff, cache hit rate) for any of the three
 * providers are owned by `/api/cron/backfill-chunk-speed-health`, which has
 * its own dedup state and runs at 07:00 UTC. This cron focuses on
 * Tekmetric-specific stuck/error conditions and the perm-failed RO spike
 * detector below.
 *
 * Dedup strategy (state-based, NOT date-based, so the on-call isn't paged
 * every day for the same already-known stuck shop):
 *   - One row per shopId in `tekmetric_backfill_health_alerts`.
 *   - Email is sent only when the row is first inserted, OR when the shop's
 *     reasons change (e.g. went from `stale_run` to `stale_run+last_error`).
 *   - When a previously alerted shop is no longer stuck, its alert row is
 *     deleted so it can re-page if it breaks again later.
 *
 * Auth: standard `Authorization: Bearer ${CRON_SECRET}` (same as the other
 * crons under /api/cron/).
 *
 * Trigger: daily via the in-process node-cron scheduler — registered in
 * `lib/cron/jobs.cjs` (CRON_JOBS) and bootstrapped by
 * `src/instrumentation.ts` whenever ENABLE_INPROCESS_CRON=true. We do NOT
 * need a separate vercel.json cron entry because the production deployment
 * runs the in-process scheduler (same as the other Tekmetric crons).
 */

const STALE_RUN_HOURS = 48;
const FROZEN_CURSOR_DAYS = 3;
const PERSISTENT_ERROR_HOURS = 24;

// Permanently-failed RO alert thresholds. The skipped-RO retry cron marks an
// RO `permanentlyFailed` after MAX_RETRY_ATTEMPTS unsuccessful retries; that
// is real, unrecovered data loss. Page on-call when either:
//   - a shop's permanently-failed count grows by more than N in a rolling
//     24h window (catches sudden spikes), OR
//   - the absolute count exceeds ABSOLUTE threshold (catches slow leaks /
//     shops we just discovered are bad).
// Re-page only when the count grows beyond what we last alerted on, so the
// on-call isn't paged daily for the same already-known failures.
const PERM_FAILED_GROWTH_THRESHOLD = 5;
const PERM_FAILED_ABSOLUTE_THRESHOLD = 20;
// Pick the newest snapshot at least this old as the growth baseline.
// Note: the task brief says "24h window" but on a strictly-daily cron a
// strict 24h cutoff would miss yesterday's snapshot whenever the run time
// drifts by even a minute earlier than the prior day. ~18h gives a few
// hours of jitter tolerance while still being unambiguously "yesterday".
const PERM_FAILED_BASELINE_MIN_AGE_MS = 18 * 60 * 60 * 1000;
// We keep a rolling snapshot history per shop so the daily growth check
// works on a daily cron (a single "anchor" timestamp would always be
// ~24h old and get reset before growth could be evaluated). Cap at 14
// entries (~2 weeks at one run/day) to bound storage.
const PERM_FAILED_HISTORY_CAP = 14;
// Cap on the dedup list of RO ids we've already paged on. Permanently-failed
// ROs are bounded per shop (they're a tiny fraction of total ROs), but a
// pathological shop could in principle accumulate a very long list. Keep
// only the most recent N so the dedup doc stays small. The retry cron also
// rotates `recentSkippedRos` so anything older than the recency window
// can't re-appear in a payload anyway.
const PERM_FAILED_ALERTED_RO_CAP = 500;

type StuckShop = {
  shopId: number;
  name: string;
  reasons: string[];
  reasonsKey: string;
  lastRunAt: string | null;
  hoursSinceLastRun: number | null;
  daysCursorFrozen: number | null;
  lastError: string | null;
  lastErrorAt: string | null;
  currentChunkEnd: string | null;
  // Probe fields (task #51): surfaced on the per-shop payload so on-call
  // can see, in the same response, whether an out-of-band probe was run
  // against this shop and whether it succeeded — without having to query
  // Mongo. Written by operational helpers (e.g.
  // scripts/restart-never-started-tekmetric-shops.ts) on dedicated
  // columns to avoid corrupting the cron's fair-queue ordering.
  lastProbedAt: string | null;
  lastProbeOk: boolean | null;
  lastProbeError: string | null;
  lastProbeNote: string | null;
};

function computeStuckShops(progressRows: any[], shopNamesById: Map<number, string>): StuckShop[] {
  const now = Date.now();
  const stuck: StuckShop[] = [];

  for (const p of progressRows) {
    const lastRunMs = p.lastRunAt ? new Date(p.lastRunAt).getTime() : null;
    const hoursSinceRun = lastRunMs == null ? null : (now - lastRunMs) / (60 * 60 * 1000);
    const cursorMoveMs = p.lastCursorMoveAt
      ? new Date(p.lastCursorMoveAt).getTime()
      : lastRunMs;
    const daysCursorFrozen =
      cursorMoveMs == null ? null : (now - cursorMoveMs) / (24 * 60 * 60 * 1000);
    const lastErrorMs = p.lastErrorAt ? new Date(p.lastErrorAt).getTime() : null;
    const hoursSinceError = lastErrorMs == null ? null : (now - lastErrorMs) / (60 * 60 * 1000);

    const reasons: string[] = [];
    // Freshness reasons only apply to incomplete shops — a completed shop
    // legitimately stops running. Slow-chunk regressions (p95, backoff,
    // cache hit) are owned by `/api/cron/backfill-chunk-speed-health`.
    if (!p.completed) {
      if (lastRunMs == null) reasons.push("never_started");
      if (hoursSinceRun != null && hoursSinceRun > STALE_RUN_HOURS) reasons.push("stale_run");
      if (daysCursorFrozen != null && daysCursorFrozen > FROZEN_CURSOR_DAYS) reasons.push("frozen_cursor");
    }
    // Error reasons apply to every shop regardless of completion state.
    // A completed shop sitting on a persistent lastError still indicates a
    // real problem (the auto-clear couldn't sweep it because backfill no
    // longer runs for that shop) and the task brief explicitly calls this
    // out: "any shop has a non-null lastError that hasn't auto-cleared in
    // 24h".
    if (p.lastError) {
      reasons.push("last_error");
      if (hoursSinceError != null && hoursSinceError > PERSISTENT_ERROR_HOURS) {
        reasons.push("persistent_error");
      }
    }

    if (reasons.length === 0) continue;

    const shopId = Number(p.shopId);
    stuck.push({
      shopId,
      name: shopNamesById.get(shopId) || `Shop ${shopId}`,
      reasons,
      reasonsKey: [...reasons].sort().join(","),
      lastRunAt: p.lastRunAt ? new Date(p.lastRunAt).toISOString() : null,
      hoursSinceLastRun: hoursSinceRun == null ? null : Number(hoursSinceRun.toFixed(1)),
      daysCursorFrozen: daysCursorFrozen == null ? null : Number(daysCursorFrozen.toFixed(1)),
      lastError: p.lastError ? String(p.lastError).slice(0, 300) : null,
      lastErrorAt: p.lastErrorAt ? new Date(p.lastErrorAt).toISOString() : null,
      currentChunkEnd: p.currentChunkEnd ? new Date(p.currentChunkEnd).toISOString() : null,
      lastProbedAt: p.lastProbedAt ? new Date(p.lastProbedAt).toISOString() : null,
      lastProbeOk: typeof p.lastProbeOk === "boolean" ? p.lastProbeOk : null,
      lastProbeError: p.lastProbeError ? String(p.lastProbeError).slice(0, 500) : null,
      lastProbeNote: p.lastProbeNote ? String(p.lastProbeNote).slice(0, 500) : null,
    });
  }

  // Most-stuck first.
  stuck.sort((a, b) => (b.daysCursorFrozen ?? -1) - (a.daysCursorFrozen ?? -1));
  return stuck;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") || "";
  const expected = process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : "";
  if (expected && auth !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = await getDb();
  const progress = await db.collection("tekmetric_backfill_progress").find({}).toArray();

  // Resolve shop names for human-readable alerts. Include completed shops
  // too, since they can still surface via the lastError rule.
  const candidateShopIds = progress
    .filter((p: any) => !p.completed || p.lastError)
    .map((p: any) => Number(p.shopId));
  const shops = await db
    .collection("shops")
    .find(
      { shopId: { $in: candidateShopIds } },
      { projection: { shopId: 1, name: 1, locationIdentifier: 1 } }
    )
    .toArray();
  const shopNamesById = new Map<number, string>();
  for (const s of shops as any[]) {
    const display = s.locationIdentifier
      ? `${s.name || "(unnamed)"} — ${s.locationIdentifier}`
      : s.name || `(unnamed)`;
    shopNamesById.set(Number(s.shopId), display);
  }

  const stuck = computeStuckShops(progress, shopNamesById);

  // State-based dedup: one row per shopId. Re-alert only on first detection
  // or when reasons change. Resolved shops are removed so they can re-page
  // later if they break again.
  const alertsCollection = db.collection("tekmetric_backfill_health_alerts");
  await alertsCollection
    .createIndex({ shopId: 1 }, { unique: true, name: "uniq_shopId" })
    .catch(() => {});

  const stuckShopIdSet = new Set(stuck.map((s) => s.shopId));
  const existingDocs = await alertsCollection.find({}).toArray();
  const existingByShopId = new Map<number, any>();
  for (const d of existingDocs as any[]) existingByShopId.set(Number(d.shopId), d);

  // Auto-clear: drop dedup rows for shops that are no longer stuck.
  const resolvedShopIds: number[] = [];
  for (const d of existingDocs as any[]) {
    if (!stuckShopIdSet.has(Number(d.shopId))) {
      resolvedShopIds.push(Number(d.shopId));
    }
  }
  if (resolvedShopIds.length > 0) {
    await alertsCollection.deleteMany({ shopId: { $in: resolvedShopIds } });
  }

  const newlyStuck: StuckShop[] = [];
  const reasonsChanged: StuckShop[] = [];
  const now = new Date();

  for (const s of stuck) {
    const existing = existingByShopId.get(s.shopId);
    if (!existing) {
      newlyStuck.push(s);
      await alertsCollection.updateOne(
        { shopId: s.shopId },
        {
          $set: {
            shopId: s.shopId,
            reasonsKey: s.reasonsKey,
            reasons: s.reasons,
            firstAlertedAt: now,
            lastAlertedAt: now,
          },
        },
        { upsert: true }
      );
    } else if (existing.reasonsKey !== s.reasonsKey) {
      reasonsChanged.push(s);
      await alertsCollection.updateOne(
        { shopId: s.shopId },
        {
          $set: {
            reasonsKey: s.reasonsKey,
            reasons: s.reasons,
            lastAlertedAt: now,
            previousReasonsKey: existing.reasonsKey,
          },
        }
      );
    } else {
      // Same reasons as last alert — touch lastSeenAt only, don't email.
      await alertsCollection.updateOne(
        { shopId: s.shopId },
        { $set: { lastSeenAt: now } }
      );
    }
  }

  const toAlert = [...newlyStuck, ...reasonsChanged];

  let emailed = 0;
  if (toAlert.length > 0) {
    const admins = await db
      .collection("users")
      .find(
        { isPlatformAdmin: true, email: { $exists: true, $ne: null } },
        { projection: { email: 1 } }
      )
      .toArray();

    if (admins.length === 0) {
      console.warn("[TekmetricBackfillHealth] No platform admins configured; alerts logged only");
    } else {
      const totalStuckCount = stuck.length;
      const rows = toAlert
        .map((s) => {
          const isNew = newlyStuck.includes(s);
          return `
        <tr>
          <td style="padding:6px 12px;border:1px solid #ddd">${escapeHtml(s.name)}</td>
          <td style="padding:6px 12px;border:1px solid #ddd">${s.shopId}</td>
          <td style="padding:6px 12px;border:1px solid #ddd">${escapeHtml(s.reasons.join(", "))}</td>
          <td style="padding:6px 12px;border:1px solid #ddd">${s.hoursSinceLastRun ?? "—"}</td>
          <td style="padding:6px 12px;border:1px solid #ddd">${s.daysCursorFrozen ?? "—"}</td>
          <td style="padding:6px 12px;border:1px solid #ddd">${s.lastError ? escapeHtml(s.lastError) : "—"}</td>
          <td style="padding:6px 12px;border:1px solid #ddd">${isNew ? "NEW" : "REASONS CHANGED"}</td>
        </tr>`;
        })
        .join("");
      const html = `
        <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.5">
          <h2>Tekmetric Backfill Stuck Shops — Daily Health Check</h2>
          <p>${toAlert.length} shop(s) need attention. Total currently stuck: <strong>${totalStuckCount}</strong>.</p>
          <p>Stuck reasons:
            <code>never_started</code> = no lastRunAt yet ·
            <code>stale_run</code> = lastRunAt &gt; ${STALE_RUN_HOURS}h ago ·
            <code>frozen_cursor</code> = lastCursorMoveAt &gt; ${FROZEN_CURSOR_DAYS}d ago ·
            <code>last_error</code> = lastError still set ·
            <code>persistent_error</code> = lastError &gt; ${PERSISTENT_ERROR_HOURS}h old (auto-clear failed).
          </p>
          <p style="color:#666;font-size:13px;margin:0">
            Slow-chunk regressions (p95, 429 backoff, cache hit rate) for any provider
            are paged separately by <code>/api/cron/backfill-chunk-speed-health</code>.
          </p>
          <table style="border-collapse:collapse;border:1px solid #ddd">
            <thead>
              <tr>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Shop</th>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">MOS ID</th>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Reasons</th>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Hrs Since Run</th>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Days Cursor Frozen</th>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Last Error</th>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Status</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
          <p style="margin-top:16px;color:#666;font-size:13px">
            Sent by <code>/api/cron/tekmetric-backfill-health</code>. Diagnostics:
            <code>/api/admin/sync-health</code>. Already-stuck shops with unchanged reasons
            are deduped — you'll only be re-paged when something new breaks or reasons change.
          </p>
        </div>`;
      for (const admin of admins as Array<{ email: string }>) {
        try {
          await sendEmail({
            to: admin.email,
            subject: `[MOS] Tekmetric backfill stuck: ${toAlert.length} shop(s) (${stuck.length} total)`,
            html,
          });
          emailed++;
        } catch (err: any) {
          console.error(
            `[TekmetricBackfillHealth] Email send failed for ${admin.email}:`,
            err?.message
          );
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Permanently-failed RO spike alerts.
  //
  // Source of truth: `tekmetric_backfill_progress.permanentlyFailedRoCount`
  // (incremented by /api/cron/tekmetric-ro-retry whenever an RO crosses the
  // 3-attempt retry threshold) and `recentSkippedRos[].permanentlyFailed`
  // for the per-RO ids/errors.
  //
  // Dedup: one row per shopId in `tekmetric_permfailed_ro_alerts` storing
  //   - lastAlertedCount: the perm-failed count at the time of the most
  //     recent page (so we only re-page when count grows further)
  //   - alertedRoIds: the perm-failed RO ids we've already paged on (so the
  //     "new perm-failed RO ids" payload is exactly what's new since last
  //     page)
  //   - windowAnchorAt / windowAnchorCount: rolling 24h baseline used to
  //     compute "growth in last 24h"
  // -------------------------------------------------------------------------
  const permFailedAlertsCollection = db.collection("tekmetric_permfailed_ro_alerts");
  await permFailedAlertsCollection
    .createIndex({ shopId: 1 }, { unique: true, name: "uniq_shopId" })
    .catch(() => {});

  type PermFailedAlertPayload = {
    shopId: number;
    name: string;
    currentCount: number;
    previousAlertedCount: number;
    growth24h: number;
    triggerReason: string;
    newPermFailedRos: Array<{ roId: number; lastError: string | null; lastRetryAt: string | null }>;
  };

  const permFailedAlerts: PermFailedAlertPayload[] = [];
  const nowMs = now.getTime();

  for (const p of progress as any[]) {
    const shopId = Number(p.shopId);
    const currentCount = Number(p.permanentlyFailedRoCount || 0);
    const permFailedSamples: any[] = (
      Array.isArray(p.recentSkippedRos) ? p.recentSkippedRos : []
    ).filter((s: any) => !!s.permanentlyFailed);
    const currentRoIds = permFailedSamples.map((s) => Number(s.roId));

    const existing = await permFailedAlertsCollection.findOne({ shopId });

    // Snapshot history: each prior run wrote {at, count}. Pick the newest
    // snapshot at or before (now - 24h) as the growth baseline. If no such
    // snapshot exists yet (e.g. first or second run for this shop), we
    // can't evaluate growth and skip that branch — the absolute threshold
    // will still catch dangerous shops.
    type Snapshot = { at: Date; count: number };
    const rawHistory: any[] = Array.isArray(existing?.countHistory)
      ? existing!.countHistory
      : [];
    const history: Snapshot[] = rawHistory
      .map((h: any) => ({ at: new Date(h.at), count: Number(h.count || 0) }))
      .filter((h) => !Number.isNaN(h.at.getTime()))
      .sort((a, b) => a.at.getTime() - b.at.getTime());

    const baselineCutoffMs = nowMs - PERM_FAILED_BASELINE_MIN_AGE_MS;
    let baselineCount: number | null = null;
    let baselineAt: Date | null = null;
    for (const h of history) {
      if (h.at.getTime() <= baselineCutoffMs) {
        // Newest qualifying snapshot wins (history is sorted ascending).
        baselineCount = h.count;
        baselineAt = h.at;
      }
    }
    const growth24h = baselineCount == null ? null : currentCount - baselineCount;

    const lastAlertedCount = Number(existing?.lastAlertedCount ?? 0);
    const alertedRoIds: number[] = Array.isArray(existing?.alertedRoIds)
      ? existing!.alertedRoIds.map((x: any) => Number(x))
      : [];

    const exceedsGrowth = growth24h != null && growth24h > PERM_FAILED_GROWTH_THRESHOLD;
    const exceedsAbsolute = currentCount >= PERM_FAILED_ABSOLUTE_THRESHOLD;
    const grewSinceLastAlert = currentCount > lastAlertedCount;

    // Append the current snapshot, then trim to cap. We always write the new
    // snapshot so future runs have a fresh baseline regardless of whether
    // this run alerted.
    const updatedHistory = [...history, { at: now, count: currentCount }]
      .slice(-PERM_FAILED_HISTORY_CAP)
      .map((h) => ({ at: h.at, count: h.count }));

    if ((exceedsGrowth || exceedsAbsolute) && grewSinceLastAlert) {
      const alertedSet = new Set(alertedRoIds);
      const newRos = permFailedSamples.filter((s) => !alertedSet.has(Number(s.roId)));
      const triggerReason = exceedsGrowth
        ? `growth_24h>${PERM_FAILED_GROWTH_THRESHOLD} (+${growth24h} since ${baselineAt?.toISOString()})`
        : `absolute>=${PERM_FAILED_ABSOLUTE_THRESHOLD}`;

      permFailedAlerts.push({
        shopId,
        name: shopNamesById.get(shopId) || `Shop ${shopId}`,
        currentCount,
        previousAlertedCount: lastAlertedCount,
        growth24h: growth24h ?? 0,
        triggerReason,
        newPermFailedRos: newRos.map((s) => ({
          roId: Number(s.roId),
          lastError: s.lastRetryError
            ? String(s.lastRetryError).slice(0, 300)
            : s.error
              ? String(s.error).slice(0, 300)
              : null,
          lastRetryAt: s.lastRetryAt
            ? new Date(s.lastRetryAt as any).toISOString()
            : null,
        })),
      });

      // Merge known + currently-seen RO ids so we never re-alert on the same
      // ones, even if `recentSkippedRos` later rotates them out. Cap the
      // list (newest entries kept) so the dedup doc stays bounded.
      const mergedAlertedIds = Array.from(
        new Set([...alertedRoIds, ...currentRoIds])
      ).slice(-PERM_FAILED_ALERTED_RO_CAP);
      await permFailedAlertsCollection.updateOne(
        { shopId },
        {
          $set: {
            shopId,
            lastAlertedCount: currentCount,
            lastAlertedAt: now,
            alertedRoIds: mergedAlertedIds,
            countHistory: updatedHistory,
            lastSeenCount: currentCount,
            lastSeenAt: now,
          },
          $setOnInsert: { firstAlertedAt: now, firstSeenAt: now },
        },
        { upsert: true }
      );
    } else {
      // No alert this run — still persist the snapshot history so growth
      // is computed correctly on subsequent runs.
      await permFailedAlertsCollection.updateOne(
        { shopId },
        {
          $set: {
            shopId,
            countHistory: updatedHistory,
            lastSeenCount: currentCount,
            lastSeenAt: now,
          },
          $setOnInsert: {
            lastAlertedCount: 0,
            alertedRoIds: [],
            firstSeenAt: now,
          },
        },
        { upsert: true }
      );
    }
  }

  let permFailedEmailed = 0;
  if (permFailedAlerts.length > 0) {
    const admins = await db
      .collection("users")
      .find(
        { isPlatformAdmin: true, email: { $exists: true, $ne: null } },
        { projection: { email: 1 } }
      )
      .toArray();
    if (admins.length === 0) {
      console.warn("[TekmetricBackfillHealth] No platform admins configured; perm-failed RO alerts logged only");
    } else {
      const sections = permFailedAlerts
        .map((a) => {
          const newRoRows = a.newPermFailedRos.length
            ? a.newPermFailedRos
                .map(
                  (r) => `
              <tr>
                <td style="padding:4px 10px;border:1px solid #ddd">${r.roId}</td>
                <td style="padding:4px 10px;border:1px solid #ddd">${r.lastRetryAt ?? "—"}</td>
                <td style="padding:4px 10px;border:1px solid #ddd">${r.lastError ? escapeHtml(r.lastError) : "—"}</td>
              </tr>`
                )
                .join("")
            : `<tr><td colspan="3" style="padding:4px 10px;border:1px solid #ddd;color:#666">
                (RO ids rotated out of recentSkippedRos before this alert fired)
              </td></tr>`;
          return `
          <div style="margin:18px 0;padding:12px;border:1px solid #eee;border-radius:6px">
            <div><strong>${escapeHtml(a.name)}</strong> (MOS shop ${a.shopId})</div>
            <div>Permanently-failed RO count: <strong>${a.currentCount}</strong>
              (was ${a.previousAlertedCount} at last alert, +${a.growth24h} in last 24h)</div>
            <div>Trigger: <code>${escapeHtml(a.triggerReason)}</code></div>
            <table style="border-collapse:collapse;border:1px solid #ddd;margin-top:8px;font-size:13px">
              <thead>
                <tr>
                  <th style="padding:4px 10px;border:1px solid #ddd;text-align:left">New RO ID</th>
                  <th style="padding:4px 10px;border:1px solid #ddd;text-align:left">Last Retry At</th>
                  <th style="padding:4px 10px;border:1px solid #ddd;text-align:left">Last Error</th>
                </tr>
              </thead>
              <tbody>${newRoRows}</tbody>
            </table>
          </div>`;
        })
        .join("");
      const html = `
        <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.5">
          <h2>Tekmetric Permanently-Failed Repair Orders — Spike Alert</h2>
          <p>${permFailedAlerts.length} shop(s) have crossed a permanently-failed RO threshold.
            These ROs exhausted ${"3"} retries and represent unrecovered data loss.</p>
          <p>Thresholds: growth &gt; ${PERM_FAILED_GROWTH_THRESHOLD} in 24h, OR absolute &ge; ${PERM_FAILED_ABSOLUTE_THRESHOLD}.
            You'll only be re-paged when the count grows beyond what was last alerted.</p>
          ${sections}
          <p style="margin-top:16px;color:#666;font-size:13px">
            Sent by <code>/api/cron/tekmetric-backfill-health</code>. Source counters:
            <code>/api/cron/tekmetric-ro-retry</code>. View per-shop detail at
            <code>/api/admin/sync-health</code>.
          </p>
        </div>`;
      for (const admin of admins as Array<{ email: string }>) {
        try {
          await sendEmail({
            to: admin.email,
            subject: `[MOS] Tekmetric perm-failed RO spike: ${permFailedAlerts.length} shop(s)`,
            html,
          });
          permFailedEmailed++;
        } catch (err: any) {
          console.error(
            `[TekmetricBackfillHealth] Perm-failed RO email send failed for ${admin.email}:`,
            err?.message
          );
        }
      }
    }
  }

  console.log(
    `[TekmetricBackfillHealth] progress=${progress.length} stuck=${stuck.length} ` +
      `newAlerts=${newlyStuck.length} reasonsChanged=${reasonsChanged.length} ` +
      `resolved=${resolvedShopIds.length} emailed=${emailed} ` +
      `permFailedAlerts=${permFailedAlerts.length} permFailedEmailed=${permFailedEmailed}`
  );

  return NextResponse.json({
    scanned: progress.length,
    incomplete: progress.filter((p: any) => !p.completed).length,
    stuckTotal: stuck.length,
    newAlerts: newlyStuck.length,
    reasonsChangedAlerts: reasonsChanged.length,
    resolvedAndCleared: resolvedShopIds.length,
    emailed,
    stuckShops: stuck,
    permFailedAlerts,
    permFailedEmailed,
  });
}
