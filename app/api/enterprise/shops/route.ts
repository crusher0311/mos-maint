import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import { getEnterpriseById, addShopToEnterprise, removeShopFromEnterprise } from "@/lib/enterprise";
import { ObjectId } from "mongodb";
import crypto from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function requireAdminAuth() {
  const session = await getSession();
  if (!session) {
    return { error: "Unauthorized", status: 401 };
  }
  if (!["owner", "admin"].includes(session.role || "")) {
    return { error: "Forbidden - admin access required", status: 403 };
  }
  return { session };
}

export async function GET(req: NextRequest) {
  const auth = await requireAdminAuth();
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  try {
    const { searchParams } = new URL(req.url);
    const enterpriseId = searchParams.get("enterpriseId");
    
    if (!enterpriseId) {
      return NextResponse.json({ error: "Enterprise ID is required" }, { status: 400 });
    }

    const enterprise = await getEnterpriseById(enterpriseId);
    if (!enterprise) {
      return NextResponse.json({ error: "Enterprise not found" }, { status: 404 });
    }

    const db = await getDb();
    
    const shops = await db.collection("shops")
      .find({ shopId: { $in: enterprise.shopIds } })
      .toArray();

    const shopUserCounts = await db.collection("users").aggregate([
      { $match: { shopId: { $in: enterprise.shopIds } } },
      { $group: { _id: "$shopId", count: { $sum: 1 } } }
    ]).toArray();
    
    const userCountMap = new Map(shopUserCounts.map(s => [s._id, s.count]));

    const shopsWithUserCounts = shops.map(shop => ({
      ...shop,
      userCount: userCountMap.get(shop.shopId) || 0
    }));

    const availableUsers = await db.collection("users")
      .find({ shopId: { $in: enterprise.shopIds } })
      .project({ email: 1, name: 1, role: 1 })
      .toArray();
    
    const uniqueUsers = new Map();
    availableUsers.forEach(u => {
      if (!uniqueUsers.has(u.email)) {
        uniqueUsers.set(u.email, u);
      }
    });

    return NextResponse.json({ 
      enterprise: { id: enterprise._id, name: enterprise.name },
      shops: shopsWithUserCounts,
      availableUsers: Array.from(uniqueUsers.values())
    });
  } catch (err: any) {
    console.error("Enterprise shops GET error:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdminAuth();
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  try {
    const body = await req.json();
    const { enterpriseId, name, smsProvider, tekmetricShopId, protractorShopId, assignUserIds } = body;
    
    if (!enterpriseId) {
      return NextResponse.json({ error: "Enterprise ID is required" }, { status: 400 });
    }
    
    if (!name) {
      return NextResponse.json({ error: "Shop name is required" }, { status: 400 });
    }

    const enterprise = await getEnterpriseById(enterpriseId);
    if (!enterprise) {
      return NextResponse.json({ error: "Enterprise not found" }, { status: 404 });
    }

    const db = await getDb();
    
    const counterResult = await db.collection("counters").findOneAndUpdate(
      { _id: "shopId" as any },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: "after" }
    );

    const shopId = (counterResult as any)?.seq || 10001;
    
    if (!shopId || shopId === 10001) {
      console.log("[Enterprise Shops] Counter result:", JSON.stringify(counterResult));
    }

    const shopDoc: any = {
      shopId,
      name: name.trim(),
      enterpriseId: new ObjectId(enterpriseId),
      webhookToken: crypto.randomBytes(12).toString("hex"),
      createdAt: new Date(),
      updatedAt: new Date(),
      status: "active"
    };

    if (smsProvider === "tekmetric") {
      shopDoc.smsProvider = "tekmetric";
      if (tekmetricShopId) {
        shopDoc.tekmetric = { shopId: tekmetricShopId };
      }
    } else if (smsProvider === "protractor") {
      shopDoc.smsProvider = "protractor";
      if (protractorShopId) {
        shopDoc.protractor = { shopId: protractorShopId };
      }
    }

    const result = await db.collection("shops").insertOne(shopDoc);
    
    await addShopToEnterprise(enterpriseId, shopId);

    if (assignUserIds && assignUserIds.length > 0) {
      const usersToClone = await db.collection("users")
        .find({ _id: { $in: assignUserIds.map((id: string) => new ObjectId(id)) } })
        .toArray();
      
      for (const user of usersToClone) {
        const existingUser = await db.collection("users").findOne({
          email: user.email,
          shopId
        });
        
        if (!existingUser) {
          await db.collection("users").insertOne({
            email: user.email,
            name: user.name,
            passwordHash: user.passwordHash,
            role: user.role,
            shopId,
            createdAt: new Date(),
            updatedAt: new Date()
          });
        }
      }
    }

    return NextResponse.json({
      shop: {
        _id: result.insertedId,
        ...shopDoc
      }
    }, { status: 201 });
  } catch (err: any) {
    console.error("Enterprise shops POST error:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const auth = await requireAdminAuth();
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  try {
    const body = await req.json();
    const { enterpriseId, shopId } = body;
    
    if (!enterpriseId || !shopId) {
      return NextResponse.json({ error: "Enterprise ID and Shop ID are required" }, { status: 400 });
    }

    const enterprise = await getEnterpriseById(enterpriseId);
    if (!enterprise) {
      return NextResponse.json({ error: "Enterprise not found" }, { status: 404 });
    }

    if (enterprise.shopIds.length <= 1) {
      return NextResponse.json({ error: "Cannot remove the last shop from an enterprise" }, { status: 400 });
    }

    await removeShopFromEnterprise(enterpriseId, shopId);

    const db = await getDb();
    await db.collection("shops").updateOne(
      { shopId },
      { $unset: { enterpriseId: "" }, $set: { updatedAt: new Date() } }
    );

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error("Enterprise shops DELETE error:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}
