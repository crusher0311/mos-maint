import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/mongo";

export const dynamic = "force-dynamic";

async function isPlatformAdmin(): Promise<boolean> {
  const store = await cookies();
  const sid = store.get("sid")?.value ?? store.get("session_token")?.value;
  if (!sid) return false;

  const db = await getDb();
  const sess = await db.collection("sessions").findOne({ token: sid, expiresAt: { $gt: new Date() } });
  if (!sess) return false;

  const user = await db.collection("users").findOne({ _id: sess.userId });
  return user?.platformAdmin === true;
}

/**
 * Soak metric for the trust-the-webhooks migration, Phase B
 * (TEKMETRIC_5K_SCALING_PLAN.md). Reports per-shop per-day counts of writes to
 * `normalized_work_orders` grouped by `firstIngestedVia` — i.e. who ACTUALLY
 * created each row first (webhook vs poll), not whoever wrote last.
 *
 * Pairs with `/api/platform-admin/tekmetric/index-source-breakdown` (Phase A,
 * for `job_index`). Both must show webhook coverage trending toward ~100%
 * before we scale polling back to a weekly reconciliation.
 *
 * Usage:
 *   GET /api/platform-admin/tekmetric/normalized-ingestion-breakdown?days=7
 */
export async function GET(req: NextRequest) {
  if (!(await isPlatformAdmin())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const daysBack = Math.max(1, Math.min(90, Number(url.searchParams.get("days") || 7)));
  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);

  const db = await getDb();

  const rows = await db.collection("normalized_work_orders").aggregate([
    {
      $match: {
        $or: [
          { firstIngestedAt: { $gte: since } },
          { lastIngestedAt: { $gte: since } },
          { createdAt: { $gte: since } },
        ],
        "provenance.sourceSystem": "tekmetric",
      },
    },
    {
      $group: {
        _id: {
          date: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: { $ifNull: ["$firstIngestedAt", "$createdAt"] },
            },
          },
          shopId: "$shopId",
          ingestionVia: { $ifNull: ["$firstIngestedVia", "unattributed"] },
        },
        count: { $sum: 1 },
      },
    },
    {
      $project: {
        _id: 0,
        date: "$_id.date",
        shopId: "$_id.shopId",
        ingestionVia: "$_id.ingestionVia",
        count: 1,
      },
    },
    { $sort: { date: -1, shopId: 1, ingestionVia: 1 } },
  ]).toArray();

  const totals: Record<string, number> = {};
  const perShop: Map<number, { webhook: number; poll: number; backfill: number; unattributed: number; days: Set<string> }> = new Map();

  for (const r of rows as Array<{ date: string; shopId: number; ingestionVia: string; count: number }>) {
    totals[r.ingestionVia] = (totals[r.ingestionVia] || 0) + r.count;
    if (!perShop.has(r.shopId)) {
      perShop.set(r.shopId, { webhook: 0, poll: 0, backfill: 0, unattributed: 0, days: new Set() });
    }
    const s = perShop.get(r.shopId)!;
    s.days.add(r.date);
    if (r.ingestionVia === "webhook") s.webhook += r.count;
    else if (r.ingestionVia === "poll") s.poll += r.count;
    else if (r.ingestionVia === "backfill") s.backfill += r.count;
    else s.unattributed += r.count;
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
        unattributed: s.unattributed,
        webhookCoveragePct: denom > 0 ? Math.round((s.webhook / denom) * 1000) / 10 : 0,
      };
    })
    .sort((a, b) => b.poll + b.webhook - (a.poll + a.webhook));

  return NextResponse.json({
    daysBack,
    totals,
    summary,
    perShopPerDay: rows,
    note: "webhookCoveragePct = webhook / (webhook + poll) on first ingestion. Once consistently near 100% per shop for several days, polling can be scaled back per TEKMETRIC_5K_SCALING_PLAN.md Step 4. `unattributed` rows are pre-Phase-B work orders that were ingested before firstIngestedVia tracking existed.",
  });
}
