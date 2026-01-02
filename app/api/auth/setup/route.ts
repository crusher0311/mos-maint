import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getNextShopId } from "@/lib/ids";
import { sendEmail, makeWelcomeEmail } from "@/lib/email";
import { getStripe, getBillingSettings, getBaseUrl } from "@/lib/stripe";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const shopName = String(body?.shopName || "").trim();
    const adminEmail = String(body?.adminEmail || "").trim().toLowerCase();
    const adminPassword = String(body?.adminPassword || "");
    const skipTrial = Boolean(body?.skipTrial);
    
    // Optional AutoFlow integration
    const autoflowDomain = String(body?.autoflowDomain || "").trim();
    const autoflowApiKey = String(body?.autoflowApiKey || "").trim();
    const autoflowApiPassword = String(body?.autoflowApiPassword || "").trim();

    // Optional AutoVitals integration
    const autovitalsWelcomeCode = String(body?.autovitalsWelcomeCode || "").trim();
    const autovitalsPersonalCode = String(body?.autovitalsPersonalCode || "").trim();

    // Optional Protractor integration
    const protractorApiKey = String(body?.protractorApiKey || "").trim();
    const protractorShopId = String(body?.protractorShopId || "").trim();

    // Optional Tekmetric integration
    const tekmetricShopId = String(body?.tekmetricShopId || "").trim();

    // Optional CARFAX integration
    const carfaxLocationId = String(body?.carfaxLocationId || "").trim();

    // Validate required fields
    if (!shopName || !adminEmail || !adminPassword) {
      return NextResponse.json({ error: "Missing required fields: shopName, adminEmail, adminPassword" }, { status: 400 });
    }
    
    if (adminPassword.length < 8) {
      return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
    }

    const db = await getDb();
    const shops = db.collection("shops");
    const users = db.collection("users");
    const sessions = db.collection("sessions");

    // Check if user already exists (global check)
    const existingUser = await users.findOne({ emailLower: adminEmail });
    if (existingUser) {
      return NextResponse.json({ error: "User already exists with this email" }, { status: 409 });
    }

    // Get billing settings
    const billingSettings = await getBillingSettings();
    const now = new Date();
    const shopId = await getNextShopId();
    
    // Create shop
    const webhookToken = crypto.randomBytes(12).toString("hex");
    
    const shopDoc: Record<string, any> = {
      shopId,
      name: shopName,
      webhookToken,
      createdAt: now,
      updatedAt: now,
      billing: {
        status: skipTrial ? "pending_checkout" : "trial",
        trialStartedAt: skipTrial ? null : now,
        vinLimit: billingSettings.trialVinLimit,
        intendedVinLimit: skipTrial ? (billingSettings.mosProIncludedVins + billingSettings.skipTrialBonusVins) : null,
        skippedTrial: skipTrial,
      },
    };

    // Store AutoFlow config if provided
    if (autoflowDomain) {
      shopDoc.autoflow = {
        domain: autoflowDomain,
        apiKey: autoflowApiKey,
        apiPassword: autoflowApiPassword,
        updatedAt: now,
      };
    }

    // Store AutoVitals config if provided
    if (autovitalsWelcomeCode) {
      shopDoc.autovitals = {
        welcomeCode: autovitalsWelcomeCode,
        personalCode: autovitalsPersonalCode,
        updatedAt: now,
      };
    }

    // Store Protractor config if provided
    if (protractorShopId) {
      shopDoc.protractor = {
        connectionId: protractorShopId,
        apiKey: protractorApiKey,
        updatedAt: now,
      };
    }

    // Store Tekmetric config if provided
    if (tekmetricShopId) {
      const parsedTekmetricShopId = parseInt(tekmetricShopId, 10);
      if (!isNaN(parsedTekmetricShopId)) {
        shopDoc.tekmetric = {
          shopId: parsedTekmetricShopId,
          connectedAt: now,
        };
      }
    }

    // Store CARFAX config if provided
    if (carfaxLocationId) {
      shopDoc.carfax = {
        locationId: carfaxLocationId,
        updatedAt: now,
      };
    }

    await shops.insertOne(shopDoc);

    // Hash password
    const passwordHash = await bcrypt.hash(adminPassword, 12);

    // Create owner user (shop-level superuser)
    const userDoc = {
      shopId,
      email: adminEmail,
      emailLower: adminEmail,
      role: "owner",
      passwordHash,
      createdAt: now,
      updatedAt: now,
    };

    const userResult = await users.insertOne(userDoc);

    // Create session
    const sessionId = crypto.randomBytes(24).toString("hex");
    const ttlDays = 30;
    const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);
    
    await sessions.insertOne({
      token: sessionId,
      userId: userResult.insertedId,
      shopId,
      createdAt: now,
      expiresAt,
    });

    // If skipping trial, create Stripe checkout session
    let checkoutUrl: string | null = null;
    console.log("[Setup] Skip trial:", skipTrial, "Price ID:", billingSettings.mosProPriceId ? "configured" : "MISSING");
    if (skipTrial) {
      if (!billingSettings.mosProPriceId) {
        console.error("[Setup] Skip trial requested but no MOS Pro price ID configured:", JSON.stringify(billingSettings));
        // Fall back to trial mode instead of failing completely
        await shops.updateOne(
          { shopId },
          { 
            $set: { 
              "billing.status": "trial",
              "billing.trialStartedAt": now,
              "billing.skippedTrial": false,
              "billing.intendedVinLimit": null,
              updatedAt: new Date(),
            } 
          }
        );
      } else {
        try {
          const stripe = getStripe();
          const baseUrl = getBaseUrl();
          
          // Create Stripe customer
          const customer = await stripe.customers.create({
            email: adminEmail,
            name: shopName,
            metadata: {
              shopId: String(shopId),
              skippedTrial: "true",
            },
          });

          // Update shop with Stripe customer ID
          await shops.updateOne(
            { shopId },
            { 
              $set: { 
                "billing.stripeCustomerId": customer.id,
                updatedAt: new Date(),
              } 
            }
          );

          // Create checkout session
          const session = await stripe.checkout.sessions.create({
            customer: customer.id,
            mode: "subscription",
            line_items: [
              {
                price: billingSettings.mosProPriceId,
                quantity: 1,
              },
            ],
            success_url: `${baseUrl}/dashboard?subscription=success&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${baseUrl}/dashboard?subscription=cancelled`,
            subscription_data: {
              metadata: {
                shopId: String(shopId),
                skippedTrial: "true",
                bonusVins: String(billingSettings.skipTrialBonusVins),
              },
            },
            metadata: {
              shopId: String(shopId),
              skippedTrial: "true",
            },
          });

          checkoutUrl = session.url;

          // Store checkout session ID on shop
          await shops.updateOne(
            { shopId },
            { 
              $set: { 
                "billing.pendingCheckoutSessionId": session.id,
                updatedAt: new Date(),
              } 
            }
          );
        } catch (stripeErr: any) {
          console.error("[Setup] Stripe checkout error:", stripeErr);
          // Fall back to trial mode if Stripe fails
          await shops.updateOne(
            { shopId },
            { 
              $set: { 
                "billing.status": "trial",
                "billing.trialStartedAt": now,
                "billing.skippedTrial": false,
                "billing.intendedVinLimit": null,
                "billing.checkoutError": stripeErr?.message || "Stripe checkout failed",
                updatedAt: new Date(),
              } 
            }
          );
        }
      }
    }

    // Send welcome email (fire-and-forget)
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || `https://${req.headers.get("host") || "mos.tools"}`;
    const loginUrl = `${baseUrl}/login`;
    try {
      const welcomeMsg = makeWelcomeEmail(shopName, loginUrl);
      await sendEmail({ to: adminEmail, ...welcomeMsg });
      console.log(`[Setup] Welcome email sent to ${adminEmail}`);
    } catch (emailErr) {
      console.error("[Setup] Failed to send welcome email:", emailErr);
    }

    const res = NextResponse.json({ 
      ok: true, 
      redirect: checkoutUrl || "/dashboard",
      checkoutUrl,
      shopId, 
      role: "owner",
      message: skipTrial ? "Setup completed - redirecting to checkout" : "Setup completed successfully"
    });
    
    res.cookies.set("session_token", sessionId, {
      httpOnly: true,
      secure: typeof window === 'undefined' && (globalThis as any).process?.env?.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      expires: expiresAt,
    });
    
    return res;
  } catch (e: any) {
    console.error("Setup error:", e);
    return NextResponse.json({ error: e?.message || "Setup failed" }, { status: 500 });
  }
}
