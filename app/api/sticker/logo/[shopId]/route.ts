import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ shopId: string }> }
) {
  try {
    const { shopId } = await params;
    const shopIdNum = Number(shopId);
    
    if (!shopIdNum) {
      return NextResponse.json({ error: "Invalid shop ID" }, { status: 400 });
    }

    const db = await getDb();
    const media = await db.collection("shop_media").findOne({
      shopId: shopIdNum,
      type: "logo",
    });

    if (!media?.dataUri) {
      return NextResponse.json({ error: "Logo not found" }, { status: 404 });
    }

    // Parse data URI
    const matches = media.dataUri.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) {
      return NextResponse.json({ error: "Invalid logo data" }, { status: 500 });
    }

    const contentType = matches[1];
    const base64Data = matches[2];
    const buffer = Buffer.from(base64Data, "base64");

    return new NextResponse(buffer, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400", // Cache for 1 day
      },
    });
  } catch (error) {
    console.error("[Logo Serve] Error:", error);
    return NextResponse.json({ error: "Failed to serve logo" }, { status: 500 });
  }
}
