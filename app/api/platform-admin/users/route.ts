import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ShopInfo {
  shopId: number | string;
  name: string;
  locationIdentifier?: string | null;
}

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.isPlatformAdmin) {
    return NextResponse.json({ error: "Forbidden - platform admin access required" }, { status: 403 });
  }

  try {
    const users = await sql`
      SELECT id, email, role, shop_id, shop_ids, created_at, is_platform_admin 
      FROM users
    `;
    
    const allShopIds = new Set<string>();
    for (const u of users) {
      if (u.shop_id) allShopIds.add(String(u.shop_id));
      const shopIds = u.shop_ids as number[] | null;
      if (shopIds?.length) shopIds.forEach(id => allShopIds.add(String(id)));
    }
    
    const shops = allShopIds.size > 0 ? await sql`
      SELECT id, shop_id, name, location_identifier 
      FROM shops 
      WHERE shop_id = ANY(${[...allShopIds]})
    ` : [];
    
    const shopDataMap = new Map<string, ShopInfo>();
    for (const s of shops) {
      const key = String(s.shop_id);
      shopDataMap.set(key, { 
        shopId: s.shop_id ? parseInt(s.shop_id, 10) : s.id,
        name: s.name || `Shop ${s.shop_id}`,
        locationIdentifier: s.location_identifier || null
      });
    }
    
    const usersByEmail = new Map<string, {
      _id: string;
      email: string;
      role: string;
      primaryShopId: number | string;
      shops: ShopInfo[];
      createdAt: Date | null;
      isPlatformAdmin: boolean;
    }>();
    
    for (const user of users) {
      const email = user.email?.toLowerCase();
      if (!email) continue;
      
      const userShopIds = user.shop_ids as number[] | null;
      const allUserShopIds = [user.shop_id, ...(userShopIds || [])].filter(Boolean);
      const userShops: ShopInfo[] = [];
      
      for (const sid of allUserShopIds) {
        const shopData = shopDataMap.get(String(sid));
        if (shopData) {
          userShops.push(shopData);
        } else {
          userShops.push({ shopId: sid, name: `Shop ${sid}`, locationIdentifier: null });
        }
      }
      
      const existing = usersByEmail.get(email);
      if (existing) {
        for (const shop of userShops) {
          if (!existing.shops.find(s => String(s.shopId) === String(shop.shopId))) {
            existing.shops.push(shop);
          }
        }
        if (user.role === 'owner' && existing.role !== 'owner') {
          existing.role = 'owner';
        }
        if (user.is_platform_admin) {
          existing.isPlatformAdmin = true;
        }
      } else {
        usersByEmail.set(email, {
          _id: user.id,
          email: user.email,
          role: user.role || "user",
          primaryShopId: user.shop_id,
          shops: userShops,
          createdAt: user.created_at || null,
          isPlatformAdmin: user.is_platform_admin || false,
        });
      }
    }
    
    const groupedUsers = Array.from(usersByEmail.values()).map(u => ({
      _id: u._id,
      email: u.email,
      role: u.role,
      primaryShopId: u.primaryShopId,
      shops: u.shops,
      locationCount: u.shops.length,
      createdAt: u.createdAt,
      isPlatformAdmin: u.isPlatformAdmin,
    }));
    
    return NextResponse.json({
      ok: true,
      users: groupedUsers.sort((a, b) => {
        if (!a.createdAt) return 1;
        if (!b.createdAt) return -1;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Platform users error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
