import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/shops/:shopId/invite
 * Header: X-Admin-Token (required)
 * Body (optional): { expiresInHours?: number }  // default 48h, clamped 1–168
 *
 * Creates a one-time setup token and returns an invite URL:
 *   https://<app>/setup?shopId=7&token=abcdef...
 */
export async function POST(req: NextRequest, ctx: { params: { shopId: string } }) {
  const admin = req.headers.get("x-admin-token");
  if (!admin) {
    return NextResponse.json({ error: "Missing X-Admin-Token" }, { status: 401 });
  }

  const shopIdNum = Number(ctx.params.shopId);
  if (!Number.isFinite(shopIdNum)) {
    return NextResponse.json({ error: "Invalid shopId" }, { status: 400 });
  }

  const body = await safeJson(req);
  const expiresInHours = Math.max(1, Math.min(Number(body?.expiresInHours ?? 48), 168)); // 1–168h
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresInHours * 3600 * 1000);

  const token = crypto.randomBytes(24).toString("hex");

  const db = await getDb();
  const shops = db.collection("shops");
  const setupTokens = db.collection("setup_tokens");

  const shop = await shops.findOne({ shopId: shopIdNum }, { projection: { name: 1 } });
  if (!shop) return NextResponse.json({ error: "Shop not found" }, { status: 404 });

  await setupTokens.insertOne({
    token,
    shopId: shopIdNum,
    createdAt: now,
    expiresAt,
    usedAt: null,
  });

  // Build a stable base URL:
  const base =
    process.env.APP_BASE_URL ||
    (req.nextUrl.origin ?? `https://${req.headers.get("host") ?? ""}`).replace(/\/+$/, "");

  const inviteUrl = `${base}/setup?shopId=${encodeURIComponent(shopIdNum)}&token=${encodeURIComponent(
    token
  )}`;

  return NextResponse.json({
    ok: true,
    shopId: shopIdNum,
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
