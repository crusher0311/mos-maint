import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import {
  generatePartnerApiKey,
  getAvailablePermissions,
} from "@/lib/external-api/api-keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session?.isPlatformAdmin) {
    return NextResponse.json(
      { error: "Forbidden - platform admin access required" },
      { status: 403 }
    );
  }

  const db = await getDb();
  const partnerKeys = await db
    .collection("api_keys")
    .find({ isPartner: true })
    .project({
      keyHash: 0,
    })
    .sort({ createdAt: -1 })
    .toArray();

  return NextResponse.json({ success: true, partnerKeys });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session?.isPlatformAdmin) {
    return NextResponse.json(
      { error: "Forbidden - platform admin access required" },
      { status: 403 }
    );
  }

  const body = await req.json();
  const { partnerId, partnerName, permissions, rateLimit, expiresAt } = body;

  if (!partnerId || typeof partnerId !== "string") {
    return NextResponse.json(
      { error: "partnerId required (e.g., 'appfueled', 'partnerx')" },
      { status: 400 }
    );
  }

  if (!partnerName || typeof partnerName !== "string") {
    return NextResponse.json(
      { error: "partnerName required (e.g., 'AppFueled')" },
      { status: 400 }
    );
  }

  const perms = permissions && Array.isArray(permissions) ? permissions : ["*"];

  try {
    const result = await generatePartnerApiKey(
      partnerId,
      partnerName,
      perms,
      session.email || session.userId || "platform_admin",
      {
        rateLimitTier: "enterprise",
        rateLimit: rateLimit ? Number(rateLimit) : undefined,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
      }
    );

    return NextResponse.json({
      success: true,
      partnerId,
      partnerName,
      key: result.key,
      keyPrefix: result.keyPrefix,
      keyId: result.keyId,
      permissions: perms,
      message:
        "Store this key securely — it will not be shown again. Partner keys can access any shop by passing sms + smsShopId parameters.",
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message },
      { status: 400 }
    );
  }
}
