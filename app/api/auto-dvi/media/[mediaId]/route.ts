// Task #991 — Auto DVI media: shop-scoped streaming + delete of an
// inspection attachment stored in GridFS.

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { checkShopFeatureGate } from "@/lib/extension-route-guard";
import { readInspectionMedia, deleteInspectionMedia } from "@/lib/data/repositories/auto-dvi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { mediaId: string } }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const media = await readInspectionMedia(Number(session.shopId), params.mediaId);
  if (!media) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return new NextResponse(media.buffer as any, {
    headers: {
      "Content-Type": media.contentType,
      "Content-Length": String(media.buffer.length),
      "Cache-Control": "private, max-age=3600",
      ...(media.filename ? { "Content-Disposition": `inline; filename="${media.filename.replace(/"/g, "")}"` } : {}),
    },
  });
}

export async function DELETE(req: NextRequest, { params }: { params: { mediaId: string } }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const shopId = Number(session.shopId);
  const denied = await checkShopFeatureGate(shopId, ["auto_dvi"], {
    isPlatformAdmin: session.role === "platform_admin",
    featureLabel: "Auto DVI",
  });
  if (denied) return denied;
  const vin = (req.nextUrl.searchParams.get("vin") || "").toUpperCase().trim();
  if (!vin) return NextResponse.json({ error: "vin is required" }, { status: 400 });
  const ok = await deleteInspectionMedia(shopId, vin, params.mediaId);
  if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
