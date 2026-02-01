import { NextRequest } from "next/server";
import sql from "@/lib/db/postgres";

export interface ExtensionAuthResult {
  user: Record<string, unknown> | null;
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

  const rows = await sql`
    SELECT id, email, role, shop_id, shop_ids, extension_token, extension_token_created_at
    FROM users
    WHERE extension_token = ${token}
    LIMIT 1
  `;
  
  const user = rows[0];
  if (!user) {
    return { user: null, authorized: false, error: "Invalid token" };
  }

  const tokenCreatedAt = user.extension_token_created_at as Date | null;
  if (!tokenCreatedAt) {
    return { user: null, authorized: false, error: "Token expired" };
  }
  
  const tokenAge = Date.now() - new Date(tokenCreatedAt).getTime();
  const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
  
  if (tokenAge > maxAge) {
    return { user: null, authorized: false, error: "Token expired" };
  }

  if (requiredShopId) {
    const userShopId = user.shop_id?.toString();
    const userShopIds = ((user.shop_ids as string[]) || []).map((id) => id.toString());
    
    const hasAccess = userShopId === requiredShopId || userShopIds.includes(requiredShopId);
    const isPlatformAdmin = user.role === "platform_admin";
    
    if (!hasAccess && !isPlatformAdmin) {
      console.warn(`[Extension Auth] Unauthorized shop access: user ${user.email} (shop ${userShopId}) tried shop ${requiredShopId}`);
      return { user: user as Record<string, unknown>, authorized: false, error: "Unauthorized shop access" };
    }
  }

  return { user: user as Record<string, unknown>, authorized: true, error: null };
}

export function getUserShopIds(user: Record<string, unknown>): string[] {
  const shopIds: string[] = [];
  
  if (user.shop_id) {
    shopIds.push(user.shop_id.toString());
  }
  
  if (user.shop_ids && Array.isArray(user.shop_ids)) {
    for (const id of user.shop_ids) {
      const strId = id.toString();
      if (!shopIds.includes(strId)) {
        shopIds.push(strId);
      }
    }
  }
  
  return shopIds;
}
