import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || session.role !== "platform_admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const admin = session;

  const body = await req.json();
  const { shopId, extensionDays } = body;
  
  if (!shopId || typeof extensionDays !== "number" || extensionDays < 1 || extensionDays > 30) {
    return NextResponse.json({ 
      error: "Invalid request. shopId required, extensionDays must be 1-30" 
    }, { status: 400 });
  }

  const now = new Date();
  
  const shopResult = await sql`
    SELECT * FROM shops WHERE shop_id = ${String(shopId)} LIMIT 1
  `;
  const shop = shopResult[0];
  
  if (!shop) {
    return NextResponse.json({ error: "Shop not found" }, { status: 404 });
  }

  const billing = shop.billing as Record<string, unknown> | null;
  
  if (billing?.status !== "past_due" && billing?.status !== "suspended") {
    return NextResponse.json({ 
      error: `Shop billing status is ${billing?.status}, not past_due or suspended` 
    }, { status: 400 });
  }
  
  const currentEnd = billing?.gracePeriodEndsAt 
    ? new Date(billing.gracePeriodEndsAt as string) 
    : now;
  
  const newEndDate = new Date(Math.max(currentEnd.getTime(), now.getTime()) + extensionDays * 24 * 60 * 60 * 1000);
  
  const updatedBilling: Record<string, unknown> = {
    ...billing,
    gracePeriodEndsAt: newEndDate.toISOString(),
    gracePeriodExtendedBy: admin.email,
    gracePeriodExtendedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  
  let enabledFeatures = (shop.enabled_features as Record<string, boolean>) || {};
  
  if (billing?.status === "suspended") {
    updatedBilling.status = "past_due";
    
    const plan = (billing?.plan as string) || "starter";
    const planFeatures: Record<string, boolean> = {
      maintenance: true,
      job_lookup: plan !== "starter" && plan !== "trial",
      common_failures: plan !== "starter" && plan !== "trial",
      oil_sticker: plan !== "trial",
      keytags: plan === "elite" || plan === "enterprise",
      auto_booking: plan === "elite" || plan === "enterprise",
      part_xref: plan === "elite" || plan === "enterprise",
    };
    
    enabledFeatures = { ...enabledFeatures, ...planFeatures };
    
    console.log(`[Admin] Restoring features for shop ${shopId} (${plan} plan) after grace extension`);
  }
  
  await sql`
    UPDATE shops 
    SET billing = ${JSON.stringify(updatedBilling)}::jsonb,
        enabled_features = ${JSON.stringify(enabledFeatures)}::jsonb,
        updated_at = ${now}
    WHERE shop_id = ${String(shopId)}
  `;
  
  await sql`
    INSERT INTO billing_status_log (shop_id, shop_name, action, extension_days, previous_end_date, new_end_date, extended_by, previous_status, new_status, created_at)
    VALUES (${String(shopId)}, ${shop.name}, 'grace_period_extended', ${extensionDays}, ${billing?.gracePeriodEndsAt as string || null}, ${newEndDate}, ${admin.email}, ${billing?.status as string}, ${(updatedBilling.status as string) || (billing?.status as string)}, ${now})
  `;
  
  console.log(`[Admin] ${admin.email} extended grace period for shop ${shopId} by ${extensionDays} days (new end: ${newEndDate.toISOString()})`);
  
  return NextResponse.json({
    success: true,
    shopId: shopId,
    shopName: shop.name,
    previousEndDate: billing?.gracePeriodEndsAt,
    newEndDate: newEndDate.toISOString(),
    extensionDays,
    extendedBy: admin.email,
    statusChange: billing?.status === "suspended" ? "suspended → past_due" : null,
  });
}
