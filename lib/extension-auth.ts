import { NextRequest } from "next/server";
import { getDb } from "@/lib/mongo";

export interface ExtensionAuthResult {
  user: any | null;
  authorized: boolean;
  error: string | null;
  serverError?: boolean;
}

const MAX_TOKEN_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const TOKEN_REFRESH_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // refresh after 7 days of use

export async function validateExtensionToken(
  request: NextRequest, 
  requiredShopId?: string
): Promise<ExtensionAuthResult> {
  let token: string | null = null;

  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.substring(7);
  }

  if (!token) {
    token = request.nextUrl.searchParams.get("_token");
  }

  if (!token || !token.startsWith("ext_")) {
    return { user: null, authorized: false, error: "Missing authorization" };
  }

  let db;
  try {
    db = await getDb();
  } catch (err) {
    console.error("[Extension Auth] Database connection failed:", err);
    return { user: null, authorized: false, error: "Server error", serverError: true };
  }

  let user;
  try {
    user = await db.collection("users").findOne({ extensionToken: token });
  } catch (err) {
    console.error("[Extension Auth] Token lookup failed:", err);
    return { user: null, authorized: false, error: "Server error", serverError: true };
  }
  
  if (!user) {
    return { user: null, authorized: false, error: "Invalid token" };
  }

  if (user.extensionTokenCreatedAt) {
    const tokenAge = Date.now() - new Date(user.extensionTokenCreatedAt).getTime();
    
    if (tokenAge > MAX_TOKEN_AGE_MS) {
      return { user: null, authorized: false, error: "Token expired" };
    }

    if (tokenAge > TOKEN_REFRESH_THRESHOLD_MS) {
      try {
        await db.collection("users").updateOne(
          { _id: user._id },
          { $set: { extensionTokenCreatedAt: new Date() } }
        );
      } catch (err) {
        console.warn("[Extension Auth] Failed to refresh token timestamp:", err);
      }
    }
  }

  if (requiredShopId) {
    const userShopId = user.shopId?.toString();
    const userShopIds = (user.shopIds || []).map((id: any) => id.toString());
    
    const hasAccess = userShopId === requiredShopId || userShopIds.includes(requiredShopId);
    
    const isPlatformAdmin = user.role === "platform_admin";
    
    if (!hasAccess && !isPlatformAdmin) {
      console.warn(`[Extension Auth] Unauthorized shop access: user ${user.email} (shop ${userShopId}) tried shop ${requiredShopId}`);
      return { user, authorized: false, error: "Unauthorized shop access" };
    }
  }

  return { user, authorized: true, error: null };
}

export function getAuthErrorStatus(auth: ExtensionAuthResult): number {
  if (auth.serverError) return 503;
  return 401;
}

export function getUserShopIds(user: any): string[] {
  const shopIds: string[] = [];
  
  if (user.shopId) {
    shopIds.push(user.shopId.toString());
  }
  
  if (user.shopIds && Array.isArray(user.shopIds)) {
    for (const id of user.shopIds) {
      const strId = id.toString();
      if (!shopIds.includes(strId)) {
        shopIds.push(strId);
      }
    }
  }
  
  return shopIds;
}
