import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { resolveStickerScan } from "@/lib/sticker-redirect";
import type { StickerVehicleReference } from "@/lib/sticker-qr-target";
import { getFeatureEntitlements } from "@/lib/featureResolver";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ shopId: string }> }
) {
  const { shopId } = await params;
  const numericShopId = Number(shopId);

  if (!Number.isSafeInteger(numericShopId) || numericShopId <= 0) {
    return NextResponse.json({ error: "Invalid shop ID" }, { status: 400 });
  }

  try {
    const db = await getDb();
    const shop = await db.collection("shops").findOne({ shopId: numericShopId });

    if (!shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    }

    const resolved = await resolveStickerScan({ stickerConfig: shop.stickerConfig, websiteUrl: shop.websiteUrl }, numericShopId, req.nextUrl.searchParams.get("v"), {
      resolveVehicle: async (reference, id) => {
        const vehicle = await db.collection<StickerVehicleReference>("sticker_vehicle_references")
          .findOne({ _id: reference, shopId: id });
        return vehicle?.vin || null;
      },
      canViewVhi: async () => (await getFeatureEntitlements(numericShopId)).canUseFeature("maintenance"),
    });
    await db.collection("sticker_qr_scans").insertOne({
      shopId: numericShopId,
      scannedAt: new Date(),
      userAgent: req.headers.get("user-agent") || null,
      referer: req.headers.get("referer") || null,
      destinationKind: resolved.kind,
    });

    if (!resolved.url) {
      return new NextResponse(
        `<!DOCTYPE html>
<html>
<head><title>No Appointment URL</title></head>
<body style="font-family: sans-serif; text-align: center; padding: 50px;">
  <h1>Appointment booking not configured</h1>
    <p>Please contact the shop directly.</p>
    ${shop.phone ? `<p>Phone: ${String(shop.phone).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)}</p>` : ""}
</body>
</html>`,
        { status: 200, headers: { "Content-Type": "text/html", "Cache-Control": "no-store" } }
      );
    }

    const response = NextResponse.redirect(new URL(resolved.url, req.url), 302);
    response.headers.set("Cache-Control", "private, no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  } catch (error) {
    console.error("[Sticker Redirect] Error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
