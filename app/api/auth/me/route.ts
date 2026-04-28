// app/api/auth/me/route.ts
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { ObjectId } from "mongodb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const sess = await getSession();

  if (!sess) {
    return NextResponse.json({ ok: true, authenticated: false });
  }

  const db = await getDb();
  const shop = await db.collection("shops").findOne({ shopId: sess.shopId });

  let hasEnterpriseBilling = false;
  if (shop?.enterpriseId) {
    try {
      const enterprise = await db.collection("enterprise_accounts").findOne({
        _id: new ObjectId(shop.enterpriseId.toString())
      });
      hasEnterpriseBilling = enterprise?.billing?.enabled === true;
    } catch (e) {
      // If enterpriseId is invalid, just ignore
    }
  }

  const user = await db.collection("users").findOne({ email: sess.email, shopId: sess.shopId });

  const needsSetup = !!(
    shop?.provisionedVia &&
    !shop?.setupCompleted
  );

  const mustChangePassword = !!user?.mustChangePassword;

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
    hasEnterpriseBilling,
    needsSetup,
    mustChangePassword,
  });
}
