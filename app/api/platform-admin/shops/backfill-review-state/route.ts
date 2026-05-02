// app/api/platform-admin/shops/backfill-review-state/route.ts
// One-shot (idempotent) admin endpoint that walks every shop, computes
// auto-flag reasons, and stamps `reviewStatus: "pending"` on any shop
// missing the new review fields (task #252). Already-approved shops are
// left alone so production traffic isn't paused; admins can opt-in to
// re-flagging via `?force=1`.

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { computeAutoFlagReasons } from "@/lib/shop-review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session?.isPlatformAdmin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "1";
  const dryRun = url.searchParams.get("dryRun") === "1";

  const db = await getDb();
  const cursor = db.collection("shops").find({});

  let scanned = 0;
  let touched = 0;
  let alreadyApproved = 0;
  let alreadyFlagged = 0;
  const flaggedSamples: Array<{ shopId: any; reasons: string[] }> = [];

  for await (const shop of cursor) {
    scanned++;

    const existing = (shop.reviewStatus as string | undefined) || null;
    if (!force) {
      if (existing === "approved") {
        alreadyApproved++;
        continue;
      }
      if (existing === "flagged") {
        alreadyFlagged++;
        continue;
      }
    }

    const reasons = computeAutoFlagReasons({
      billing: shop.billing,
      cardOnFile: shop.cardOnFile,
      stripeCustomerId: shop.stripeCustomerId ?? shop.billing?.stripeCustomerId,
      isLocked: shop.isLocked,
      trial: shop.trial,
      trialEndsAt: shop.trialEndsAt,
    });

    if (flaggedSamples.length < 20 && reasons.length > 0) {
      flaggedSamples.push({ shopId: shop.shopId, reasons });
    }

    if (dryRun) continue;

    await db.collection("shops").updateOne(
      { _id: shop._id },
      {
        $set: {
          reviewStatus: "pending",
          autoFlagReasons: reasons,
          // Don't overwrite reviewedAt/reviewedBy/reviewNotes if a prior
          // backfill or admin already set them; only stamp if missing.
          ...(shop.reviewedAt === undefined ? { reviewedAt: null } : {}),
          ...(shop.reviewedBy === undefined ? { reviewedBy: null } : {}),
          ...(shop.reviewNotes === undefined ? { reviewNotes: null } : {}),
          updatedAt: new Date(),
        },
      },
    );
    touched++;
  }

  await db.collection("audit_logs").insertOne({
    type: "shops_review_backfill",
    scanned,
    touched,
    alreadyApproved,
    alreadyFlagged,
    force,
    dryRun,
    adminEmail: session.email,
    createdAt: new Date(),
  });

  return NextResponse.json({
    ok: true,
    scanned,
    touched,
    alreadyApproved,
    alreadyFlagged,
    flaggedSamples,
    dryRun,
    force,
  });
}
