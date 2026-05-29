/**
 * Platform-admin ZINK printer config edit (task #543, Milestone 3).
 *
 *   PUT /api/platform-admin/zink-print/config
 *     body: { shopId, address?, port?, cut?, speed?, width?, printerId? }
 *     -> { ok, config }
 *
 * Reuses the Milestone 2 `upsertPrinterConfig` storage; the only new thing
 * is the platform-admin auth front door (the extension config route is
 * shop-scoped to its own token). `shopId` is required because an admin acts
 * across shops.
 */

import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { upsertPrinterConfig } from "@/lib/print-queue/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(req: NextRequest) {
  try {
    await requirePlatformAdmin();

    let body: any;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const shopId = Number(body?.shopId);
    if (!Number.isFinite(shopId) || shopId <= 0) {
      return NextResponse.json({ error: "shopId is required" }, { status: 400 });
    }

    if (body?.address != null && typeof body.address !== "string") {
      return NextResponse.json({ error: "address must be a string" }, { status: 400 });
    }
    if (body?.cut != null && body.cut !== 0 && body.cut !== 1) {
      return NextResponse.json({ error: "cut must be 0 or 1" }, { status: 400 });
    }
    if (body?.speed != null && body.speed !== 0 && body.speed !== 1) {
      return NextResponse.json({ error: "speed must be 0 or 1" }, { status: 400 });
    }

    const config = await upsertPrinterConfig(shopId, {
      address: body?.address,
      port: body?.port != null ? Number(body.port) : undefined,
      defaultCut: body?.cut,
      defaultSpeed: body?.speed,
      defaultWidth: body?.width != null ? Number(body.width) : undefined,
      printerId:
        typeof body?.printerId === "string" && body.printerId.trim() !== ""
          ? body.printerId.trim()
          : null,
    });

    return NextResponse.json({ ok: true, config });
  } catch (error: any) {
    if (
      typeof error?.digest === "string" &&
      error.digest.startsWith("NEXT_REDIRECT")
    ) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("[Admin ZINK Print] config error:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to save config" },
      { status: 500 },
    );
  }
}
