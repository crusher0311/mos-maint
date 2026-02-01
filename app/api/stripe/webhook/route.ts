import { NextRequest, NextResponse } from "next/server";
import { stripe, getBillingSettings } from "@/lib/stripe";
import sql from "@/lib/db/postgres";
import { sendEmail, makeWelcomeEmail, makePaymentFailedEmail, makePaymentRecoveredEmail } from "@/lib/email";
import { createHovercodeQR } from "@/lib/hovercode";
import Stripe from "stripe";
import crypto from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function logWebhookEvent(
  event: Stripe.Event,
  status: "received" | "processed" | "failed",
  error?: string
) {
  try {
    if (status === "received") {
      await sql`
        INSERT INTO stripe_webhook_events (event_id, type, status, payload, retry_count, created_at, updated_at)
        VALUES (${event.id}, ${event.type}, ${status}, ${JSON.stringify(event.data.object)}::jsonb, 0, NOW(), NOW())
        ON CONFLICT (event_id) DO UPDATE SET status = ${status}, updated_at = NOW()
      `;
    } else {
      await sql`
        UPDATE stripe_webhook_events
        SET status = ${status}, error = ${error || null}, processed_at = NOW(), updated_at = NOW()
            ${status === "failed" ? sql`, retry_count = retry_count + 1` : sql``}
        WHERE event_id = ${event.id}
      `;
    }
  } catch (err) {
    console.error("[Stripe Webhook] Failed to log event:", err);
  }
}

export async function POST(req: NextRequest) {
  const body = await req.text();
  const sig = req.headers.get("stripe-signature");

  if (!sig) {
    return NextResponse.json({ error: "No signature" }, { status: 400 });
  }

  let event: Stripe.Event;
  
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  
  if (webhookSecret) {
    try {
      event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
    } catch (err: any) {
      console.error("Webhook signature verification failed:", err.message);
      return NextResponse.json({ error: "Webhook Error" }, { status: 400 });
    }
  } else {
    try {
      event = JSON.parse(body) as Stripe.Event;
      console.warn("No STRIPE_WEBHOOK_SECRET set - accepting unverified webhook");
    } catch (err) {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
  }

  const existingRows = await sql`
    SELECT * FROM stripe_webhook_events WHERE event_id = ${event.id} AND status = 'processed'
  `;
  
  if (existingRows.length > 0) {
    console.log(`[Stripe Webhook] Event ${event.id} already processed, skipping`);
    return NextResponse.json({ received: true, duplicate: true });
  }
  
  await logWebhookEvent(event, "received");

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const isSignupFlow = session.metadata?.signupFlow === "true";
        const pendingId = session.metadata?.pendingId;
        
        if (isSignupFlow && pendingId) {
          const pendingRows = await sql`SELECT * FROM pending_signups WHERE pending_id = ${pendingId}`;
          const pending = pendingRows[0] as any;
          
          if (!pending) {
            console.error(`[Stripe] Pending signup not found: ${pendingId}`);
            break;
          }
          
          if (pending.completed) {
            console.log(`[Stripe] Pending signup ${pendingId} already completed`);
            break;
          }
          
          const shopId = pending.reserved_shop_id;
          const now = new Date();
          const billingSettings = await getBillingSettings();
          const baseVins = billingSettings.mosProIncludedVins || 300;
          const bonusVins = billingSettings.skipTrialBonusVins || 50;
          const webhookToken = crypto.randomBytes(12).toString("hex");
          
          await sql`
            INSERT INTO shops (
              shop_id, name, webhook_token, created_at, updated_at,
              billing, enabled_features
            ) VALUES (
              ${shopId}, ${pending.shop_name}, ${webhookToken}, ${now}, ${now},
              ${JSON.stringify({
                plan: "pro",
                status: "active",
                vinLimit: baseVins + bonusVins,
                stripeSubscriptionId: session.subscription,
                stripeCustomerId: session.customer,
                skippedTrialBonus: bonusVins,
                updatedAt: now,
              })}::jsonb,
              ${JSON.stringify({
                maintenance: true,
                job_lookup: true,
                common_failures: true,
                oil_sticker: true,
                keytags: true,
                auto_booking: true,
                part_xref: true,
              })}::jsonb
            )
          `;
          console.log(`[Stripe] Created shop ${shopId} (${pending.shop_name}) from signup`);
          
          await sql`
            INSERT INTO users (shop_id, email, email_lower, role, password_hash, created_at, updated_at)
            VALUES (${shopId}, ${pending.admin_email}, ${pending.admin_email.toLowerCase()}, 'owner', ${pending.password_hash}, ${now}, ${now})
          `;
          console.log(`[Stripe] Created user ${pending.admin_email} for shop ${shopId}`);
          
          await sql`
            UPDATE pending_signups SET completed = true, completed_at = ${now}, shop_id = ${shopId}
            WHERE pending_id = ${pendingId}
          `;
          
          createHovercodeQR({ shopId, shopName: pending.shop_name }).then(async (result) => {
            if (result.success && result.hovercodeId) {
              await sql`
                UPDATE shops SET sticker_config = COALESCE(sticker_config, '{}'::jsonb) || ${JSON.stringify({
                  hovercodeQRId: result.hovercodeId,
                  hovercodeShortUrl: result.shortUrl,
                  hovercodeProvisionedAt: new Date(),
                })}::jsonb
                WHERE shop_id = ${shopId}
              `;
            }
          }).catch(() => {});
          
          const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://mos.tools";
          try {
            const welcomeMsg = makeWelcomeEmail(pending.shop_name, `${baseUrl}/login`);
            await sendEmail({ to: pending.admin_email, ...welcomeMsg });
          } catch (emailErr) {
            console.error("[Stripe] Failed to send welcome email:", emailErr);
          }
          
          break;
        }
        
        const shopId = session.metadata?.shopId;
        const plan = session.metadata?.plan || "pro";
        const skippedTrial = session.metadata?.skippedTrial === "true";
        
        if (shopId) {
          const updateData: Record<string, any> = {
            plan,
            status: "active",
            stripeSubscriptionId: session.subscription,
            stripeCustomerId: session.customer,
            updatedAt: new Date(),
            pendingCheckoutSessionId: null,
          };
          
          if (skippedTrial) {
            const settingsRows = await sql`SELECT * FROM platform_settings WHERE type = 'billing'`;
            const billingSettings = settingsRows[0]?.settings as any || {};
            let baseVins = billingSettings?.defaultVinLimit || 300;
            if (plan === "starter" && billingSettings?.starterIncludedVins) {
              baseVins = billingSettings.starterIncludedVins;
            } else if (plan === "plus" && billingSettings?.plusIncludedVins) {
              baseVins = billingSettings.plusIncludedVins;
            } else if (plan === "elite" && billingSettings?.eliteIncludedVins) {
              baseVins = billingSettings.eliteIncludedVins;
            }
            const bonus = billingSettings?.skipTrialBonusVins || 50;
            updateData.vinLimit = baseVins + bonus;
            updateData.skippedTrialBonus = bonus;
            console.log(`[Stripe] Shop ${shopId} skipped trial, setting VIN limit to ${baseVins + bonus} (tier: ${plan})`);
          }
          
          const enabledFeatures = {
            maintenance: true,
            job_lookup: true,
            common_failures: true,
            oil_sticker: true,
            keytags: true,
            auto_booking: true,
            part_xref: true,
          };
          console.log(`[Stripe] Shop ${shopId} - enabling all features for paid plan`);
          
          await sql`
            UPDATE shops SET billing = COALESCE(billing, '{}'::jsonb) || ${JSON.stringify(updateData)}::jsonb,
            enabled_features = COALESCE(enabled_features, '{}'::jsonb) || ${JSON.stringify(enabledFeatures)}::jsonb
            WHERE shop_id = ${shopId}
          `;
          console.log(`[Stripe] Shop ${shopId} upgraded to ${plan}${skippedTrial ? " (skip trial bonus applied)" : ""}`);
        }
        break;
      }

      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription;
        const shopId = subscription.metadata?.shopId;
        
        if (shopId) {
          const status = subscription.status === "active" ? "active" : subscription.status;
          const currentPeriodEnd = (subscription as any).current_period_end 
            ? new Date((subscription as any).current_period_end * 1000)
            : null;
          
          await sql`
            UPDATE shops SET billing = COALESCE(billing, '{}'::jsonb) || ${JSON.stringify({
              status,
              nextBillingDate: currentPeriodEnd,
              updatedAt: new Date(),
            })}::jsonb
            WHERE shop_id = ${shopId}
          `;
          console.log(`[Stripe] Shop ${shopId} subscription updated: ${status}`);
        }
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        const shopId = subscription.metadata?.shopId;
        
        if (shopId) {
          await sql`
            UPDATE shops SET billing = COALESCE(billing, '{}'::jsonb) || ${JSON.stringify({
              plan: "trial",
              status: "canceled",
              stripeSubscriptionId: null,
              updatedAt: new Date(),
            })}::jsonb
            WHERE shop_id = ${shopId}
          `;
          console.log(`[Stripe] Shop ${shopId} subscription canceled`);
        }
        break;
      }

      case "invoice.payment_succeeded": {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionId = (invoice as any).subscription as string;
        
        if (subscriptionId) {
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          const shopId = subscription.metadata?.shopId;
          const periodEnd = (subscription as any).current_period_end;
          
          if (shopId) {
            const shopRows = await sql`SELECT * FROM shops WHERE shop_id = ${shopId}`;
            const shop = shopRows[0] as any;
            const wasInGracePeriod = shop?.billing?.status === "past_due" || shop?.billing?.status === "suspended";
            
            const updateData: Record<string, any> = {
              status: "active",
              lastPaymentAt: new Date(),
              nextBillingDate: periodEnd ? new Date(periodEnd * 1000) : null,
              gracePeriodStartedAt: null,
              gracePeriodEndsAt: null,
              gracePeriodExtendedBy: null,
              gracePeriodExtendedAt: null,
            };
            
            let enabledFeatures = null;
            if (wasInGracePeriod && shop?.billing?.status === "suspended") {
              const plan = shop?.billing?.plan || "starter";
              enabledFeatures = {
                maintenance: true,
                job_lookup: plan !== "starter" && plan !== "trial",
                common_failures: plan !== "starter" && plan !== "trial",
                oil_sticker: plan !== "trial",
                keytags: plan === "elite" || plan === "enterprise",
                auto_booking: plan === "elite" || plan === "enterprise",
                part_xref: plan === "elite" || plan === "enterprise",
              };
              
              console.log(`[Stripe] Shop ${shopId} payment recovered from suspended - re-enabling features for ${plan} plan`);
              
              const ownerRows = await sql`SELECT * FROM users WHERE shop_id = ${shopId} AND role = 'owner'`;
              const owner = ownerRows[0] as any;
              if (owner?.email && shop) {
                const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://mos.tools";
                const loginUrl = `${baseUrl}/dashboard`;
                const emailContent = makePaymentRecoveredEmail(shop.name || `Shop ${shopId}`, loginUrl);
                sendEmail({ to: owner.email, ...emailContent }).catch(err => {
                  console.error(`[Stripe] Failed to send payment recovered email to ${owner.email}:`, err);
                });
              }
            } else if (wasInGracePeriod) {
              console.log(`[Stripe] Shop ${shopId} payment recovered from past_due - clearing grace period`);
            }
            
            if (enabledFeatures) {
              await sql`
                UPDATE shops SET billing = COALESCE(billing, '{}'::jsonb) || ${JSON.stringify(updateData)}::jsonb,
                enabled_features = ${JSON.stringify(enabledFeatures)}::jsonb
                WHERE shop_id = ${shopId}
              `;
            } else {
              await sql`
                UPDATE shops SET billing = COALESCE(billing, '{}'::jsonb) || ${JSON.stringify(updateData)}::jsonb
                WHERE shop_id = ${shopId}
              `;
            }
          }
        }
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionId = (invoice as any).subscription as string;
        
        if (subscriptionId) {
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          const shopId = subscription.metadata?.shopId;
          
          if (shopId) {
            const shopRows = await sql`SELECT * FROM shops WHERE shop_id = ${shopId}`;
            const shop = shopRows[0] as any;
            const now = new Date();
            const gracePeriodDays = 7;
            const gracePeriodEndsAt = new Date(now.getTime() + gracePeriodDays * 24 * 60 * 60 * 1000);
            
            const updateData: Record<string, any> = {
              status: "past_due",
              updatedAt: now,
            };
            
            if (!shop?.billing?.gracePeriodStartedAt) {
              updateData.gracePeriodStartedAt = now;
              updateData.gracePeriodEndsAt = gracePeriodEndsAt;
              console.log(`[Stripe] Shop ${shopId} payment failed - starting 7-day grace period (ends ${gracePeriodEndsAt.toISOString()})`);
              
              const ownerRows = await sql`SELECT * FROM users WHERE shop_id = ${shopId} AND role = 'owner'`;
              const owner = ownerRows[0] as any;
              if (owner?.email && shop) {
                const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://mos.tools";
                const updatePaymentUrl = `${baseUrl}/dashboard/settings/billing`;
                const emailContent = makePaymentFailedEmail(shop.name || `Shop ${shopId}`, updatePaymentUrl, gracePeriodEndsAt);
                sendEmail({ to: owner.email, ...emailContent }).catch(err => {
                  console.error(`[Stripe] Failed to send payment failed email to ${owner.email}:`, err);
                });
              }
            } else {
              console.log(`[Stripe] Shop ${shopId} payment failed again - grace period already active`);
            }
            
            await sql`
              UPDATE shops SET billing = COALESCE(billing, '{}'::jsonb) || ${JSON.stringify(updateData)}::jsonb
              WHERE shop_id = ${shopId}
            `;
          }
        }
        break;
      }
    }

    await logWebhookEvent(event, "processed");
    return NextResponse.json({ received: true });
  } catch (error: any) {
    console.error("Webhook processing error:", error);
    await logWebhookEvent(event, "failed", error.message);
    return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 });
  }
}
