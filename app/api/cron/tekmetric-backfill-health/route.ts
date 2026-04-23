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
    // legitimately stops running.
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

  console.log(
    `[TekmetricBackfillHealth] progress=${progress.length} stuck=${stuck.length} ` +
      `newAlerts=${newlyStuck.length} reasonsChanged=${reasonsChanged.length} ` +
      `resolved=${resolvedShopIds.length} emailed=${emailed}`
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
  });
}
