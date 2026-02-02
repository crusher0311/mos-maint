import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

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
    const db = await getDb();
    
    const users = await db.collection("users")
      .find()
      .project({ email: 1, role: 1, shopId: 1, shopIds: 1, createdAt: 1, isPlatformAdmin: 1 })
      .toArray();
    
    const allShopIds = new Set<number | string>();
    for (const u of users) {
      if (u.shopId) allShopIds.add(u.shopId);
      if (u.shopIds?.length) u.shopIds.forEach((id: any) => allShopIds.add(id));
    }
    
    const shops = await db.collection("shops")
      .find({ shopId: { $in: [...allShopIds] } })
      .project({ shopId: 1, name: 1, locationIdentifier: 1 })
      .toArray();
    
    const shopDataMap = new Map<string, ShopInfo>();
    for (const s of shops) {
      const key = String(s.shopId);
      shopDataMap.set(key, { 
        shopId: s.shopId,
        name: s.name || `Shop ${s.shopId}`,
        locationIdentifier: s.locationIdentifier || null
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
      
      const primaryShopData = shopDataMap.get(String(user.shopId));
      const allUserShopIds = [user.shopId, ...(user.shopIds || [])].filter(Boolean);
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
        if (user.isPlatformAdmin) {
          existing.isPlatformAdmin = true;
        }
      } else {
        usersByEmail.set(email, {
          _id: user._id.toString(),
          email: user.email,
          role: user.role || "user",
          primaryShopId: user.shopId,
          shops: userShops,
          createdAt: user.createdAt || user._id.getTimestamp?.() || null,
          isPlatformAdmin: user.isPlatformAdmin || false,
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
  } catch (err: any) {
    console.error("Platform users error:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}
