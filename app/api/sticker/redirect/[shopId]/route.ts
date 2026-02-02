import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ shopId: string }> }
) {
  const { shopId } = await params;
  const numericShopId = parseInt(shopId, 10);

  if (isNaN(numericShopId)) {
    return NextResponse.json({ error: "Invalid shop ID" }, { status: 400 });
  }

  try {
    const db = await getDb();
    const shop = await db.collection("shops").findOne({ shopId: numericShopId });

    if (!shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    }

    const appointmentUrl = shop.stickerConfig?.appointmentUrl || shop.websiteUrl || null;

    if (!appointmentUrl) {
      return new NextResponse(
        `<!DOCTYPE html>
<html>
<head><title>No Appointment URL</title></head>
<body style="font-family: sans-serif; text-align: center; padding: 50px;">
  <h1>Appointment booking not configured</h1>
  <p>Please contact the shop directly.</p>
  ${shop.phone ? `<p>Phone: <a href="tel:${shop.phone}">${shop.phone}</a></p>` : ""}
</body>
</html>`,
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }

    await db.collection("sticker_qr_scans").insertOne({
      shopId: numericShopId,
      scannedAt: new Date(),
      userAgent: req.headers.get("user-agent") || null,
      referer: req.headers.get("referer") || null,
    });

    return NextResponse.redirect(appointmentUrl, 302);
  } catch (error) {
    console.error("[Sticker Redirect] Error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
