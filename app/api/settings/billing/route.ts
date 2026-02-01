import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_TRIAL_VIN_LIMIT = 10;

export async function GET() {
  const sess = await getSession();
  if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const shopId = String(sess.shopId);

  const shopResult = await sql`SELECT * FROM shops WHERE shop_id = ${shopId} LIMIT 1`;
  const shop = shopResult[0];
  const billing = (shop?.billing as Record<string, unknown>) || {};
  const settings = (shop?.settings as Record<string, unknown>) || {};
  const isPaid = billing.plan === "professional" || billing.plan === "enterprise";

  if (isPaid) {
    const vehicleCountResult = await sql<{count: string}[]>`
      SELECT COUNT(*) as count FROM vehicles 
      WHERE shop_id = ${shop?.id}
    `;
    const vehicleCount = parseInt(vehicleCountResult[0]?.count || "0", 10);

    return NextResponse.json({
      plan: billing.plan || "Professional",
      status: billing.status || "active",
      vehicleCount,
      vehicleLimit: null,
      nextBillingDate: billing.nextBillingDate,
    });
  }

  const platformSettingsResult = await sql`SELECT * FROM platform_settings WHERE key = 'trial' LIMIT 1`;
  const platformSettings = platformSettingsResult[0]?.value as Record<string, unknown> | null;
  const defaultLimit = (platformSettings?.vinLimit as number) ?? DEFAULT_TRIAL_VIN_LIMIT;
  const shopLimit = (settings?.trialVinLimit as number) ?? defaultLimit;

  const viewedVinResult = await sql<{count: string}[]>`
    SELECT COUNT(*) as count FROM viewed_vins WHERE shop_id = ${shopId}
  `;
  const viewedVinCount = parseInt(viewedVinResult[0]?.count || "0", 10);

  return NextResponse.json({
    plan: "Free Trial",
    status: "trial",
    vehicleCount: viewedVinCount,
    vehicleLimit: shopLimit,
    nextBillingDate: null,
  });
}
