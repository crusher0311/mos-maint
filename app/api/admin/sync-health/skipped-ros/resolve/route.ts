import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { requirePlatformAdmin } from "@/lib/auth";
import { manuallyResolveSkippedRo } from "@/lib/tekmetric-skipped-ro-resolution";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const session = await requirePlatformAdmin();

    const body = await req.json().catch(() => ({}));
    const shopId = Number(body.shopId);
    const roId = Number(body.roId);
    if (!Number.isFinite(shopId) || !Number.isFinite(roId)) {
      return NextResponse.json(
        { error: "shopId and roId are required" },
        { status: 400 },
      );
    }

    const db = await getDb();
    const result = await manuallyResolveSkippedRo(
      db,
      shopId,
      roId,
      session.email,
    );

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 404 });
    }

    console.log(
      `[Admin SyncHealth] ${session.email} manually resolved skipped RO ${roId} for shop ${shopId} (remaining=${result.remaining}, fullyRecovered=${result.fullyRecovered})`,
    );

    return NextResponse.json({
      ok: true,
      shopId,
      roId,
      remaining: result.remaining,
      fullyRecovered: result.fullyRecovered,
    });
  } catch (err: any) {
    console.error("[Admin SyncHealth] Manual resolve error:", err);
    return NextResponse.json(
      { error: err?.message || "Failed to resolve skipped RO" },
      { status: 500 },
    );
  }
}
