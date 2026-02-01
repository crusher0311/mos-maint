import { NextRequest, NextResponse } from "next/server";
import sql from "@/lib/db/postgres";
import { requireSession } from "@/lib/auth";
import crypto from "crypto";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const session = await requireSession();
    const shopId = String(session.shopId);
    
    const apiKey = `mos_av_${crypto.randomBytes(24).toString('hex')}`;
    
    await sql`
      UPDATE shops SET
        settings = jsonb_set(
          jsonb_set(
            COALESCE(settings, '{}'),
            '{autovitalsApiKey}', ${JSON.stringify(apiKey)}::jsonb
          ),
          '{autovitals,keyGeneratedAt}', ${JSON.stringify(new Date().toISOString())}::jsonb
        ),
        updated_at = NOW()
      WHERE shop_id = ${shopId}
    `;

    return NextResponse.json({
      ok: true,
      apiKey,
      message: "API key generated successfully"
    });
  } catch (error: any) {
    console.error("[AutoVitals Extension] Generate key error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to generate API key" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const session = await requireSession();
    const shopId = String(session.shopId);
    
    await sql`
      UPDATE shops SET
        settings = jsonb_set(
          jsonb_set(
            settings - 'autovitalsApiKey',
            '{autovitals,keyRevokedAt}', ${JSON.stringify(new Date().toISOString())}::jsonb
          ),
          '{autovitals,extensionConnected}', 'false'::jsonb
        ),
        updated_at = NOW()
      WHERE shop_id = ${shopId}
    `;

    return NextResponse.json({
      ok: true,
      message: "API key revoked successfully"
    });
  } catch (error: any) {
    console.error("[AutoVitals Extension] Revoke key error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to revoke API key" },
      { status: 500 }
    );
  }
}
