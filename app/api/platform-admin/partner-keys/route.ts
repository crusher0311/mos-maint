import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { ObjectId } from "mongodb";
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

  const permissions = getAvailablePermissions();

  return NextResponse.json({ success: true, partnerKeys, permissions });
}

export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (!session?.isPlatformAdmin) {
    return NextResponse.json(
      { error: "Forbidden - platform admin access required" },
      { status: 403 }
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { keyId, action } = body;

  if (!keyId || typeof keyId !== "string") {
    return NextResponse.json({ error: "keyId required" }, { status: 400 });
  }

  if (!ObjectId.isValid(keyId)) {
    return NextResponse.json({ error: "Invalid keyId format" }, { status: 400 });
  }

  const db = await getDb();

  if (action === "revoke") {
    const result = await db.collection("api_keys").updateOne(
      { _id: new ObjectId(keyId), isPartner: true },
      { $set: { revoked: true, revokedAt: new Date(), revokedBy: session.email || "platform_admin" } }
    );

    if (result.matchedCount === 0) {
      return NextResponse.json({ error: "Partner key not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true, message: "Partner key revoked" });
  }

  if (action === "reactivate") {
    const result = await db.collection("api_keys").updateOne(
      { _id: new ObjectId(keyId), isPartner: true },
      { $unset: { revoked: "", revokedAt: "", revokedBy: "" } }
    );

    if (result.matchedCount === 0) {
      return NextResponse.json({ error: "Partner key not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true, message: "Partner key reactivated" });
  }

  return NextResponse.json({ error: "Invalid action. Use 'revoke' or 'reactivate'" }, { status: 400 });
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
