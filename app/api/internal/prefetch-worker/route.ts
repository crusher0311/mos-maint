import { NextRequest, NextResponse } from "next/server";
import {
  getNextPrefetchBatch,
  markPrefetchComplete,
  resetStalePrefetchItems,
  getPrefetchQueueStats,
  cleanupOldPrefetchItems,
} from "@/lib/prefetch-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const INTERNAL_SECRET = process.env.CRON_SECRET || process.env.INTERNAL_SECRET;

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (INTERNAL_SECRET && authHeader !== `Bearer ${INTERNAL_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await resetStalePrefetchItems(10);
    
    const batch = await getNextPrefetchBatch(5);
    
    if (batch.length === 0) {
      const stats = await getPrefetchQueueStats();
      return NextResponse.json({
        ok: true,
        processed: 0,
        stats,
        message: "No items to process",
      });
    }

    const results: { vin: string; success: boolean; error?: string }[] = [];

    for (const item of batch) {
      try {
        const planUrl = `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:5000'}/api/plan-build`;
        const response = await fetch(planUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${INTERNAL_SECRET}`,
          },
          body: JSON.stringify({
            vin: item.vin,
            shopId: item.shop_id,
            forceRefresh: false,
          }),
        });

        if (response.ok) {
          await markPrefetchComplete(item.id);
          results.push({ vin: item.vin, success: true });
        } else {
          const errorText = await response.text();
          await markPrefetchComplete(item.id, `HTTP ${response.status}: ${errorText.slice(0, 200)}`);
          results.push({ vin: item.vin, success: false, error: `HTTP ${response.status}` });
        }
      } catch (err: any) {
        await markPrefetchComplete(item.id, err.message);
        results.push({ vin: item.vin, success: false, error: err.message });
      }
    }

    const stats = await getPrefetchQueueStats();
    const successful = results.filter(r => r.success).length;

    return NextResponse.json({
      ok: true,
      processed: batch.length,
      successful,
      failed: batch.length - successful,
      stats,
      results,
    });
  } catch (err: any) {
    console.error("[Prefetch Worker] Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (INTERNAL_SECRET && authHeader !== `Bearer ${INTERNAL_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const stats = await getPrefetchQueueStats();
    return NextResponse.json({ ok: true, stats });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (INTERNAL_SECRET && authHeader !== `Bearer ${INTERNAL_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const cleaned = await cleanupOldPrefetchItems(7);
    return NextResponse.json({ ok: true, cleaned });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
