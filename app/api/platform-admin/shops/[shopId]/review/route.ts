// app/api/platform-admin/shops/[shopId]/review/route.ts
// Approve or flag a shop for the email-review gate (task #252).
// Approving clears the auto-flag reasons and re-enables transactional
// email; flagging keeps suppression in place and records admin notes.

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import type { ShopReviewStatus } from "@/lib/shop-review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ReviewDecision = "approve" | "flag" | "reset";

export async function POST(
  req: NextRequest,
  { params }: { params: { shopId: string } },
) {
  const session = await getSession();
  if (!session?.isPlatformAdmin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopIdRaw = params.shopId;
  const shopId = isNaN(Number(shopIdRaw)) ? shopIdRaw : Number(shopIdRaw);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const decision = body?.decision as ReviewDecision | undefined;
  const notes = typeof body?.notes === "string" ? body.notes.trim().slice(0, 2000) : null;

  if (decision !== "approve" && decision !== "flag" && decision !== "reset") {
    return NextResponse.json(
      { error: "decision must be 'approve', 'flag', or 'reset'" },
      { status: 400 },
    );
  }
  if (decision === "flag" && !notes) {
    return NextResponse.json(
      { error: "notes are required when flagging a shop" },
      { status: 400 },
    );
  }

  const db = await getDb();
  const shop = await db.collection("shops").findOne({ shopId });
  if (!shop) {
    return NextResponse.json({ error: "Shop not found" }, { status: 404 });
  }

  const now = new Date();
  const previousStatus = (shop.reviewStatus as ShopReviewStatus | undefined) || "pending";
  const previousAutoFlagReasons: string[] = Array.isArray(shop.autoFlagReasons)
    ? shop.autoFlagReasons.filter((r: unknown): r is string => typeof r === "string")
    : [];

  let nextStatus: ShopReviewStatus;
  const updateSet: Record<string, any> = {
    reviewedAt: now,
    reviewedBy: session.email,
    updatedAt: now,
  };
  const updateUnset: Record<string, ""> = {};

  if (decision === "approve") {
    nextStatus = "approved";
    updateSet.reviewStatus = "approved";
    // Approving clears auto-flag reasons (per task spec) so the shop is
    // not flagged forever after first approval. Notes are optional.
    updateSet.autoFlagReasons = [];
    if (notes) {
      updateSet.reviewNotes = notes;
    } else {
      updateUnset.reviewNotes = "";
    }
  } else if (decision === "flag") {
    nextStatus = "flagged";
    updateSet.reviewStatus = "flagged";
    updateSet.reviewNotes = notes;
  } else {
    // "reset" — push back to pending (admin tool for mistakes).
    nextStatus = "pending";
    updateSet.reviewStatus = "pending";
    if (notes) {
      updateSet.reviewNotes = notes;
    } else {
      updateUnset.reviewNotes = "";
    }
  }

  const updateOps: Record<string, any> = { $set: updateSet };
  if (Object.keys(updateUnset).length > 0) updateOps.$unset = updateUnset;
  await db.collection("shops").updateOne({ shopId }, updateOps);

  await db.collection("audit_logs").insertOne({
    type: "shop_review_decision",
    shopId,
    shopName: shop.name,
    decision,
    previousStatus,
    newStatus: nextStatus,
    notes: notes || null,
    autoFlagReasons: previousAutoFlagReasons,
    adminEmail: session.email,
    createdAt: now,
  });

  return NextResponse.json({
    ok: true,
    shopId,
    reviewStatus: nextStatus,
    reviewedAt: now,
    reviewedBy: session.email,
    reviewNotes: updateSet.reviewNotes ?? null,
    autoFlagReasons: decision === "approve" ? [] : previousAutoFlagReasons,
  });
}
