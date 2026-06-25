import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { triggerBackfillForShop, type BackfillProvider } from "@/lib/backfill/trigger";
import {
  claimNextQueuedRequest,
  markResyncCompleted,
  markResyncFailed,
} from "@/lib/resync-requests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CRON_SECRET = process.env.CRON_SECRET;

// Drains the customer-requested re-sync queue (task #629 follow-on). Invoked
// by the overnight `daily-all` cron so the heavy backfill work lands when the
// background workers are active and shops are quiet — never during the day.
//
// Requests are claimed one at a time and processed serially to stay gentle on
// the shared database and the per-provider rate limiters. Each request reuses
// the same reset-cursor + kick-cron path as a platform-admin manual backfill.
const MAX_PER_RUN = 25;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const secretParam = req.nextUrl.searchParams.get("secret");

  const isAuthorized =
    (CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`) ||
    (CRON_SECRET && secretParam === CRON_SECRET) ||
    !CRON_SECRET;

  if (!isAuthorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const db = await getDb();

  let processed = 0;
  let failed = 0;
  const details: Array<{
    shopId: number;
    provider: BackfillProvider | null;
    ok: boolean;
    message: string;
  }> = [];

  for (let i = 0; i < MAX_PER_RUN; i++) {
    const request = await claimNextQueuedRequest(db);
    if (!request) break;

    const shopId = Number(request.shopId);
    try {
      const result = await triggerBackfillForShop(
        db,
        shopId,
        (request.provider as BackfillProvider | null) ?? undefined,
      );

      if (result.ok) {
        await markResyncCompleted(db, request._id!, result.provider);
        processed++;
        console.log(
          `[ResyncQueue] Triggered re-sync for shop ${shopId}: ${result.message}`,
        );
      } else {
        await markResyncFailed(db, request._id!, result.message);
        failed++;
        console.warn(
          `[ResyncQueue] Could not re-sync shop ${shopId}: ${result.message}`,
        );
      }
      details.push({
        shopId,
        provider: result.provider,
        ok: result.ok,
        message: result.message,
      });
    } catch (err: any) {
      await markResyncFailed(db, request._id!, err?.message || "unknown error");
      failed++;
      console.error(
        `[ResyncQueue] Error processing re-sync for shop ${shopId}:`,
        err?.message ?? err,
      );
      details.push({
        shopId,
        provider: null,
        ok: false,
        message: err?.message || "unknown error",
      });
    }
  }

  return NextResponse.json({
    ok: true,
    processed,
    failed,
    durationMs: Date.now() - startedAt,
    details,
  });
}

export async function POST(req: NextRequest) {
  return GET(req);
}
