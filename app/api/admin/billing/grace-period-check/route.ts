import { NextRequest, NextResponse } from "next/server";
import { sendEmail, makeAccountSuspendedEmail, makeGraceReminderEmail } from "@/lib/email";
import sql from "@/lib/db/postgres";

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

  const now = new Date();
  
  const expiredGracePeriodShops = await sql`
    SELECT * FROM shops 
    WHERE billing->>'status' = 'past_due' 
    AND (billing->>'gracePeriodEndsAt')::timestamp <= ${now}
  `;
  
  const results = {
    checked: expiredGracePeriodShops.length,
    suspended: [] as string[],
    remindersSent: 0,
    transitioned: [] as { shopId: string; shopName: string }[],
    errors: [] as { shopId: string; error: string }[],
  };
  
  const activeGracePeriodShops = await sql`
    SELECT * FROM shops 
    WHERE billing->>'status' = 'past_due' 
    AND (billing->>'gracePeriodEndsAt')::timestamp > ${now}
  `;
  
  for (const shop of activeGracePeriodShops) {
    try {
      const billing = shop.billing as Record<string, unknown>;
      const gracePeriodEndsAt = new Date(billing.gracePeriodEndsAt as string);
      const daysRemaining = Math.ceil((gracePeriodEndsAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
      
      const lastReminderSent = billing?.lastReminderSentAt 
        ? new Date(billing.lastReminderSentAt as string) 
        : null;
      const hoursSinceLastReminder = lastReminderSent 
        ? (now.getTime() - lastReminderSent.getTime()) / (1000 * 60 * 60)
        : 999;
      
      if ((daysRemaining === 3 || daysRemaining === 4 || daysRemaining === 2 || daysRemaining === 1) && hoursSinceLastReminder > 20) {
        const ownerResult = await sql`
          SELECT email FROM users WHERE shop_id = ${shop.shop_id} AND role = 'owner' LIMIT 1
        `;
        const owner = ownerResult[0];
        if (owner?.email) {
          const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://mos.tools";
          const updatePaymentUrl = `${baseUrl}/dashboard/settings/billing`;
          const emailContent = makeGraceReminderEmail(shop.name || `Shop ${shop.shop_id}`, updatePaymentUrl, daysRemaining);
          
          await sendEmail({ to: owner.email, ...emailContent });
          
          const updatedBilling = { ...billing, lastReminderSentAt: now.toISOString() };
          await sql`
            UPDATE shops SET billing = ${JSON.stringify(updatedBilling)}::jsonb WHERE shop_id = ${shop.shop_id}
          `;
          results.remindersSent++;
          console.log(`[Grace Period] Sent ${daysRemaining}-day reminder to ${owner.email} for shop ${shop.shop_id}`);
        }
      }
    } catch (error) {
      console.error(`[Grace Period] Error sending reminder for shop ${shop.shop_id}:`, error);
    }
  }
  
  for (const shop of expiredGracePeriodShops) {
    try {
      const billing = (shop.billing as Record<string, unknown>) || {};
      const enabledFeatures = (shop.enabled_features as Record<string, boolean>) || {};
      
      const updatedBilling = {
        ...billing,
        status: "suspended",
        suspendedAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      
      const updatedFeatures = {
        ...enabledFeatures,
        maintenance: false,
        job_lookup: false,
        common_failures: false,
        oil_sticker: false,
        keytags: false,
        auto_booking: false,
        part_xref: false,
      };

      await sql`
        UPDATE shops 
        SET billing = ${JSON.stringify(updatedBilling)}::jsonb,
            enabled_features = ${JSON.stringify(updatedFeatures)}::jsonb,
            updated_at = ${now}
        WHERE shop_id = ${shop.shop_id}
      `;
      
      results.suspended.push(shop.shop_id);
      results.transitioned.push({ shopId: shop.shop_id, shopName: shop.name || `Shop ${shop.shop_id}` });
      console.log(`[Grace Period] Shop ${shop.shop_id} (${shop.name}) suspended - grace period expired`);
      
      const ownerResult = await sql`
        SELECT email FROM users WHERE shop_id = ${shop.shop_id} AND role = 'owner' LIMIT 1
      `;
      const owner = ownerResult[0];
      if (owner?.email) {
        const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://mos.tools";
        const updatePaymentUrl = `${baseUrl}/dashboard/settings/billing`;
        const emailContent = makeAccountSuspendedEmail(shop.name || `Shop ${shop.shop_id}`, updatePaymentUrl);
        sendEmail({ to: owner.email, ...emailContent }).catch(err => {
          console.error(`[Grace Period] Failed to send suspended email to ${owner.email}:`, err);
        });
      }
      
      await sql`
        INSERT INTO billing_status_log (shop_id, shop_name, previous_status, new_status, reason, grace_period_started_at, grace_period_ends_at, created_at)
        VALUES (${shop.shop_id}, ${shop.name}, 'past_due', 'suspended', 'grace_period_expired', ${billing.gracePeriodStartedAt as string || null}, ${billing.gracePeriodEndsAt as string || null}, ${now})
      `;
      
    } catch (error) {
      console.error(`[Grace Period] Error suspending shop ${shop.shop_id}:`, error);
      results.errors.push({ shopId: shop.shop_id, error: String(error) });
    }
  }
  
  console.log(`[Grace Period Check] Completed: ${results.suspended.length} shops suspended, ${results.errors.length} errors`);
  
  return NextResponse.json({
    success: true,
    timestamp: now.toISOString(),
    ...results,
  });
}

export async function GET() {
  const now = new Date();
  
  const pastDueShops = await sql`
    SELECT shop_id, name, billing FROM shops WHERE billing->>'status' = 'past_due'
  `;
  
  const suspendedShops = await sql`
    SELECT shop_id, name, billing FROM shops WHERE billing->>'status' = 'suspended'
  `;
  
  return NextResponse.json({
    timestamp: now.toISOString(),
    pastDue: pastDueShops.map(shop => {
      const billing = shop.billing as Record<string, unknown>;
      return {
        shopId: shop.shop_id,
        name: shop.name,
        gracePeriodStartedAt: billing?.gracePeriodStartedAt,
        gracePeriodEndsAt: billing?.gracePeriodEndsAt,
        daysRemaining: billing?.gracePeriodEndsAt 
          ? Math.max(0, Math.ceil((new Date(billing.gracePeriodEndsAt as string).getTime() - now.getTime()) / (24 * 60 * 60 * 1000)))
          : null,
        extendedBy: billing?.gracePeriodExtendedBy,
      };
    }),
    suspended: suspendedShops.map(shop => {
      const billing = shop.billing as Record<string, unknown>;
      return {
        shopId: shop.shop_id,
        name: shop.name,
        suspendedAt: billing?.suspendedAt,
        gracePeriodStartedAt: billing?.gracePeriodStartedAt,
      };
    }),
  });
}
