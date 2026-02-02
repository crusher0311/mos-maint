import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { ObjectId } from "mongodb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session?.isPlatformAdmin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const db = await getDb();
    
    const [enterprises, shops] = await Promise.all([
      db.collection("enterprise_accounts").find({}).toArray(),
      db.collection("shops").find({}).project({ shopId: 1, name: 1, enterpriseId: 1 }).toArray()
    ]);

    const enrichedEnterprises = enterprises.map(e => ({
      _id: e._id,
      name: e.name,
      shopIds: e.shopIds || [],
      shopCount: e.shopIds?.length || 0,
      createdAt: e.createdAt || e._id.getTimestamp?.(),
    }));

    const availableShops = shops.filter(s => !s.enterpriseId).map(s => ({
      shopId: s.shopId,
      name: s.name,
    }));

    return NextResponse.json({
      ok: true,
      enterprises: enrichedEnterprises,
      availableShops,
      allShops: shops.map(s => ({ shopId: s.shopId, name: s.name, enterpriseId: s.enterpriseId })),
    });
  } catch (err: any) {
    console.error("Platform admin enterprises error:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session?.isPlatformAdmin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { name, shopIds } = await req.json();

    if (!name?.trim()) {
      return NextResponse.json({ error: "Enterprise name is required" }, { status: 400 });
    }

    const db = await getDb();

    const enterprise = {
      name: name.trim(),
      shopIds: shopIds || [],
      createdAt: new Date(),
      createdBy: session.email,
    };

    const result = await db.collection("enterprise_accounts").insertOne(enterprise);

    if (shopIds?.length > 0) {
      await db.collection("shops").updateMany(
        { shopId: { $in: shopIds } },
        { $set: { enterpriseId: result.insertedId, updatedAt: new Date() } }
      );
    }

    await db.collection("audit_logs").insertOne({
      type: "enterprise_created",
      enterpriseId: result.insertedId,
      enterpriseName: name,
      shopIds,
      adminEmail: session.email,
      createdAt: new Date(),
    });

    return NextResponse.json({
      ok: true,
      enterprise: { ...enterprise, _id: result.insertedId },
    });
  } catch (err: any) {
    console.error("Create enterprise error:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}
