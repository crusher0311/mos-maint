import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getNextShopId } from "@/lib/ids";
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

    if (!shopName || !adminEmail || !adminPassword) {
      return NextResponse.json({ error: "Missing required fields: shopName, adminEmail, adminPassword" }, { status: 400 });
    }
    
    if (adminPassword.length < 8) {
      return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
    }

    const db = await getDb();
    const users = db.collection("users");

    const existingUser = await users.findOne({ emailLower: adminEmail });
    if (existingUser) {
      return NextResponse.json({ error: "User already exists with this email" }, { status: 409 });
    }

    const billingSettings = await getBillingSettings();
    
    if (!billingSettings.mosProPriceId) {
      return NextResponse.json({ error: "Billing is not configured. Please contact support." }, { status: 500 });
    }

    const passwordHash = await bcrypt.hash(adminPassword, 12);
    const pendingId = crypto.randomBytes(16).toString("hex");
    const reservedShopId = await getNextShopId();

    await db.collection("pending_signups").insertOne({
      pendingId,
      reservedShopId,
      shopName,
      adminEmail,
      passwordHash,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    const stripe = getStripe();
    const baseUrl = getBaseUrl();

    const customer = await stripe.customers.create({
      email: adminEmail,
      name: shopName,
      metadata: {
        pendingId,
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
      success_url: `${baseUrl}/setup/complete?pending_id=${pendingId}`,
      cancel_url: `${baseUrl}/setup?cancelled=true`,
      subscription_data: {
        metadata: {
          pendingId,
          reservedShopId: String(reservedShopId),
        },
      },
      metadata: {
        pendingId,
        reservedShopId: String(reservedShopId),
        signupFlow: "true",
      },
    });

    await db.collection("pending_signups").updateOne(
      { pendingId },
      { 
        $set: { 
          stripeCustomerId: customer.id,
          checkoutSessionId: session.id,
        } 
      }
    );

    return NextResponse.json({ 
      ok: true, 
      checkoutUrl: session.url,
    });
  } catch (e: any) {
    console.error("Setup error:", e);
    return NextResponse.json({ error: e?.message || "Setup failed" }, { status: 500 });
  }
}
