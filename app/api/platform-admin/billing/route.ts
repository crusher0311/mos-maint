import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { getStripe, getBillingSettings } from "@/lib/stripe";
import type Stripe from "stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.isPlatformAdmin) {
    return NextResponse.json({ error: "Forbidden - platform admin access required" }, { status: 403 });
  }

  try {
    const db = await getDb();
    
    const [shops, recentPayments, enterprises, billingSettings] = await Promise.all([
      db.collection("shops").find().project({
        shopId: 1,
        name: 1,
        locationIdentifier: 1,
        enterpriseId: 1,
        billing: 1,
        stripeCustomerId: 1,
        stripeSubscriptionId: 1,
        stripeSubscriptionAmount: 1,
        createdAt: 1,
      }).toArray(),
      db.collection("stripe_events").find({ type: { $regex: /^invoice\.|^checkout\.session\.completed/ } })
        .sort({ createdAt: -1 })
        .limit(20)
        .toArray(),
      db.collection("enterprise_accounts").find().project({ _id: 1, name: 1, shopIds: 1 }).toArray(),
      db.collection("platform_settings").findOne({ type: "billing" }),
    ]);

    const enterpriseMap = new Map(enterprises.map(e => [e._id.toString(), e.name]));
    
    const configuredPricing: Record<string, number> = {
      starter: billingSettings?.starterPrice ?? 49,
      professional: billingSettings?.mosProPrice ?? 99,
      enterprise: billingSettings?.enterprisePrice ?? 199,
      detect_dog_founder: billingSettings?.detectDogFounderPrice ?? 229.95,
    };

    const planCounts: Record<string, number> = {
      trial: 0,
      starter: 0,
      professional: 0,
      enterprise: 0,
      detect_dog_founder: 0,
      oil_sticker_legacy: 0,
      demo: 0,
      churned: 0,
    };

    const statusCounts: Record<string, number> = {
      trial: 0,
      active: 0,
      past_due: 0,
      canceled: 0,
      paused: 0,
    };

    let totalMRR = 0;
    let paidShopsCount = 0;

    const shopBillingData = shops.map(shop => {
      const billing = shop.billing || {};
      const plan = billing.plan || "trial";
      const status = billing.status || "trial";
      
      if (planCounts[plan] !== undefined) {
        planCounts[plan]++;
      }
      
      if (statusCounts[status] !== undefined) {
        statusCounts[status]++;
      }
      
      const subscriptionAmount = shop.stripeSubscriptionAmount 
        ? shop.stripeSubscriptionAmount / 100 
        : configuredPricing[plan] || 0;
      
      if (billing.isPaid && (status === "active" || status === "past_due")) {
        totalMRR += subscriptionAmount;
        paidShopsCount++;
      }

      return {
        shopId: shop.shopId,
        name: shop.name || `Shop ${shop.shopId}`,
        locationIdentifier: shop.locationIdentifier,
        enterpriseName: shop.enterpriseId ? enterpriseMap.get(shop.enterpriseId.toString()) : null,
        plan,
        status,
        isPaid: billing.isPaid || false,
        vinViewCount: billing.vinViewCount || 0,
        vinLimit: billing.vinLimit || 10,
        stripeCustomerId: shop.stripeCustomerId,
        stripeSubscriptionId: shop.stripeSubscriptionId,
        stripeSubscriptionAmount: shop.stripeSubscriptionAmount || billing.stripeSubscriptionAmount || null,
        stripeProductName: billing.stripeProductName || null,
        createdAt: shop.createdAt,
      };
    });

    shopBillingData.sort((a, b) => {
      const order = ["enterprise", "professional", "detect_dog_founder", "starter", "oil_sticker_legacy", "demo", "trial", "churned"];
      return order.indexOf(a.plan) - order.indexOf(b.plan);
    });

    const recentEvents = recentPayments.map(event => ({
      id: event._id.toString(),
      type: event.type,
      shopId: event.shopId,
      shopName: event.shopName,
      amount: event.amount,
      currency: event.currency,
      status: event.status,
      createdAt: event.createdAt,
    }));

    return NextResponse.json({
      ok: true,
      summary: {
        totalShops: shops.length,
        paidShops: paidShopsCount,
        totalMRR,
        planCounts,
        statusCounts,
      },
      shops: shopBillingData,
      recentEvents,
    });
  } catch (err: any) {
    console.error("Platform billing error:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}

const VALID_PLANS = ["trial", "starter", "professional", "enterprise", "detect_dog_founder", "demo", "churned", "oil_sticker_legacy"];
const VALID_STATUSES = ["trial", "active", "past_due", "canceled", "paused"];

export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.isPlatformAdmin) {
    return NextResponse.json({ error: "Forbidden - platform admin access required" }, { status: 403 });
  }

  try {
    const { shopId, stripeCustomerId, stripeSubscriptionId, plan, status } = await req.json();

    if (!shopId) {
      return NextResponse.json({ error: "shopId is required" }, { status: 400 });
    }

    if (!stripeCustomerId) {
      return NextResponse.json({ error: "Stripe Customer ID is required" }, { status: 400 });
    }

    if (!stripeCustomerId.startsWith("cus_")) {
      return NextResponse.json({ error: "Stripe Customer ID must start with 'cus_'" }, { status: 400 });
    }

    if (stripeSubscriptionId && !stripeSubscriptionId.startsWith("sub_")) {
      return NextResponse.json({ error: "Stripe Subscription ID must start with 'sub_'" }, { status: 400 });
    }

    if (plan && !VALID_PLANS.includes(plan)) {
      return NextResponse.json({ error: `Invalid plan. Must be one of: ${VALID_PLANS.join(", ")}` }, { status: 400 });
    }

    if (status && !VALID_STATUSES.includes(status)) {
      return NextResponse.json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}` }, { status: 400 });
    }

    const db = await getDb();
    const shop = await db.collection("shops").findOne({ shopId: Number(shopId) });
    if (!shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    }

    const updateFields: Record<string, any> = {
      stripeCustomerId,
      "billing.stripeCustomerId": stripeCustomerId,
      updatedAt: new Date(),
    };

    let stripeSubData: any = null;

    if (stripeSubscriptionId) {
      updateFields.stripeSubscriptionId = stripeSubscriptionId;
      updateFields["billing.stripeSubscriptionId"] = stripeSubscriptionId;

      try {
        const stripeClient = getStripe();
        let actualSubId = stripeSubscriptionId;

        if (stripeSubscriptionId.startsWith("sub_sched_")) {
          const schedule = await stripeClient.subscriptionSchedules.retrieve(stripeSubscriptionId);
          if (schedule.subscription) {
            actualSubId = typeof schedule.subscription === "string" 
              ? schedule.subscription 
              : schedule.subscription.id;
            updateFields["billing.stripeSubscriptionScheduleId"] = stripeSubscriptionId;
            updateFields.stripeSubscriptionId = actualSubId;
            updateFields["billing.stripeSubscriptionId"] = actualSubId;
          } else {
            const phases = schedule.phases || [];
            const latestPhase = phases[phases.length - 1];
            if (latestPhase?.items?.length) {
              const phaseItem = latestPhase.items[0] as any;
              const priceId = typeof phaseItem.price === "string" ? phaseItem.price : phaseItem.price?.id;
              if (priceId) {
                try {
                  const price = await stripeClient.prices.retrieve(priceId, { expand: ["product"] });
                  const amount = price.unit_amount || 0;
                  updateFields.stripeSubscriptionAmount = amount;
                  updateFields["billing.stripeSubscriptionAmount"] = amount;
                  updateFields["billing.stripeSubscriptionScheduleId"] = stripeSubscriptionId;

                  stripeSubData = {
                    status: schedule.status,
                    amount,
                    currency: price.currency,
                    interval: price.recurring?.interval || null,
                    intervalCount: price.recurring?.interval_count || null,
                    priceId: price.id,
                    scheduledStart: latestPhase.start_date ? new Date((latestPhase.start_date as number) * 1000) : null,
                  };

                  const product: Stripe.Product | Stripe.DeletedProduct | string = price.product;
                  if (typeof product === "string") {
                    stripeSubData.productId = product;
                  } else {
                    stripeSubData.productId = product.id;
                    if (!product.deleted) {
                      stripeSubData.productName = product.name;
                      updateFields["billing.stripeProductName"] = product.name;
                    }
                  }

                  updateFields["billing.isPaid"] = true;
                  if (!status) {
                    updateFields["billing.status"] = "active";
                  }
                } catch (priceErr: any) {
                  stripeSubData = { error: `Schedule found but could not fetch price: ${priceErr?.message}` };
                }
              } else {
                stripeSubData = { error: "Subscription schedule has no price in its phases" };
              }
            } else {
              stripeSubData = { error: "Subscription schedule has no phases configured" };
            }
          }
        }

        if (!stripeSubData) {
          const subscription = await stripeClient.subscriptions.retrieve(actualSubId, {
            expand: ["items.data.price.product"],
          });

          stripeSubData = {
            status: subscription.status,
            currentPeriodStart: subscription.current_period_start ? new Date(subscription.current_period_start * 1000) : null,
            currentPeriodEnd: subscription.current_period_end ? new Date(subscription.current_period_end * 1000) : null,
            cancelAtPeriodEnd: subscription.cancel_at_period_end,
          };

          const firstItem = subscription.items?.data?.[0];
          if (firstItem?.price) {
            const amount = firstItem.price.unit_amount || 0;
            updateFields.stripeSubscriptionAmount = amount;
            updateFields["billing.stripeSubscriptionAmount"] = amount;
            stripeSubData.amount = amount;
            stripeSubData.currency = firstItem.price.currency;
            stripeSubData.interval = firstItem.price.recurring?.interval || null;
            stripeSubData.intervalCount = firstItem.price.recurring?.interval_count || null;
            stripeSubData.priceId = firstItem.price.id;

            const product: Stripe.Product | Stripe.DeletedProduct | string = firstItem.price.product;
            if (typeof product === "string") {
              stripeSubData.productId = product;
            } else {
              stripeSubData.productId = product.id;
              if (!product.deleted) {
                stripeSubData.productName = product.name;
                updateFields["billing.stripeProductName"] = product.name;
              }
            }
          }

          if (subscription.status === "active" || subscription.status === "trialing") {
            updateFields["billing.isPaid"] = true;
          }

          const stripeStatusMap: Record<string, string> = {
            active: "active",
            past_due: "past_due",
            canceled: "canceled",
            unpaid: "past_due",
            paused: "paused",
            trialing: "trial",
          };
          if (!status && stripeStatusMap[subscription.status]) {
            updateFields["billing.status"] = stripeStatusMap[subscription.status];
          }
        }
      } catch (stripeErr: any) {
        console.error("Failed to fetch Stripe subscription:", stripeErr?.message);
        stripeSubData = { error: stripeErr?.message || "Failed to fetch subscription" };
      }
    }

    const hasSubscriptionData = stripeSubData && !stripeSubData.error && stripeSubData.amount > 0;

    if (hasSubscriptionData) {
      const productName = stripeSubData.productName || "";
      const productId = stripeSubData.productId || "";
      const isBrandPro = /brandpro/i.test(productName);
      const billingSettingsForMatch = await getBillingSettings();
      const isDetectDogFounder = !!productId && productId === billingSettingsForMatch.detectDogFounderProductId;
      const currentPlan = plan || shop.billing?.plan || "trial";

      if (isDetectDogFounder) {
        updateFields["billing.plan"] = "detect_dog_founder";
        updateFields["billing.isPaid"] = true;
        console.log(`[Billing PATCH] Detect Dog - Founder product detected — setting plan to detect_dog_founder (was: ${currentPlan}, product: ${productName}, id: ${productId})`);
      } else if (isBrandPro) {
        updateFields["billing.plan"] = "oil_sticker_legacy";
        updateFields["billing.isPaid"] = true;
        updateFields["enabledFeatures.maintenance"] = false;
        updateFields["enabledFeatures.job_lookup"] = false;
        updateFields["enabledFeatures.common_failures"] = false;
        updateFields["enabledFeatures.oil_sticker"] = true;
        updateFields["enabledFeatures.keytags"] = false;
        updateFields["enabledFeatures.auto_booking"] = true;
        updateFields["enabledFeatures.part_xref"] = false;
        updateFields["enabledFeatures.labor_rates"] = true;
        console.log(`[Billing PATCH] BrandPro product detected — setting plan to oil_sticker_legacy with features (was: ${currentPlan}, product: ${productName})`);
      } else if (currentPlan === "trial" || currentPlan === "demo") {
        updateFields["billing.plan"] = "starter";
        updateFields["billing.isPaid"] = true;
        console.log(`[Billing PATCH] Auto-setting plan from ${currentPlan} to starter (product: ${productName})`);
      } else if (plan) {
        updateFields["billing.plan"] = plan;
        updateFields["billing.isPaid"] = !["trial", "demo", "churned"].includes(plan);
      }
      if (!updateFields["billing.status"] || updateFields["billing.status"] === "trial") {
        updateFields["billing.status"] = "active";
      }
    } else {
      if (plan) {
        updateFields["billing.plan"] = plan;
        if (plan === "trial" || plan === "demo" || plan === "churned") {
          updateFields["billing.isPaid"] = false;
        } else {
          updateFields["billing.isPaid"] = true;
        }
      }
      if (status) {
        updateFields["billing.status"] = status;
      }
    }

    console.log(`[Billing PATCH] Shop ${shopId} updateFields:`, JSON.stringify(updateFields, null, 2));

    await db.collection("shops").updateOne(
      { shopId: Number(shopId) },
      { $set: updateFields }
    );

    await db.collection("audit_logs").insertOne({
      type: "stripe_linked",
      shopId: Number(shopId),
      shopName: shop.name,
      stripeCustomerId,
      stripeSubscriptionId: stripeSubscriptionId || null,
      stripeSubData,
      plan: plan || null,
      status: status || null,
      performedBy: session.email,
      createdAt: new Date(),
    });

    return NextResponse.json({ ok: true, stripeSubData });
  } catch (err: any) {
    console.error("Link stripe error:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}
