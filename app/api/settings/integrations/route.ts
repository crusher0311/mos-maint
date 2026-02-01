import { NextResponse, NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const shopId = String(session.shopId);
    
    const shopResult = await sql`
      SELECT settings, protractor_config, tekmetric_config, autoflow_config 
      FROM shops 
      WHERE shop_id = ${shopId}
      LIMIT 1
    `;
    const shop = shopResult[0];

    const settings = shop?.settings as Record<string, unknown> | null;
    const protractorConfig = shop?.protractor_config as Record<string, unknown> | null;
    const tekmetricConfig = shop?.tekmetric_config as Record<string, unknown> | null;
    const autoflowConfig = shop?.autoflow_config as Record<string, unknown> | null;

    return NextResponse.json({
      smsProvider: settings?.smsProvider || null,
      protractor: {
        configured: !!protractorConfig?.configured
      },
      tekmetric: {
        configured: !!(tekmetricConfig?.configured || tekmetricConfig?.shopId)
      },
      autoflow: {
        configured: !!autoflowConfig?.configured
      }
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[Integrations Settings] Error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const shopId = String(session.shopId);
    const body = await req.json();
    
    const { smsProvider } = body;
    
    if (smsProvider && !["protractor", "tekmetric", "standalone"].includes(smsProvider)) {
      return NextResponse.json({ error: "Invalid SMS provider" }, { status: 400 });
    }

    const shopResult = await sql`SELECT settings FROM shops WHERE shop_id = ${shopId} LIMIT 1`;
    const existingSettings = (shopResult[0]?.settings as Record<string, unknown>) || {};
    const updatedSettings = { ...existingSettings, smsProvider: smsProvider || null };

    await sql`
      UPDATE shops 
      SET settings = ${JSON.stringify(updatedSettings)}::jsonb, updated_at = ${new Date()}
      WHERE shop_id = ${shopId}
    `;

    return NextResponse.json({ ok: true, smsProvider });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[Integrations Settings] Error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
