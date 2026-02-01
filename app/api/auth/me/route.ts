// app/api/auth/me/route.ts
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getShopByShopId } from "@/lib/db/shops-pg";
import { getEnterpriseById } from "@/lib/enterprise-pg";
import sql from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const sess = await getSession();

  if (!sess) {
    return NextResponse.json({ ok: true, authenticated: false });
  }

  const shop = await getShopByShopId(sess.shopId);

  let hasEnterpriseBilling = false;
  if (shop?.enterprise_id) {
    try {
      const enterprise = await getEnterpriseById(shop.enterprise_id);
      const billing = enterprise ? await sql<{billing: Record<string, unknown>}[]>`
        SELECT billing FROM enterprise_accounts WHERE id = ${shop.enterprise_id} LIMIT 1
      ` : null;
      hasEnterpriseBilling = billing?.[0]?.billing?.enabled === true;
    } catch (e) {
      // If enterpriseId is invalid, just ignore
    }
  }

  const branding = shop?.branding as Record<string, unknown> | null;

  return NextResponse.json({
    ok: true,
    authenticated: true,
    email: sess.email,
    role: sess.role,
    shopId: sess.shopId,
    shopName: shop?.name || `Shop ${sess.shopId}`,
    shopLogo: branding?.logo || null,
    locationIdentifier: shop?.location_identifier || null,
    isPlatformAdmin: sess.isPlatformAdmin || false,
    enterpriseId: shop?.enterprise_id || null,
    hasEnterpriseBilling,
  });
}
