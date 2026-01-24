import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { 
  generateApiKey, 
  getApiKeysForShop, 
  revokeApiKey, 
  updateApiKey,
  getAvailablePermissions,
  RATE_LIMIT_TIERS,
  RateLimitTier
} from "@/lib/external-api/api-keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const shopId = Number(session.shopId);
    const keys = await getApiKeysForShop(shopId);
    
    const safeKeys = keys.map(key => ({
      id: key._id?.toString(),
      name: key.name,
      keyPrefix: key.keyPrefix,
      permissions: key.permissions,
      rateLimit: key.rateLimit,
      rateLimitTier: key.rateLimitTier || "standard",
      isActive: key.isActive,
      usageCount: key.usageCount,
      lastUsedAt: key.lastUsedAt,
      createdAt: key.createdAt,
      createdBy: key.createdBy,
      expiresAt: key.expiresAt,
    }));

    return NextResponse.json({ 
      keys: safeKeys,
      availablePermissions: getAvailablePermissions(),
      rateLimitTiers: RATE_LIMIT_TIERS,
    });
  } catch (err: any) {
    console.error("[API Keys] Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const shopId = Number(session.shopId);
    const body = await req.json();
    
    const { name, permissions, rateLimitTier, expiresAt } = body;
    
    if (!name || !permissions || !Array.isArray(permissions)) {
      return NextResponse.json(
        { error: "name and permissions array are required" },
        { status: 400 }
      );
    }

    const tier: RateLimitTier = rateLimitTier || "standard";

    const result = await generateApiKey(
      shopId,
      name,
      permissions,
      session.email || "unknown",
      {
        rateLimitTier: tier,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
      }
    );

    return NextResponse.json({
      success: true,
      key: result.key,
      keyPrefix: result.keyPrefix,
      keyId: result.keyId,
      warning: "Save this API key now. You won't be able to see it again!",
    });
  } catch (err: any) {
    console.error("[API Keys] Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { keyId, name, permissions, rateLimitTier, isActive, expiresAt } = body;
    
    if (!keyId) {
      return NextResponse.json({ error: "keyId is required" }, { status: 400 });
    }

    const updates: any = {};
    if (name !== undefined) updates.name = name;
    if (permissions !== undefined) updates.permissions = permissions;
    if (rateLimitTier !== undefined) updates.rateLimitTier = rateLimitTier;
    if (isActive !== undefined) updates.isActive = isActive;
    if (expiresAt !== undefined) updates.expiresAt = expiresAt ? new Date(expiresAt) : null;

    const success = await updateApiKey(keyId, updates);

    if (success) {
      return NextResponse.json({ success: true });
    } else {
      return NextResponse.json({ error: "Failed to update key" }, { status: 400 });
    }
  } catch (err: any) {
    console.error("[API Keys] Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const keyId = req.nextUrl.searchParams.get("keyId");
    
    if (!keyId) {
      return NextResponse.json({ error: "keyId is required" }, { status: 400 });
    }

    const success = await revokeApiKey(keyId);

    if (success) {
      return NextResponse.json({ success: true, message: "API key revoked" });
    } else {
      return NextResponse.json({ error: "Failed to revoke key" }, { status: 400 });
    }
  } catch (err: any) {
    console.error("[API Keys] Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
