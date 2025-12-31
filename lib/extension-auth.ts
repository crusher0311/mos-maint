import { NextRequest } from "next/server";
import { getDb } from "@/lib/mongo";

export interface ExtensionAuthResult {
  user: any | null;
  authorized: boolean;
  error: string | null;
}

export async function validateExtensionToken(
  request: NextRequest, 
  requiredShopId?: string
): Promise<ExtensionAuthResult> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return { user: null, authorized: false, error: "Missing authorization" };
  }

  const token = authHeader.substring(7);
  if (!token.startsWith("ext_")) {
    return { user: null, authorized: false, error: "Invalid token format" };
  }

  const db = await getDb();
  const user = await db.collection("users").findOne({ extensionToken: token });
  
  if (!user) {
    return { user: null, authorized: false, error: "Invalid token" };
  }

  const tokenAge = Date.now() - new Date(user.extensionTokenCreatedAt).getTime();
  const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
  
  if (tokenAge > maxAge) {
    return { user: null, authorized: false, error: "Token expired" };
  }

  // Validate shop access if shopId is provided
  if (requiredShopId) {
    const userShopId = user.shopId?.toString();
    const userShopIds = (user.shopIds || []).map((id: any) => id.toString());
    
    // Check if user has access to this shop
    const hasAccess = userShopId === requiredShopId || userShopIds.includes(requiredShopId);
    
    // Also check if user is a platform admin (can access all shops)
    const isPlatformAdmin = user.role === "platform_admin";
    
    if (!hasAccess && !isPlatformAdmin) {
      console.warn(`[Extension Auth] Unauthorized shop access: user ${user.email} (shop ${userShopId}) tried shop ${requiredShopId}`);
      return { user, authorized: false, error: "Unauthorized shop access" };
    }
  }

  return { user, authorized: true, error: null };
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
