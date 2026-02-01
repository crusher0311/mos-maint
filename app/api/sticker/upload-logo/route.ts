import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { sql } from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_LOGO_SIZE = 500 * 1024; // 500KB

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = Number(session.shopId);
  if (!shopId) {
    return NextResponse.json({ error: "No shop associated" }, { status: 400 });
  }

  if (!["owner", "admin", "manager"].includes(session.role)) {
    return NextResponse.json(
      { error: "Insufficient permissions" },
      { status: 403 }
    );
  }

  try {
    const body = await req.json();
    const { contentType, base64Data } = body;

    if (!contentType || !base64Data) {
      return NextResponse.json(
        { error: "Missing contentType or base64Data" },
        { status: 400 }
      );
    }

    if (!contentType.startsWith("image/")) {
      return NextResponse.json(
        { error: "Only image files are allowed" },
        { status: 400 }
      );
    }

    const dataSize = (base64Data.length * 3) / 4;
    if (dataSize > MAX_LOGO_SIZE) {
      return NextResponse.json(
        { error: `Logo too large. Maximum size is ${Math.round(MAX_LOGO_SIZE / 1024)}KB` },
        { status: 400 }
      );
    }

    const dataUri = `data:${contentType};base64,${base64Data}`;
    
    await sql`
      INSERT INTO shop_media (shop_id, type, data_uri, content_type, updated_at, updated_by)
      VALUES (${String(shopId)}, 'logo', ${dataUri}, ${contentType}, NOW(), ${session.email})
      ON CONFLICT (shop_id, type) 
      DO UPDATE SET data_uri = ${dataUri}, content_type = ${contentType}, updated_at = NOW(), updated_by = ${session.email}
    `;

    const shopRows = await sql`
      SELECT sticker_config FROM shops WHERE shop_id = ${String(shopId)} LIMIT 1
    `;
    const existingConfig = (shopRows[0]?.sticker_config as any) || {};
    const updatedConfig = { 
      ...existingConfig, 
      logo: `/api/sticker/logo/${shopId}`,
      logoUpdatedAt: new Date().toISOString()
    };
    
    await sql`
      UPDATE shops SET sticker_config = ${JSON.stringify(updatedConfig)}::jsonb, updated_at = NOW()
      WHERE shop_id = ${String(shopId)}
    `;

    return NextResponse.json({
      logoUrl: `/api/sticker/logo/${shopId}`,
      success: true,
    });
  } catch (error) {
    console.error("[Upload Logo] Error:", error);
    return NextResponse.json(
      { error: "Failed to upload logo" },
      { status: 500 }
    );
  }
}
