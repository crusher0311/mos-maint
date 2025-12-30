// app/api/auth/me/route.ts
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const sess = await getSession();

  if (!sess) {
    return NextResponse.json({ ok: true, authenticated: false });
  }

  const db = await getDb();
  const shop = await db.collection("shops").findOne({ shopId: sess.shopId });

  return NextResponse.json({
    ok: true,
    authenticated: true,
    email: sess.email,
    role: sess.role,
    shopId: sess.shopId,
    shopName: shop?.name || `Shop ${sess.shopId}`,
    shopLogo: shop?.branding?.logo || null,
    locationIdentifier: shop?.locationIdentifier || null,
    isPlatformAdmin: sess.isPlatformAdmin || false,
    enterpriseId: shop?.enterpriseId || null,
  });
}
