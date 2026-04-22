import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/mongo";
import { getIndexSourceBreakdown } from "@/lib/tekmetric-job-index";

export const dynamic = "force-dynamic";

async function isPlatformAdmin(): Promise<boolean> {
  const store = await cookies();
  const sid = store.get("sid")?.value ?? store.get("session_token")?.value;
  if (!sid) return false;

  const db = await getDb();
  const sess = await db.collection("sessions").findOne({ token: sid, expiresAt: { $gt: new Date() } });
  if (!sess) return false;

  const user = await db.collection("users").findOne({ _id: sess.userId });
  return user?.isPlatformAdmin === true;
}

/**
 * Soak metric for the trust-the-webhooks migration (TEKMETRIC_5K_SCALING_PLAN.md, Step 2).
 *
 * Returns per-shop, per-day counts of `job_index` writes broken down by which
 * code path produced them (`webhook` | `poll` | `backfill` | `reindex`). When
 * `webhook` and `poll` rows for the same shop+day match in volume, we have
 * empirical evidence that webhooks alone would cover what polling does — at
 * which point we can safely scale the cron back to a weekly reconciliation.
 *
 * Usage:
 *   GET /api/platform-admin/tekmetric/index-source-breakdown?days=7
 *
 * Response shape:
 *   {
 *     daysBack: number,
 *     totals: { webhook: number, poll: number, backfill: number, reindex: number, ... },
 *     perShopPerDay: Array<{ date, shopId, indexedVia, count }>,
 *     summary: Array<{ shopId, days: number, webhook, poll, webhookCoveragePct }>
 *   }
 */
export async function GET(req: NextRequest) {
  if (!(await isPlatformAdmin())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const daysBack = Math.max(1, Math.min(90, Number(url.searchParams.get("days") || 7)));

  const rows = await getIndexSourceBreakdown(daysBack);

  const totals: Record<string, number> = {};
  const perShop: Map<number, { webhook: number; poll: number; backfill: number; reindex: number; days: Set<string> }> = new Map();

  for (const r of rows) {
    totals[r.indexedVia] = (totals[r.indexedVia] || 0) + r.count;
    if (!perShop.has(r.shopId)) {
      perShop.set(r.shopId, { webhook: 0, poll: 0, backfill: 0, reindex: 0, days: new Set() });
    }
    const s = perShop.get(r.shopId)!;
    s.days.add(r.date);
    if (r.indexedVia === "webhook") s.webhook += r.count;
    else if (r.indexedVia === "poll") s.poll += r.count;
    else if (r.indexedVia === "backfill") s.backfill += r.count;
    else if (r.indexedVia === "reindex") s.reindex += r.count;
  }

  const summary = Array.from(perShop.entries())
    .map(([shopId, s]) => {
      const denom = s.webhook + s.poll;
      return {
        shopId,
        days: s.days.size,
        webhook: s.webhook,
        poll: s.poll,
        backfill: s.backfill,
        reindex: s.reindex,
        webhookCoveragePct: denom > 0 ? Math.round((s.webhook / denom) * 1000) / 10 : 0,
      };
    })
    .sort((a, b) => b.poll + b.webhook - (a.poll + a.webhook));

  return NextResponse.json({
    daysBack,
    totals,
    summary,
    perShopPerDay: rows,
    note: "webhookCoveragePct = webhook / (webhook + poll). Once consistently near 100% for several days, polling can be scaled back per TEKMETRIC_5K_SCALING_PLAN.md Step 4.",
  });
}
