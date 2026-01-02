import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { getDb } from "@/lib/mongo";
import Stripe from "stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const shopId = Number(session.metadata?.shopId);
        const plan = session.metadata?.plan || "pro";
        const skippedTrial = session.metadata?.skippedTrial === "true";
        const bonusVins = Number(session.metadata?.bonusVins) || 0;
        
        if (shopId) {
          const updateData: Record<string, any> = {
            "billing.plan": plan,
            "billing.status": "active",
            "billing.stripeSubscriptionId": session.subscription,
            "billing.stripeCustomerId": session.customer,
            "billing.updatedAt": new Date(),
            "billing.pendingCheckoutSessionId": null,
          };
          
          // If they skipped trial and got bonus VINs, ensure their VIN limit is set correctly
          if (skippedTrial) {
            // Get the billing settings to calculate total VINs
            const billingSettings = await db.collection("platform_settings").findOne({ type: "billing" });
            const baseVins = billingSettings?.mosProIncludedVins || 300;
            const bonus = billingSettings?.skipTrialBonusVins || 50;
            updateData["billing.vinLimit"] = baseVins + bonus;
            updateData["billing.skippedTrialBonus"] = bonus;
            console.log(`[Stripe] Shop ${shopId} skipped trial, setting VIN limit to ${baseVins + bonus}`);
          }
          
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

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error("Webhook processing error:", error);
    return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 });
  }
}
