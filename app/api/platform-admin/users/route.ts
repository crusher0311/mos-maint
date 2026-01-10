import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
      .project({ email: 1, role: 1, shopId: 1, createdAt: 1, isPlatformAdmin: 1 })
      .toArray();
    
    const shopIds = [...new Set(users.map(u => u.shopId).filter(Boolean))];
    const shops = await db.collection("shops")
      .find({ shopId: { $in: shopIds } })
      .project({ shopId: 1, name: 1, locationIdentifier: 1 })
      .toArray();
    
    // Build lookup maps with both numeric and string keys
    const shopDataMap = new Map<string, { name: string; locationIdentifier?: string }>();
    for (const s of shops) {
      const key = String(s.shopId);
      shopDataMap.set(key, { 
        name: s.name || `Shop ${s.shopId}`,
        locationIdentifier: s.locationIdentifier || null
      });
    }
    
    const enrichedUsers = users.map(user => {
      const shopData = shopDataMap.get(String(user.shopId));
      return {
        _id: user._id,
        email: user.email,
        role: user.role || "user",
        shopId: user.shopId,
        shopName: shopData?.name || `Shop ${user.shopId}`,
        locationIdentifier: shopData?.locationIdentifier || null,
        createdAt: user.createdAt || user._id.getTimestamp?.() || null,
        isPlatformAdmin: user.isPlatformAdmin || false,
      };
    });
    
    return NextResponse.json({
      ok: true,
      users: enrichedUsers.sort((a, b) => {
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
