import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { createEnterprise, getEnterpriseById, addShopToEnterprise } from "@/lib/enterprise";
import { ObjectId } from "mongodb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const enterpriseId = searchParams.get("id");
    
    if (enterpriseId) {
      const enterprise = await getEnterpriseById(enterpriseId);
      if (!enterprise) {
        return NextResponse.json({ error: "Enterprise not found" }, { status: 404 });
      }
      return NextResponse.json({ enterprise });
    }
    
    const db = await getDb();
    const enterprises = await db.collection("enterprise_accounts").find({}).toArray();
    return NextResponse.json({ enterprises });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { name, shopIds } = body;
    
    if (!name) {
      return NextResponse.json({ error: "Enterprise name is required" }, { status: 400 });
    }
    
    const enterprise = await createEnterprise(name, shopIds || []);
    
    if (shopIds?.length > 0) {
      const db = await getDb();
      await db.collection("shops").updateMany(
        { shopId: { $in: shopIds } },
        { $set: { enterpriseId: enterprise._id, updatedAt: new Date() } }
      );
    }
    
    return NextResponse.json({ enterprise });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const { enterpriseId, shopId, action } = body;
    
    if (!enterpriseId) {
      return NextResponse.json({ error: "Enterprise ID is required" }, { status: 400 });
    }
    
    if (action === "add_shop" && shopId) {
      await addShopToEnterprise(enterpriseId, shopId);
      
      const db = await getDb();
      await db.collection("shops").updateOne(
        { shopId },
        { $set: { enterpriseId: new ObjectId(enterpriseId), updatedAt: new Date() } }
      );
      
      return NextResponse.json({ ok: true });
    }
    
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}
