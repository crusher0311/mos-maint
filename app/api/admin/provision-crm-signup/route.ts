import { NextRequest, NextResponse } from "next/server";
import { crmDisabledResponse } from "@/lib/feature-flags/gate";
import { getDb } from "@/lib/mongo";
import { getNextShopId } from "@/lib/ids";
import { sendEmail, makeCredentialsWelcomeEmail } from "@/lib/email";
import { computeAutoFlagReasons } from "@/lib/shop-review";
import { createHovercodeQR } from "@/lib/hovercode";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function generateTempPassword(): string {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let pw = "";
  const bytes = crypto.randomBytes(12);
  for (let i = 0; i < 12; i++) {
    pw += chars[bytes[i] % chars.length];
  }
  return pw;
}

export async function POST(req: NextRequest) {
  const __gated = crmDisabledResponse();
  if (__gated) return __gated;

  const db = await getDb();

  const auth = req.headers.get("authorization");
  const token = auth?.replace("Bearer ", "");
  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = await db.collection("users").findOne({
    $or: [
      { token, role: "platform_admin" },
      { token, role: "owner", shopId: 0 },
    ],
  });
  if (!admin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { shopName, ownerEmail, ownerName, plan, stripeCustomerId, stripeSubscriptionId } = body;

  if (!shopName || !ownerEmail) {
    return NextResponse.json(
      { error: "shopName and ownerEmail are required" },
      { status: 400 }
    );
  }

  const emailLower = ownerEmail.toLowerCase().trim();

  const existingUser = await db.collection("users").findOne({ emailLower });
  if (existingUser) {
    return NextResponse.json(
      { error: "A user with this email already exists", existingShopId: existingUser.shopId },
      { status: 409 }
    );
  }

  const allowedPlans = ["professional", "starter", "enterprise"];
  const validatedPlan = plan && allowedPlans.includes(plan) ? plan : "professional";
  const sanitizedShopName = shopName.slice(0, 200).trim();

  const tempPassword = generateTempPassword();
  const passwordHash = await bcrypt.hash(tempPassword, 12);
  const shopId = await getNextShopId();
  const now = new Date();
  const webhookToken = crypto.randomBytes(12).toString("hex");

  const billingForReview = {
    plan: validatedPlan,
    status: "active",
    isPaid: true,
    vinLimit: 300,
    stripeCustomerId: stripeCustomerId || null,
    stripeSubscriptionId: stripeSubscriptionId || null,
    updatedAt: now,
  };
  const initialAutoFlagReasons = computeAutoFlagReasons({
    billing: billingForReview,
    cardOnFile: !!stripeCustomerId,
    stripeCustomerId: stripeCustomerId || undefined,
  });
  const shopDoc = {
    shopId,
    name: sanitizedShopName,
    webhookToken,
    createdAt: now,
    updatedAt: now,
    provisionedVia: "crm",
    // task #252: pending review until a platform admin approves.
    reviewStatus: "pending" as const,
    reviewedAt: null,
    reviewedBy: null,
    reviewNotes: null,
    autoFlagReasons: initialAutoFlagReasons,
    billing: billingForReview,
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
    shopId,
    email: emailLower,
    emailLower,
    name: ownerName || null,
    role: "owner",
    passwordHash,
    mustChangePassword: true,
    createdAt: now,
    updatedAt: now,
  };

  await db.collection("shops").insertOne(shopDoc);
  await db.collection("users").insertOne(userDoc);
  console.log(`[CRM Provision] Created shop ${shopId} (${shopName}) for ${emailLower}`);

  createHovercodeQR({ shopId, shopName }).then(async (result) => {
    if (result.success && result.hovercodeId) {
      await db.collection("shops").updateOne(
        { shopId },
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
  const loginUrl = `${baseUrl}/login`;

  try {
    const emailContent = makeCredentialsWelcomeEmail(shopName, emailLower, tempPassword, loginUrl);
    await sendEmail({ to: emailLower, ...emailContent, shopId, emailKind: "credentials_welcome" });
    console.log(`[CRM Provision] Welcome email sent to ${emailLower}`);
  } catch (emailErr) {
    console.error("[CRM Provision] Failed to send welcome email:", emailErr);
  }

  return NextResponse.json({
    success: true,
    shopId,
    email: emailLower,
    message: `Shop ${shopId} created. Welcome email with credentials sent to ${emailLower}.`,
  });
}
