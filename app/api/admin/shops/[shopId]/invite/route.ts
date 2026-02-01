import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import sql from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: { shopId: string } }) {
  const admin = req.headers.get("x-admin-token");
  if (!admin) {
    return NextResponse.json({ error: "Missing X-Admin-Token" }, { status: 401 });
  }

  const shopId = ctx.params.shopId;
  if (!shopId) {
    return NextResponse.json({ error: "Invalid shopId" }, { status: 400 });
  }

  const body = await safeJson(req);
  const expiresInHours = Math.max(1, Math.min(Number(body?.expiresInHours ?? 48), 168));
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresInHours * 3600 * 1000);

  const token = crypto.randomBytes(24).toString("hex");

  const shopResult = await sql`
    SELECT name FROM shops WHERE shop_id = ${shopId} LIMIT 1
  `;
  const shop = shopResult[0];
  if (!shop) return NextResponse.json({ error: "Shop not found" }, { status: 404 });

  await sql`
    INSERT INTO setup_tokens (token, shop_id, created_at, expires_at, used_at)
    VALUES (${token}, ${shopId}, ${now}, ${expiresAt}, ${null})
  `;

  const base =
    process.env.APP_BASE_URL ||
    (req.nextUrl.origin ?? `https://${req.headers.get("host") ?? ""}`).replace(/\/+$/, "");

  const inviteUrl = `${base}/setup?shopId=${encodeURIComponent(shopId)}&token=${encodeURIComponent(token)}`;

  return NextResponse.json({
    ok: true,
    shopId,
    shopName: shop.name,
    inviteUrl,
    expiresAt,
  });
}

async function safeJson(req: NextRequest) {
  try {
    return await req.json();
  } catch {
    return null;
  }
}
