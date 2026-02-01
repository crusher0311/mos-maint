import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";
import crypto from "crypto";

export const runtime = "nodejs";

export async function GET() {
  try {
    const session = await requireSession();
    const shopId = String(session.shopId);

    const shopResult = await sql`
      SELECT autoflow_config, webhook_token FROM shops WHERE shop_id = ${shopId} LIMIT 1
    `;
    const shop = shopResult[0];
    const autoflowConfig = (shop?.autoflow_config as Record<string, unknown>) || {};

    let webhookToken = shop?.webhook_token;
    if (!webhookToken) {
      webhookToken = crypto.randomBytes(12).toString("hex");
      await sql`
        UPDATE shops SET webhook_token = ${webhookToken} WHERE shop_id = ${shopId}
      `;
    }

    return NextResponse.json({
      autoflowDomain: autoflowConfig.domain || autoflowConfig.autoflowDomain || "",
      autoflowApiKey: autoflowConfig.apiKey || autoflowConfig.autoflowApiKey || "",
      autoflowApiPassword: autoflowConfig.apiPassword || autoflowConfig.autoflowApiPassword || "",
      configured: Boolean((autoflowConfig.domain || autoflowConfig.autoflowDomain) && (autoflowConfig.apiKey || autoflowConfig.autoflowApiKey)),
      webhookToken,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message || "Unexpected error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { domain, apiKey, apiPassword, shopId: bodyShopId, autoflowDomain, autoflowApiKey, autoflowApiPassword } = body || {};
    const session = await requireSession();
    const shopId = String(session.shopId);

    if (bodyShopId && String(bodyShopId) !== shopId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const domainValue = domain || autoflowDomain || "";
    const keyValue = apiKey || autoflowApiKey || "";
    const passwordValue = apiPassword || autoflowApiPassword || "";

    const normalizedDomain = String(domainValue)
      .replace(/^https?:\/\//i, "")
      .replace(/\/.*$/, "")
      .replace(/[./]+$/, "");

    const shopResult = await sql`SELECT autoflow_config FROM shops WHERE shop_id = ${shopId} LIMIT 1`;
    const existingConfig = (shopResult[0]?.autoflow_config as Record<string, unknown>) || {};

    const updatedConfig = {
      ...existingConfig,
      domain: normalizedDomain,
      apiKey: String(keyValue),
      apiPassword: String(passwordValue),
    };

    await sql`
      UPDATE shops SET autoflow_config = ${JSON.stringify(updatedConfig)}::jsonb, updated_at = ${new Date()}
      WHERE shop_id = ${shopId}
    `;

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message || "Unexpected error" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const session = await requireSession();
    const shopId = String(session.shopId);

    await sql`
      UPDATE shops SET autoflow_config = NULL, updated_at = ${new Date()}
      WHERE shop_id = ${shopId}
    `;

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message || "Unexpected error" }, { status: 500 });
  }
}
