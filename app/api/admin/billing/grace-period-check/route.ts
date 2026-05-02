import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { sendEmail, makeAccountSuspendedEmail, makeGraceReminderEmail } from "@/lib/email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  
  const isProduction = process.env.NODE_ENV === "production";
  if (isProduction && !cronSecret) {
    console.error("[Grace Period] CRON_SECRET not configured in production");
    return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  }
  
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
    remindersSent: 0,
    transitioned: [] as { shopId: number; shopName: string }[],
    errors: [] as { shopId: number; error: string }[],
  };
  
  const activeGracePeriodShops = await db.collection("shops").find({
    "billing.status": "past_due",
    "billing.gracePeriodEndsAt": { $gt: now }
  }).toArray();
  
  for (const shop of activeGracePeriodShops) {
    try {
      const gracePeriodEndsAt = new Date(shop.billing.gracePeriodEndsAt);
      const daysRemaining = Math.ceil((gracePeriodEndsAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
      
      const lastReminderSent = shop.billing?.lastReminderSentAt 
        ? new Date(shop.billing.lastReminderSentAt) 
        : null;
      const hoursSinceLastReminder = lastReminderSent 
        ? (now.getTime() - lastReminderSent.getTime()) / (1000 * 60 * 60)
        : 999;
      
      if ((daysRemaining === 3 || daysRemaining === 4 || daysRemaining === 2 || daysRemaining === 1) && hoursSinceLastReminder > 20) {
        const owner = await db.collection("users").findOne({ shopId: shop.shopId, role: "owner" });
        if (owner?.email) {
          const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://mos.tools";
          const updatePaymentUrl = `${baseUrl}/dashboard/settings/billing`;
          const emailContent = makeGraceReminderEmail(shop.name || `Shop ${shop.shopId}`, updatePaymentUrl, daysRemaining);
          
          const reminderResult = await sendEmail({
            to: owner.email,
            ...emailContent,
            shopId: shop.shopId,
            emailKind: "grace_reminder",
          });
          if (!reminderResult.ok) {
            console.warn(
              `[Grace Period] reminder suppressed for shop ${shop.shopId}: ${reminderResult.reason}`,
            );
            continue;
          }
          await db.collection("shops").updateOne(
            { shopId: shop.shopId },
            { $set: { "billing.lastReminderSentAt": now } }
          );
          results.remindersSent++;
          console.log(`[Grace Period] Sent ${daysRemaining}-day reminder to ${owner.email} for shop ${shop.shopId}`);
        }
      }
    } catch (error) {
      console.error(`[Grace Period] Error sending reminder for shop ${shop.shopId}:`, error);
    }
  }
  
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
      results.transitioned.push({ shopId: shop.shopId, shopName: shop.name || `Shop ${shop.shopId}` });
      console.log(`[Grace Period] Shop ${shop.shopId} (${shop.name}) suspended - grace period expired`);
      
      const owner = await db.collection("users").findOne({ shopId: shop.shopId, role: "owner" });
      if (owner?.email) {
        const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://mos.tools";
        const updatePaymentUrl = `${baseUrl}/dashboard/settings/billing`;
        const emailContent = makeAccountSuspendedEmail(shop.name || `Shop ${shop.shopId}`, updatePaymentUrl);
        sendEmail({
          to: owner.email,
          ...emailContent,
          shopId: shop.shopId,
          emailKind: "account_suspended",
        }).catch(err => {
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
