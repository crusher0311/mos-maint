import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: { shopId: string } }) {
  const sess = await requireSession();
  const shopId = ctx.params.shopId;
  if (!shopId || shopId !== String(sess.shopId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const shopResult = await sql`
    SELECT autoflow_config FROM shops WHERE shop_id = ${shopId} LIMIT 1
  `;
  const shop = shopResult[0];
  const autoflowConfig = (shop?.autoflow_config as Record<string, unknown>) || {};

  const autoflow = {
    subdomain: autoflowConfig.subdomain || "",
    apiKey: autoflowConfig.apiKey || "",
  };

  return NextResponse.json({ ok: true, autoflow });
}

export async function PUT(req: NextRequest, ctx: { params: { shopId: string } }) {
  const sess = await requireSession();
  const shopId = ctx.params.shopId;
  if (!shopId || shopId !== String(sess.shopId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const subdomain = String(body.subdomain || "").trim();
  const apiKey = String(body.apiKey || "").trim();
  const apiPassword = String(body.apiPassword || "").trim();

  const shopResult = await sql`SELECT autoflow_config FROM shops WHERE shop_id = ${shopId} LIMIT 1`;
  const existingConfig = (shopResult[0]?.autoflow_config as Record<string, unknown>) || {};

  const updatedConfig: Record<string, unknown> = {
    ...existingConfig,
    subdomain: subdomain || null,
    apiKey: apiKey || null,
  };
  
  if (apiPassword) {
    updatedConfig.apiPassword = apiPassword;
  }

  await sql`
    UPDATE shops 
    SET autoflow_config = ${JSON.stringify(updatedConfig)}::jsonb, updated_at = ${new Date()}
    WHERE shop_id = ${shopId}
  `;

  return NextResponse.json({ ok: true });
}
