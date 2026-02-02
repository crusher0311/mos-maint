import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";

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

  const db = await getDb();
  const now = new Date();
  
  const shop = await db.collection("shops").findOne({ shopId: Number(shopId) });
  
  if (!shop) {
    return NextResponse.json({ error: "Shop not found" }, { status: 404 });
  }
  
  if (shop.billing?.status !== "past_due" && shop.billing?.status !== "suspended") {
    return NextResponse.json({ 
      error: `Shop billing status is ${shop.billing?.status}, not past_due or suspended` 
    }, { status: 400 });
  }
  
  const currentEnd = shop.billing?.gracePeriodEndsAt 
    ? new Date(shop.billing.gracePeriodEndsAt) 
    : now;
  
  const newEndDate = new Date(Math.max(currentEnd.getTime(), now.getTime()) + extensionDays * 24 * 60 * 60 * 1000);
  
  const updateData: Record<string, any> = {
    "billing.gracePeriodEndsAt": newEndDate,
    "billing.gracePeriodExtendedBy": admin.email,
    "billing.gracePeriodExtendedAt": now,
    "billing.updatedAt": now,
  };
  
  if (shop.billing?.status === "suspended") {
    updateData["billing.status"] = "past_due";
    
    const plan = shop.billing?.plan || "starter";
    const planFeatures: Record<string, boolean> = {
      maintenance: true,
      job_lookup: plan !== "starter" && plan !== "trial",
      common_failures: plan !== "starter" && plan !== "trial",
      oil_sticker: plan !== "trial",
      keytags: plan === "elite" || plan === "enterprise",
      auto_booking: plan === "elite" || plan === "enterprise",
      part_xref: plan === "elite" || plan === "enterprise",
    };
    
    updateData["enabledFeatures.maintenance"] = planFeatures.maintenance;
    updateData["enabledFeatures.job_lookup"] = planFeatures.job_lookup;
    updateData["enabledFeatures.common_failures"] = planFeatures.common_failures;
    updateData["enabledFeatures.oil_sticker"] = planFeatures.oil_sticker;
    updateData["enabledFeatures.keytags"] = planFeatures.keytags;
    updateData["enabledFeatures.auto_booking"] = planFeatures.auto_booking;
    updateData["enabledFeatures.part_xref"] = planFeatures.part_xref;
    
    console.log(`[Admin] Restoring features for shop ${shopId} (${plan} plan) after grace extension`);
  }
  
  await db.collection("shops").updateOne(
    { shopId: Number(shopId) },
    { $set: updateData }
  );
  
  await db.collection("billing_status_log").insertOne({
    shopId: Number(shopId),
    shopName: shop.name,
    action: "grace_period_extended",
    extensionDays,
    previousEndDate: shop.billing?.gracePeriodEndsAt,
    newEndDate,
    extendedBy: admin.email,
    previousStatus: shop.billing?.status,
    newStatus: updateData["billing.status"] || shop.billing?.status,
    createdAt: now,
  });
  
  console.log(`[Admin] ${admin.email} extended grace period for shop ${shopId} by ${extensionDays} days (new end: ${newEndDate.toISOString()})`);
  
  return NextResponse.json({
    success: true,
    shopId: Number(shopId),
    shopName: shop.name,
    previousEndDate: shop.billing?.gracePeriodEndsAt,
    newEndDate: newEndDate.toISOString(),
    extensionDays,
    extendedBy: admin.email,
    statusChange: shop.billing?.status === "suspended" ? "suspended → past_due" : null,
  });
}
