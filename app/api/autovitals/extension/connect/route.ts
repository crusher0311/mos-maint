import { NextRequest, NextResponse } from "next/server";
import sql from "@/lib/db/postgres";

export const runtime = "nodejs";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-API-Key, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function POST(req: NextRequest) {
  try {
    const apiKey = req.headers.get("X-API-Key");
    
    if (!apiKey) {
      return NextResponse.json(
        { error: "API key is required" },
        { status: 401, headers: corsHeaders }
      );
    }

    const rows = await sql`
      SELECT id, shop_id, name, settings FROM shops 
      WHERE settings->>'autovitalsApiKey' = ${apiKey}
         OR settings->'autovitalsExtension'->'apiKeys' @> ${JSON.stringify([{ value: apiKey }])}::jsonb
      LIMIT 1
    `;
    const shop = rows[0];

    if (!shop) {
      return NextResponse.json(
        { error: "Invalid API key" },
        { status: 401, headers: corsHeaders }
      );
    }

    await sql`
      UPDATE shops SET
        settings = jsonb_set(
          jsonb_set(
            COALESCE(settings, '{}'),
            '{autovitals,extensionConnected}', 'true'::jsonb
          ),
          '{autovitals,extensionConnectedAt}', ${JSON.stringify(new Date().toISOString())}::jsonb
        ),
        updated_at = NOW()
      WHERE id = ${shop.id}
    `;

    return NextResponse.json({
      ok: true,
      shopName: shop.name || "Your Shop",
      message: "Connected successfully"
    }, { headers: corsHeaders });
  } catch (error: any) {
    console.error("[AutoVitals Extension] Connect error:", error);
    return NextResponse.json(
      { error: error.message || "Connection failed" },
      { status: 500, headers: corsHeaders }
    );
  }
}
