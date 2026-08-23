import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { ObjectId } from "mongodb";
import {
  generatePartnerApiKey,
  getAvailablePermissions,
} from "@/lib/external-api/api-keys";
import {
  listPartnerApiKeys,
  revokePartnerApiKey,
  reactivatePartnerApiKey,
} from "@/lib/data/repositories/api-keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest) {
  const session = await getSession();
  if (!session?.isPlatformAdmin) {
    return NextResponse.json(
      { error: "Forbidden - platform admin access required" },
      { status: 403 }
    );
  }

  // task #345 (W3b): partner-keys read served from PG via the
  // repository. The repository strips `keyHash` so the response shape
  // matches the legacy `.project({ keyHash: 0 })` Mongo path.
  const partnerKeys = await listPartnerApiKeys();
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

  if (action === "revoke") {
    const ok = await revokePartnerApiKey(
      keyId,
      session.email || "platform_admin",
    );
    if (!ok) {
      return NextResponse.json({ error: "Partner key not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true, message: "Partner key revoked" });
  }

  if (action === "reactivate") {
    const ok = await reactivatePartnerApiKey(keyId);
    if (!ok) {
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
      session.email || "platform_admin",
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
