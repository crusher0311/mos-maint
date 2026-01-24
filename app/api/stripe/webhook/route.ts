import { NextRequest, NextResponse } from "next/server";
import { stripe, getBillingSettings } from "@/lib/stripe";
import { getDb } from "@/lib/mongo";
import { sendEmail, makeWelcomeEmail } from "@/lib/email";
import { createHovercodeQR } from "@/lib/hovercode";
import Stripe from "stripe";
import crypto from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function logWebhookEvent(
  db: any,
  event: Stripe.Event,
  status: "received" | "processed" | "failed",
  error?: string
) {
  try {
    await db.collection("stripe_webhook_events").updateOne(
      { eventId: event.id },
      {
        $set: {
          eventId: event.id,
          type: event.type,
          status,
          error: error || null,
          processedAt: status !== "received" ? new Date() : null,
          updatedAt: new Date()
        },
        $setOnInsert: {
          createdAt: new Date(),
          payload: event.data.object,
          retryCount: 0
        },
        $inc: status === "failed" ? { retryCount: 1 } : {}
      },
      { upsert: true }
    );
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

  const db = await getDb();
  
  const existingEvent = await db.collection("stripe_webhook_events").findOne({
    eventId: event.id,
    status: "processed"
  });
  
  if (existingEvent) {
    console.log(`[Stripe Webhook] Event ${event.id} already processed, skipping`);
    return NextResponse.json({ received: true, duplicate: true });
  }
  
  await logWebhookEvent(db, event, "received");

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const isSignupFlow = session.metadata?.signupFlow === "true";
        const pendingId = session.metadata?.pendingId;
        
        if (isSignupFlow && pendingId) {
          const pending = await db.collection("pending_signups").findOne({ pendingId });
          
          if (!pending) {
            console.error(`[Stripe] Pending signup not found: ${pendingId}`);
            break;
          }
          
          if (pending.completed) {
            console.log(`[Stripe] Pending signup ${pendingId} already completed`);
            break;
          }
          
          const shopId = pending.reservedShopId;
          const now = new Date();
          const billingSettings = await getBillingSettings();
          const baseVins = billingSettings.mosProIncludedVins || 300;
          const bonusVins = billingSettings.skipTrialBonusVins || 50;
          const webhookToken = crypto.randomBytes(12).toString("hex");
          
          const shopDoc = {
            shopId,
            name: pending.shopName,
            webhookToken,
            createdAt: now,
            updatedAt: now,
            billing: {
              plan: "pro",
              status: "active",
              vinLimit: baseVins + bonusVins,
              stripeSubscriptionId: session.subscription,
              stripeCustomerId: session.customer,
              skippedTrialBonus: bonusVins,
              updatedAt: now,
            },
            enabledFeatures: {
              maintenance: true,
              job_lookup: true,
              common_failures: true,
              oil_sticker: true,
              keytags: true,
              auto_booking: true,
              part_xref: true,
            },
          };
          
          await db.collection("shops").insertOne(shopDoc);
          console.log(`[Stripe] Created shop ${shopId} (${pending.shopName}) from signup`);
          
          const userDoc = {
            shopId,
            email: pending.adminEmail,
            emailLower: pending.adminEmail,
            role: "owner",
            passwordHash: pending.passwordHash,
            createdAt: now,
            updatedAt: now,
          };
          
          await db.collection("users").insertOne(userDoc);
          console.log(`[Stripe] Created user ${pending.adminEmail} for shop ${shopId}`);
          
          await db.collection("pending_signups").updateOne(
            { pendingId },
            { $set: { completed: true, completedAt: now, shopId } }
          );
          
          createHovercodeQR({ shopId, shopName: pending.shopName }).then(async (result) => {
            if (result.success && result.hovercodeId) {
              await db.collection("shops").updateOne(
                { shopId },
                { 
                  $set: { 
                    "stickerConfig.hovercodeQRId": result.hovercodeId,
                    "stickerConfig.hovercodeShortUrl": result.shortUrl,
                    "stickerConfig.hovercodeProvisionedAt": new Date(),
                  } 
                }
              );
            }
          }).catch(() => {});
          
          const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://mos.tools";
          try {
            const welcomeMsg = makeWelcomeEmail(pending.shopName, `${baseUrl}/login`);
            await sendEmail({ to: pending.adminEmail, ...welcomeMsg });
          } catch (emailErr) {
            console.error("[Stripe] Failed to send welcome email:", emailErr);
          }
          
          break;
        }
        
        const shopId = Number(session.metadata?.shopId);
        const plan = session.metadata?.plan || "pro";
        const skippedTrial = session.metadata?.skippedTrial === "true";
        
        if (shopId) {
          const updateData: Record<string, any> = {
            "billing.plan": plan,
            "billing.status": "active",
            "billing.stripeSubscriptionId": session.subscription,
            "billing.stripeCustomerId": session.customer,
            "billing.updatedAt": new Date(),
            "billing.pendingCheckoutSessionId": null,
          };
          
          if (skippedTrial) {
            const billingSettings = await db.collection("platform_settings").findOne({ type: "billing" });
            let baseVins = billingSettings?.defaultVinLimit || 300;
            if (plan === "starter" && billingSettings?.starterIncludedVins) {
              baseVins = billingSettings.starterIncludedVins;
            } else if (plan === "plus" && billingSettings?.plusIncludedVins) {
              baseVins = billingSettings.plusIncludedVins;
            } else if (plan === "elite" && billingSettings?.eliteIncludedVins) {
              baseVins = billingSettings.eliteIncludedVins;
            }
            const bonus = billingSettings?.skipTrialBonusVins || 50;
            updateData["billing.vinLimit"] = baseVins + bonus;
            updateData["billing.skippedTrialBonus"] = bonus;
            console.log(`[Stripe] Shop ${shopId} skipped trial, setting VIN limit to ${baseVins + bonus} (tier: ${plan})`);
          }
          
          updateData["enabledFeatures.maintenance"] = true;
          updateData["enabledFeatures.job_lookup"] = true;
          updateData["enabledFeatures.common_failures"] = true;
          updateData["enabledFeatures.oil_sticker"] = true;
          updateData["enabledFeatures.keytags"] = true;
          updateData["enabledFeatures.auto_booking"] = true;
          updateData["enabledFeatures.part_xref"] = true;
          console.log(`[Stripe] Shop ${shopId} - enabling all features for paid plan`);
          
          await db.collection("shops").updateOne(
            { shopId },
            { $set: updateData }
          );
          console.log(`[Stripe] Shop ${shopId} upgraded to ${plan}${skippedTrial ? " (skip trial bonus applied)" : ""}`);
        }
        break;
      }

      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription;
        const shopId = Number(subscription.metadata?.shopId);
        
        if (shopId) {
          const status = subscription.status === "active" ? "active" : subscription.status;
          const currentPeriodEnd = (subscription as any).current_period_end 
            ? new Date((subscription as any).current_period_end * 1000)
            : null;
          
          await db.collection("shops").updateOne(
            { shopId },
            {
              $set: {
                "billing.status": status,
                "billing.nextBillingDate": currentPeriodEnd,
                "billing.updatedAt": new Date(),
              },
            }
          );
          console.log(`[Stripe] Shop ${shopId} subscription updated: ${status}`);
        }
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        const shopId = Number(subscription.metadata?.shopId);
        
        if (shopId) {
          await db.collection("shops").updateOne(
            { shopId },
            {
              $set: {
                "billing.plan": "trial",
                "billing.status": "canceled",
                "billing.stripeSubscriptionId": null,
                "billing.updatedAt": new Date(),
              },
            }
          );
          console.log(`[Stripe] Shop ${shopId} subscription canceled`);
        }
        break;
      }

      case "invoice.payment_succeeded": {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionId = (invoice as any).subscription as string;
        
        if (subscriptionId) {
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          const shopId = Number(subscription.metadata?.shopId);
          const periodEnd = (subscription as any).current_period_end;
          
          if (shopId) {
            await db.collection("shops").updateOne(
              { shopId },
              {
                $set: {
                  "billing.status": "active",
                  "billing.lastPaymentAt": new Date(),
                  "billing.nextBillingDate": periodEnd ? new Date(periodEnd * 1000) : null,
                },
              }
            );
          }
        }
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionId = (invoice as any).subscription as string;
        
        if (subscriptionId) {
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          const shopId = Number(subscription.metadata?.shopId);
          
          if (shopId) {
            await db.collection("shops").updateOne(
              { shopId },
              {
                $set: {
                  "billing.status": "past_due",
                  "billing.updatedAt": new Date(),
                },
              }
            );
            console.log(`[Stripe] Shop ${shopId} payment failed`);
          }
        }
        break;
      }
    }

    await logWebhookEvent(db, event, "processed");
    return NextResponse.json({ received: true });
  } catch (error: any) {
    console.error("Webhook processing error:", error);
    await logWebhookEvent(db, event, "failed", error.message);
    return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 });
  }
}
