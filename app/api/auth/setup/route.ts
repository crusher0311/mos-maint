import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getNextShopId } from "@/lib/ids";
import { sendEmail, makeWelcomeEmail } from "@/lib/email";
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

    // Create shop
    const webhookToken = crypto.randomBytes(12).toString("hex");
    const now = new Date();
    const shopId = await getNextShopId();
    
    const shopDoc: Record<string, any> = {
      shopId,
      name: shopName,
      webhookToken,
      createdAt: now,
      updatedAt: now,
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
      redirect: "/dashboard", 
      shopId, 
      role: "owner",
      message: "Setup completed successfully"
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