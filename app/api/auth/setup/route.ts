import { NextRequest, NextResponse } from "next/server";
import { getNextShopId } from "@/lib/ids";
import { getStripe, getBillingSettings, getBaseUrl } from "@/lib/stripe";
import sql from "@/lib/db/postgres";
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

    if (!shopName || !adminEmail || !adminPassword) {
      return NextResponse.json({ error: "Missing required fields: shopName, adminEmail, adminPassword" }, { status: 400 });
    }
    
    if (adminPassword.length < 8) {
      return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
    }

    const existingUserResult = await sql`
      SELECT id FROM users WHERE LOWER(email) = ${adminEmail} LIMIT 1
    `;
    if (existingUserResult.length > 0) {
      return NextResponse.json({ error: "User already exists with this email" }, { status: 409 });
    }

    const billingSettings = await getBillingSettings();
    
    if (!billingSettings.mosProPriceId) {
      return NextResponse.json({ error: "Billing is not configured. Please contact support." }, { status: 500 });
    }

    const passwordHash = await bcrypt.hash(adminPassword, 12);
    const token = crypto.randomBytes(16).toString("hex");
    const reservedShopId = await getNextShopId();
    const now = new Date();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const signupData = {
      reservedShopId,
      passwordHash,
      completed: false,
    };

    await sql`
      INSERT INTO pending_signups (email, token, shop_name, signup_data, expires_at, created_at)
      VALUES (${adminEmail}, ${token}, ${shopName}, ${JSON.stringify(signupData)}::jsonb, ${expiresAt}, ${now})
    `;

    const stripe = getStripe();
    const baseUrl = getBaseUrl();

    const customer = await stripe.customers.create({
      email: adminEmail,
      name: shopName,
      metadata: {
        pendingToken: token,
        reservedShopId: String(reservedShopId),
      },
    });

    const session = await stripe.checkout.sessions.create({
      customer: customer.id,
      mode: "subscription",
      line_items: [
        {
          price: billingSettings.mosProPriceId,
          quantity: 1,
        },
      ],
      success_url: `${baseUrl}/setup/complete?token=${token}`,
      cancel_url: `${baseUrl}/setup?cancelled=true`,
      subscription_data: {
        metadata: {
          pendingToken: token,
          reservedShopId: String(reservedShopId),
          bonusVins: String(billingSettings.skipTrialBonusVins || 50),
        },
      },
      metadata: {
        pendingToken: token,
        reservedShopId: String(reservedShopId),
        signupFlow: "true",
      },
    });

    const updatedSignupData = {
      ...signupData,
      stripeCustomerId: customer.id,
      checkoutSessionId: session.id,
    };

    await sql`
      UPDATE pending_signups 
      SET signup_data = ${JSON.stringify(updatedSignupData)}::jsonb
      WHERE token = ${token}
    `;

    return NextResponse.json({ 
      ok: true, 
      checkoutUrl: session.url,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error("Setup error:", e);
    return NextResponse.json({ error: message || "Setup failed" }, { status: 500 });
  }
}
