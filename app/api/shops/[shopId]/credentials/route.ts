import { NextRequest, NextResponse } from "next/server";
import sql from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  apiKey?: string;
  apiPassword?: string;
  apiBase?: string;
};

function mask(s?: string, keep = 4) {
  if (!s) return "";
  if (s.length <= keep) return "*".repeat(s.length);
  return `${"*".repeat(Math.max(0, s.length - keep))}${s.slice(-keep)}`;
}

export async function PUT(req: NextRequest, ctx: { params: { shopId: string } }) {
  try {
    const raw = ctx.params?.shopId?.trim();
    if (!raw) return NextResponse.json({ error: "Missing shopId in path" }, { status: 400 });

    const body = (await req.json()) as Body;
    const { apiKey, apiPassword, apiBase } = body || {};
    if (!apiKey || !apiPassword) {
      return NextResponse.json({ error: "apiKey and apiPassword are required" }, { status: 400 });
    }

    const shopResult = await sql`SELECT shop_id, settings FROM shops WHERE shop_id = ${raw} LIMIT 1`;
    const shop = shopResult[0];
    if (!shop) return NextResponse.json({ error: `Shop ${raw} not found` }, { status: 404 });

    const existingSettings = (shop.settings as Record<string, unknown>) || {};
    const credentials = (existingSettings.credentials as Record<string, unknown>) || {};
    
    const updatedSettings = {
      ...existingSettings,
      credentials: {
        ...credentials,
        autoflow: { apiKey, apiPassword, ...(apiBase ? { apiBase } : {}) }
      }
    };

    await sql`
      UPDATE shops SET settings = ${JSON.stringify(updatedSettings)}::jsonb, updated_at = ${new Date()}
      WHERE shop_id = ${raw}
    `;

    return NextResponse.json({
      ok: true,
      shopId: shop.shop_id,
      saved: true,
      credentials: {
        provider: "autoflow",
        apiKey: mask(apiKey),
        apiPassword: mask(apiPassword),
        apiBase: apiBase || null,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(_req: NextRequest, ctx: { params: { shopId: string } }) {
  try {
    const raw = ctx.params?.shopId?.trim();
    if (!raw) return NextResponse.json({ error: "Missing shopId in path" }, { status: 400 });

    const shopResult = await sql`SELECT shop_id, settings FROM shops WHERE shop_id = ${raw} LIMIT 1`;
    const shop = shopResult[0];

    if (!shop) return NextResponse.json({ error: `Shop ${raw} not found` }, { status: 404 });

    const settings = (shop.settings as Record<string, unknown>) || {};
    const credentials = (settings.credentials as Record<string, unknown>) || {};
    const c = (credentials.autoflow as Record<string, unknown>) || {};
    const hasCreds = Boolean(c.apiKey && c.apiPassword);

    return NextResponse.json({
      ok: true,
      shopId: shop.shop_id,
      hasCreds,
      credentials: hasCreds
        ? {
            provider: "autoflow",
            apiKey: mask(c.apiKey as string),
            apiPassword: mask(c.apiPassword as string),
            apiBase: (c.apiBase as string) ?? null,
          }
        : null,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
