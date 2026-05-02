// app/api/platform-admin/shops/bulk-approve/route.ts
// Bulk-approve a set of shops in the review queue. Mirrors the per-shop
// approve flow in `[shopId]/review/route.ts` so audit-log shape stays in
// lock-step.

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BULK_APPROVE = 500;

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session?.isPlatformAdmin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const rawShopIds: unknown = body?.shopIds;
  if (!Array.isArray(rawShopIds) || rawShopIds.length === 0) {
    return NextResponse.json(
      { error: "shopIds (non-empty array) is required" },
      { status: 400 },
    );
  }
  if (rawShopIds.length > MAX_BULK_APPROVE) {
    return NextResponse.json(
      { error: `Too many shops: max ${MAX_BULK_APPROVE} per request` },
      { status: 400 },
    );
  }

  const notes = typeof body?.notes === "string" ? body.notes.trim().slice(0, 2000) : null;

  const seen = new Set<string>();
  const shopIds: (number | string)[] = [];
  for (const raw of rawShopIds) {
    const id =
      typeof raw === "number"
        ? raw
        : typeof raw === "string"
          ? Number.isFinite(Number(raw))
            ? Number(raw)
            : raw
          : null;
    if (id === null) continue;
    const key = String(id);
    if (seen.has(key)) continue;
    seen.add(key);
    shopIds.push(id);
  }
  if (shopIds.length === 0) {
    return NextResponse.json({ error: "No valid shopIds provided" }, { status: 400 });
  }

  const db = await getDb();
  const now = new Date();
  const approved: Array<{ shopId: number | string; previousStatus: string }> = [];
  const errors: Array<{ shopId: number | string; error: string }> = [];

  for (const shopId of shopIds) {
    try {
      const shop = await db.collection("shops").findOne({ shopId });
      if (!shop) {
        errors.push({ shopId, error: "Shop not found" });
        continue;
      }
      const previousStatus = (shop.reviewStatus as string | undefined) || "pending";
      const previousAutoFlagReasons: string[] = Array.isArray(shop.autoFlagReasons)
        ? shop.autoFlagReasons.filter((r: unknown): r is string => typeof r === "string")
        : [];

      const setDoc: Record<string, any> = {
        reviewStatus: "approved",
        reviewedAt: now,
        reviewedBy: session.email,
        autoFlagReasons: [],
        updatedAt: now,
      };
      if (notes) setDoc.reviewNotes = notes;
      const updateOps: Record<string, any> = { $set: setDoc };
      if (!notes) updateOps.$unset = { reviewNotes: "" };

      await db.collection("shops").updateOne({ shopId }, updateOps);

      await db.collection("audit_logs").insertOne({
        type: "shop_review_decision",
        shopId,
        shopName: shop.name,
        decision: "approve",
        previousStatus,
        newStatus: "approved",
        notes: notes || null,
        autoFlagReasons: previousAutoFlagReasons,
        adminEmail: session.email,
        bulk: true,
        createdAt: now,
      });

      approved.push({ shopId, previousStatus });
    } catch (err: any) {
      errors.push({ shopId, error: err?.message || "Unknown error" });
    }
  }

  return NextResponse.json({
    ok: true,
    approvedCount: approved.length,
    errorCount: errors.length,
    approved,
    errors,
  });
}
