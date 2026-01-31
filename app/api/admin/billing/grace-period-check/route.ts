import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { sendEmail, makeAccountSuspendedEmail } from "@/lib/email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = await getDb();
  const now = new Date();
  
  const expiredGracePeriodShops = await db.collection("shops").find({
    "billing.status": "past_due",
    "billing.gracePeriodEndsAt": { $lte: now }
  }).toArray();
  
  const results = {
    checked: expiredGracePeriodShops.length,
    suspended: [] as number[],
    errors: [] as { shopId: number; error: string }[],
  };
  
  for (const shop of expiredGracePeriodShops) {
    try {
      await db.collection("shops").updateOne(
        { shopId: shop.shopId },
        {
          $set: {
            "billing.status": "suspended",
            "billing.suspendedAt": now,
            "billing.updatedAt": now,
            "enabledFeatures.maintenance": false,
            "enabledFeatures.job_lookup": false,
            "enabledFeatures.common_failures": false,
            "enabledFeatures.oil_sticker": false,
            "enabledFeatures.keytags": false,
            "enabledFeatures.auto_booking": false,
            "enabledFeatures.part_xref": false,
          }
        }
      );
      
      results.suspended.push(shop.shopId);
      console.log(`[Grace Period] Shop ${shop.shopId} (${shop.name}) suspended - grace period expired`);
      
      const owner = await db.collection("users").findOne({ shopId: shop.shopId, role: "owner" });
      if (owner?.email) {
        const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://mos.tools";
        const updatePaymentUrl = `${baseUrl}/dashboard/settings/billing`;
        const emailContent = makeAccountSuspendedEmail(shop.name || `Shop ${shop.shopId}`, updatePaymentUrl);
        sendEmail({ to: owner.email, ...emailContent }).catch(err => {
          console.error(`[Grace Period] Failed to send suspended email to ${owner.email}:`, err);
        });
      }
      
      await db.collection("billing_status_log").insertOne({
        shopId: shop.shopId,
        shopName: shop.name,
        previousStatus: "past_due",
        newStatus: "suspended",
        reason: "grace_period_expired",
        gracePeriodStartedAt: shop.billing?.gracePeriodStartedAt,
        gracePeriodEndsAt: shop.billing?.gracePeriodEndsAt,
        createdAt: now,
      });
      
    } catch (error) {
      console.error(`[Grace Period] Error suspending shop ${shop.shopId}:`, error);
      results.errors.push({ shopId: shop.shopId, error: String(error) });
    }
  }
  
  console.log(`[Grace Period Check] Completed: ${results.suspended.length} shops suspended, ${results.errors.length} errors`);
  
  return NextResponse.json({
    success: true,
    timestamp: now.toISOString(),
    ...results,
  });
}

export async function GET(req: NextRequest) {
  const db = await getDb();
  const now = new Date();
  
  const pastDueShops = await db.collection("shops").find({
    "billing.status": "past_due"
  }).project({
    shopId: 1,
    name: 1,
    "billing.gracePeriodStartedAt": 1,
    "billing.gracePeriodEndsAt": 1,
    "billing.gracePeriodExtendedBy": 1,
  }).toArray();
  
  const suspendedShops = await db.collection("shops").find({
    "billing.status": "suspended"
  }).project({
    shopId: 1,
    name: 1,
    "billing.suspendedAt": 1,
    "billing.gracePeriodStartedAt": 1,
  }).toArray();
  
  return NextResponse.json({
    timestamp: now.toISOString(),
    pastDue: pastDueShops.map(shop => ({
      shopId: shop.shopId,
      name: shop.name,
      gracePeriodStartedAt: shop.billing?.gracePeriodStartedAt,
      gracePeriodEndsAt: shop.billing?.gracePeriodEndsAt,
      daysRemaining: shop.billing?.gracePeriodEndsAt 
        ? Math.max(0, Math.ceil((new Date(shop.billing.gracePeriodEndsAt).getTime() - now.getTime()) / (24 * 60 * 60 * 1000)))
        : null,
      extendedBy: shop.billing?.gracePeriodExtendedBy,
    })),
    suspended: suspendedShops.map(shop => ({
      shopId: shop.shopId,
      name: shop.name,
      suspendedAt: shop.billing?.suspendedAt,
      gracePeriodStartedAt: shop.billing?.gracePeriodStartedAt,
    })),
  });
}
