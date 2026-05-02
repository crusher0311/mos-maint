import { NextRequest, NextResponse } from "next/server";
import { stripe, getBillingSettings } from "@/lib/stripe";
import { getDb } from "@/lib/mongo";
import { sendEmail, makeWelcomeEmail, makeCredentialsWelcomeEmail, makePaymentFailedEmail, makePaymentRecoveredEmail } from "@/lib/email";
import { createHovercodeQR } from "@/lib/hovercode";
import { getNextShopId } from "@/lib/ids";
import Stripe from "stripe";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function resolveShopId(
  db: any,
  metadata: Record<string, string> | null | undefined,
  customerId?: string | null
): Promise<{ shopId: number; shop: any } | null> {
  const metaShopId = Number(metadata?.shopId);
  if (metaShopId) {
    const shop = await db.collection("shops").findOne({ shopId: metaShopId });
    if (shop) return { shopId: metaShopId, shop };
  }

  if (customerId) {
    const shop = await db.collection("shops").findOne({
      $or: [
        { "billing.stripeCustomerId": customerId },
        { stripeCustomerId: customerId },
      ],
    });
    if (shop) {
      console.log(`[Stripe] Resolved shop ${shop.shopId} via stripeCustomerId ${customerId}`);
      return { shopId: shop.shopId, shop };
    }
  }

  return null;
}

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

        if (session.mode === "setup") {
          const setupShopId = Number(session.metadata?.shopId);
          const purpose = session.metadata?.purpose;
          if (setupShopId && (purpose === "trial_card_capture" || !purpose)) {
            try {
              const setupIntentRef = session.setup_intent;
              const setupIntentId: string | null =
                typeof setupIntentRef === "string"
                  ? setupIntentRef
                  : setupIntentRef?.id ?? null;
              let paymentMethodId: string | null = null;
              const customerRef = session.customer;
              let customerId: string | null =
                typeof customerRef === "string"
                  ? customerRef
                  : customerRef?.id ?? null;

              if (setupIntentId) {
                const setupIntent = await stripe.setupIntents.retrieve(setupIntentId);
                const pmRef = setupIntent.payment_method;
                paymentMethodId =
                  typeof pmRef === "string" ? pmRef : pmRef?.id ?? null;
                if (!customerId && setupIntent.customer) {
                  const siCustomerRef = setupIntent.customer;
                  customerId =
                    typeof siCustomerRef === "string"
                      ? siCustomerRef
                      : siCustomerRef.id;
                }
              }

              if (paymentMethodId && customerId) {
                try {
                  await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });
                } catch (attachErr: any) {
                  if (attachErr?.code !== "resource_already_exists") {
                    console.warn(`[Stripe setup] attach failed for ${paymentMethodId}:`, attachErr?.message);
                  }
                }
                try {
                  await stripe.customers.update(customerId, {
                    invoice_settings: { default_payment_method: paymentMethodId },
                  });
                } catch (updErr: any) {
                  console.warn(`[Stripe setup] customer default update failed:`, updErr?.message);
                }
              }

              const now = new Date();
              await db.collection("shops").updateOne(
                { shopId: setupShopId },
                {
                  $set: {
                    cardOnFile: true,
                    "billing.cardOnFile": true,
                    ...(customerId ? { stripeCustomerId: customerId, "billing.stripeCustomerId": customerId } : {}),
                    ...(paymentMethodId ? { stripePaymentMethodId: paymentMethodId, "billing.stripePaymentMethodId": paymentMethodId } : {}),
                    cardCapturedAt: now,
                    cardCaptureSessionId: session.id,
                    "trial.cardOnFile": true,
                    updatedAt: now,
                  },
                }
              );

              await db.collection("audit_logs").insertOne({
                type: "shop_card_captured",
                shopId: setupShopId,
                stripeCustomerId: customerId,
                stripePaymentMethodId: paymentMethodId,
                checkoutSessionId: session.id,
                createdAt: now,
              });

              console.log(`[Stripe setup] Card captured for shop ${setupShopId} (pm=${paymentMethodId})`);
            } catch (setupErr: any) {
              console.error(`[Stripe setup] Failed to process setup-mode session:`, setupErr?.message);
            }
            break;
          }
        }

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
        } else if (session.customer_details?.email) {
          const crmEmail = session.customer_details.email.toLowerCase().trim();
          const crmName = session.customer_details.name || "";

          const CRM_PRODUCT_IDS = ["prod_U6CHMNValFQdpp"];
          let isCrmProduct = false;
          if (session.line_items?.data) {
            isCrmProduct = session.line_items.data.some((item: any) =>
              CRM_PRODUCT_IDS.includes(item.price?.product as string)
            );
          }
          if (!isCrmProduct && (session as any).id) {
            try {
              const fullSession = await stripe.checkout.sessions.retrieve((session as any).id, {
                expand: ["line_items.data.price.product"],
              });
              isCrmProduct = fullSession.line_items?.data?.some((item: any) => {
                const productId = typeof item.price?.product === "string"
                  ? item.price.product
                  : item.price?.product?.id;
                return CRM_PRODUCT_IDS.includes(productId);
              }) || false;
            } catch (err) {
              console.error("[Stripe CRM] Failed to retrieve session line items:", err);
            }
          }

          const isCrmSignup = isCrmProduct || session.metadata?.source === "crm" || session.metadata?.crmSignup === "true";

          const existingUser = await db.collection("users").findOne({ emailLower: crmEmail });
          const existingShopByCustomer = session.customer
            ? await db.collection("shops").findOne({
                $or: [
                  { "billing.stripeCustomerId": session.customer },
                  { stripeCustomerId: session.customer },
                ],
              })
            : null;

          if (!existingUser && !existingShopByCustomer && isCrmSignup) {
            const alreadyProvisioned = await db.collection("crm_provisions").findOne({
              stripeSessionId: (session as any).id,
            });
            if (alreadyProvisioned) {
              console.log(`[Stripe CRM] Session ${(session as any).id} already provisioned, skipping`);
              break;
            }

            console.log(`[Stripe CRM] Auto-provisioning account for ${crmEmail}`);

            const allowedCrmPlans = ["professional", "starter", "enterprise"];
            const rawPlan = session.metadata?.plan || "professional";
            const validatedPlan = allowedCrmPlans.includes(rawPlan) ? rawPlan : "professional";

            const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
            let tempPassword = "";
            const bytes = crypto.randomBytes(12);
            for (let i = 0; i < 12; i++) {
              tempPassword += chars[bytes[i] % chars.length];
            }

            const passwordHash = await bcrypt.hash(tempPassword, 12);
            const newShopId = await getNextShopId();
            const now = new Date();
            const webhookToken = crypto.randomBytes(12).toString("hex");
            const rawShopName = session.metadata?.shopName || crmName || "New Shop";
            const shopNameFromMeta = rawShopName.slice(0, 200).trim();

            const shopDoc = {
              shopId: newShopId,
              name: shopNameFromMeta,
              webhookToken,
              createdAt: now,
              updatedAt: now,
              provisionedVia: "crm_stripe",
              billing: {
                plan: validatedPlan,
                status: "active",
                isPaid: true,
                vinLimit: 300,
                stripeCustomerId: session.customer,
                stripeSubscriptionId: session.subscription,
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

            const userDoc = {
              shopId: newShopId,
              email: crmEmail,
              emailLower: crmEmail,
              name: crmName || null,
              role: "owner",
              passwordHash,
              mustChangePassword: true,
              createdAt: now,
              updatedAt: now,
            };

            await db.collection("shops").insertOne(shopDoc);
            await db.collection("users").insertOne(userDoc);
            await db.collection("crm_provisions").insertOne({
              stripeSessionId: (session as any).id,
              stripeCustomerId: session.customer,
              email: crmEmail,
              shopId: newShopId,
              createdAt: now,
            });
            console.log(`[Stripe CRM] Created shop ${newShopId} (${shopNameFromMeta}) for ${crmEmail}`);

            createHovercodeQR({ shopId: newShopId, shopName: shopNameFromMeta }).then(async (result) => {
              if (result.success && result.hovercodeId) {
                await db.collection("shops").updateOne(
                  { shopId: newShopId },
                  {
                    $set: {
                      "stickerConfig.hovercodeQRId": result.hovercodeId,
                      "stickerConfig.hovercodeShortUrl": result.shortUrl,
                      "stickerConfig.hovercodeProvisionedAt": new Date(),
                    },
                  }
                );
              }
            }).catch(() => {});

            const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://mos.tools";
            try {
              const emailContent = makeCredentialsWelcomeEmail(shopNameFromMeta, crmEmail, tempPassword, `${baseUrl}/login`);
              await sendEmail({ to: crmEmail, ...emailContent });
              console.log(`[Stripe CRM] Welcome email with credentials sent to ${crmEmail}`);
            } catch (emailErr) {
              console.error("[Stripe CRM] Failed to send welcome email:", emailErr);
            }
          }
        }
        break;
      }

      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;
        const resolved = await resolveShopId(db, subscription.metadata, customerId);
        
        if (resolved) {
          const { shopId } = resolved;
          const status = subscription.status === "active" ? "active" : subscription.status;
          const currentPeriodEnd = (subscription as any).current_period_end 
            ? new Date((subscription as any).current_period_end * 1000)
            : null;
          
          const updateData: Record<string, any> = {
            "billing.status": status,
            "billing.nextBillingDate": currentPeriodEnd,
            "billing.stripeSubscriptionId": subscription.id,
            "billing.updatedAt": new Date(),
          };

          if (status === "active") {
            updateData["billing.isPaid"] = true;
          } else if (status === "canceled" || status === "unpaid") {
            updateData["billing.isPaid"] = false;
          }

          const fullSub = await stripe.subscriptions.retrieve(subscription.id, {
            expand: ["items.data.price.product"],
          });
          const firstItem = fullSub.items?.data?.[0];
          if (firstItem?.price) {
            const amount = firstItem.price.unit_amount || 0;
            updateData["billing.stripeSubscriptionAmount"] = amount;
            updateData.stripeSubscriptionAmount = amount;

            const product = firstItem.price.product;
            if (product && typeof product === "object" && "name" in product) {
              updateData["billing.stripeProductName"] = (product as any).name;
            }
          }
          
          await db.collection("shops").updateOne(
            { shopId },
            { $set: updateData }
          );
          console.log(`[Stripe] Shop ${shopId} subscription updated: ${status}`);
        }
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;
        const resolved = await resolveShopId(db, subscription.metadata, customerId);
        
        if (resolved) {
          await db.collection("shops").updateOne(
            { shopId: resolved.shopId },
            {
              $set: {
                "billing.plan": "churned",
                "billing.status": "canceled",
                "billing.isPaid": false,
                "billing.stripeSubscriptionId": null,
                "billing.updatedAt": new Date(),
              },
            }
          );
          console.log(`[Stripe] Shop ${resolved.shopId} subscription canceled`);
        }
        break;
      }

      case "invoice.payment_succeeded": {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionId = (invoice as any).subscription as string;
        
        if (subscriptionId) {
          const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
            expand: ["items.data.price.product"],
          });
          const customerId = typeof subscription.customer === "string" ? subscription.customer : (subscription.customer as any)?.id;
          const resolved = await resolveShopId(db, subscription.metadata, customerId);
          const periodEnd = (subscription as any).current_period_end;
          
          if (resolved) {
            const { shopId, shop } = resolved;
            const wasInGracePeriod = shop?.billing?.status === "past_due" || shop?.billing?.status === "suspended";
            
            const updateData: Record<string, any> = {
              "billing.status": "active",
              "billing.isPaid": true,
              "billing.lastPaymentAt": new Date(),
              "billing.nextBillingDate": periodEnd ? new Date(periodEnd * 1000) : null,
              "billing.stripeSubscriptionId": subscription.id,
              "billing.gracePeriodStartedAt": null,
              "billing.gracePeriodEndsAt": null,
              "billing.gracePeriodExtendedBy": null,
              "billing.gracePeriodExtendedAt": null,
            };

            const firstItem = subscription.items?.data?.[0];
            if (firstItem?.price) {
              const amount = firstItem.price.unit_amount || 0;
              updateData["billing.stripeSubscriptionAmount"] = amount;
              updateData.stripeSubscriptionAmount = amount;

              const product = firstItem.price.product;
              if (product && typeof product === "object" && "name" in product) {
                updateData["billing.stripeProductName"] = (product as any).name;
              }
            }
            
            if (wasInGracePeriod && shop?.billing?.status === "suspended") {
              const plan = shop?.billing?.plan || "starter";
              const isLegacy = plan === "oil_sticker_legacy";
              const planFeatures: Record<string, boolean> = {
                maintenance: !isLegacy,
                job_lookup: !isLegacy && plan !== "starter" && plan !== "trial",
                common_failures: !isLegacy && plan !== "starter" && plan !== "trial",
                oil_sticker: plan !== "trial",
                keytags: !isLegacy && (plan === "elite" || plan === "enterprise"),
                auto_booking: isLegacy || plan === "elite" || plan === "enterprise",
                part_xref: !isLegacy && (plan === "elite" || plan === "enterprise"),
                labor_rates: isLegacy,
              };
              
              updateData["enabledFeatures.maintenance"] = planFeatures.maintenance;
              updateData["enabledFeatures.job_lookup"] = planFeatures.job_lookup;
              updateData["enabledFeatures.common_failures"] = planFeatures.common_failures;
              updateData["enabledFeatures.oil_sticker"] = planFeatures.oil_sticker;
              updateData["enabledFeatures.keytags"] = planFeatures.keytags;
              updateData["enabledFeatures.auto_booking"] = planFeatures.auto_booking;
              updateData["enabledFeatures.part_xref"] = planFeatures.part_xref;
              updateData["enabledFeatures.labor_rates"] = planFeatures.labor_rates;
              
              console.log(`[Stripe] Shop ${shopId} payment recovered from suspended - re-enabling features for ${plan} plan`);
              
              const owner = await db.collection("users").findOne({ shopId, role: "owner" });
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
            
            await db.collection("shops").updateOne(
              { shopId },
              { $set: updateData }
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
          const failCustomerId = typeof subscription.customer === "string" ? subscription.customer : (subscription.customer as any)?.id;
          const failResolved = await resolveShopId(db, subscription.metadata, failCustomerId);
          
          if (failResolved) {
            const shopId = failResolved.shopId;
            const shop = failResolved.shop;
            const now = new Date();
            const gracePeriodDays = 7;
            const gracePeriodEndsAt = new Date(now.getTime() + gracePeriodDays * 24 * 60 * 60 * 1000);
            
            const updateData: Record<string, any> = {
              "billing.status": "past_due",
              "billing.updatedAt": now,
            };
            
            if (!shop?.billing?.gracePeriodStartedAt) {
              updateData["billing.gracePeriodStartedAt"] = now;
              updateData["billing.gracePeriodEndsAt"] = gracePeriodEndsAt;
              console.log(`[Stripe] Shop ${shopId} payment failed - starting 7-day grace period (ends ${gracePeriodEndsAt.toISOString()})`);
              
              const owner = await db.collection("users").findOne({ shopId, role: "owner" });
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
            
            await db.collection("shops").updateOne(
              { shopId },
              { $set: updateData }
            );
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
