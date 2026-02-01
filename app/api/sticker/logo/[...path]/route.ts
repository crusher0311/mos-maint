import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  try {
    const { path } = await params;
    const shopIdStr = path[0];
    const shopIdNum = Number(shopIdStr);
    
    if (!shopIdNum) {
      return NextResponse.json({ error: "Invalid shop ID" }, { status: 400 });
    }

    const mediaRows = await sql`
      SELECT data_uri FROM shop_media 
      WHERE shop_id = ${String(shopIdNum)} AND type = 'logo'
      LIMIT 1
    `;

    if (mediaRows.length === 0 || !mediaRows[0].data_uri) {
      return NextResponse.json({ error: "Logo not found" }, { status: 404 });
    }

    const dataUri = mediaRows[0].data_uri;
    const matches = dataUri.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) {
      return NextResponse.json({ error: "Invalid logo data" }, { status: 500 });
    }

    const contentType = matches[1];
    const base64Data = matches[2];
    const buffer = Buffer.from(base64Data, "base64");

    return new NextResponse(buffer, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch (error) {
    console.error("[Logo Serve] Error:", error);
    return NextResponse.json({ error: "Failed to serve logo" }, { status: 500 });
  }
}
