// app/api/shops/[shopId]/credentials/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";

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

// Build a query that matches both numeric (new) and string (legacy) shopId values.
function shopIdQuery(raw: string) {
  const n = Number(raw);
  const parts: any[] = [];
  if (Number.isFinite(n)) parts.push({ shopId: n });
  parts.push({ shopId: raw }); // legacy
  return parts.length === 1 ? parts[0] : { $or: parts };
}

/** PUT /api/shops/[shopId]/credentials  Body: { apiKey, apiPassword, apiBase? } */
export async function PUT(req: NextRequest, ctx: { params: { shopId: string } }) {
  try {
    const raw = ctx.params?.shopId?.trim();
    if (!raw) return NextResponse.json({ error: "Missing shopId in path" }, { status: 400 });

    const body = (await req.json()) as Body;
    const { apiKey, apiPassword, apiBase } = body || {};
    if (!apiKey || !apiPassword) {
      return NextResponse.json({ error: "apiKey and apiPassword are required" }, { status: 400 });
    }

    const db = await getDb();
    const shops = db.collection("shops");

    // Ensure shop exists
    const q = shopIdQuery(raw);
    const shop = await shops.findOne(q);
    if (!shop) return NextResponse.json({ error: `Shop ${raw} not found` }, { status: 404 });

    await shops.updateOne(q, {
      $set: {
        "credentials.autoflow": { apiKey, apiPassword, ...(apiBase ? { apiBase } : {}) },
        updatedAt: new Date(),
      },
    });

    return NextResponse.json({
      ok: true,
      shopId: shop.shopId,
      saved: true,
      credentials: {
        provider: "autoflow",
        apiKey: mask(apiKey),
        apiPassword: mask(apiPassword),
        apiBase: apiBase || null,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}

/** GET /api/shops/[shopId]/credentials — masked status */
export async function GET(_req: NextRequest, ctx: { params: { shopId: string } }) {
  try {
    const raw = ctx.params?.shopId?.trim();
    if (!raw) return NextResponse.json({ error: "Missing shopId in path" }, { status: 400 });

    const db = await getDb();
    const shops = db.collection("shops");
    const q = shopIdQuery(raw);
    const shop = await shops.findOne(q, { projection: { "credentials.autoflow": 1, shopId: 1 } });

    if (!shop) return NextResponse.json({ error: `Shop ${raw} not found` }, { status: 404 });

    const c = shop.credentials?.autoflow;
    const hasCreds = Boolean(c?.apiKey && c?.apiPassword);

    return NextResponse.json({
      ok: true,
      shopId: shop.shopId,
      hasCreds,
      credentials: hasCreds
        ? {
            provider: "autoflow",
            apiKey: mask(c.apiKey),
            apiPassword: mask(c.apiPassword),
            apiBase: c.apiBase ?? null,
          }
        : null,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}
