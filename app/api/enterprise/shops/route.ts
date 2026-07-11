import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import { getEnterpriseById, addShopToEnterprise, removeShopFromEnterprise } from "@/lib/enterprise";
import { grantShopAccess } from "@/lib/enterprise-access";
import { ObjectId } from "mongodb";
import crypto from "crypto";
import { dualWritePgIdentity } from "@/lib/db/wave4-write-mode";
import { insertShop, updateShopFields } from "@/lib/data/repositories/pg/identity";

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
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  
  if (!["owner", "admin"].includes(session.role || "")) {
    return NextResponse.json({ error: "Only owners and admins can create locations" }, { status: 403 });
  }

  try {
    const body = await req.json();
    const { enterpriseId, name, smsProvider, tekmetricShopId, protractorShopId, assignUserIds, assignUserEmails } = body;
    
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
    
    if (!enterprise.shopIds.includes(session.shopId)) {
      return NextResponse.json({ error: "You don't have permission for this enterprise" }, { status: 403 });
    }

    const db = await getDb();

    // task #345 (W3b): PG-canonical counter via lib/ids.ts. Mongo
    // `counters` is shadow-mirrored during soak (`WRITE_MONGO_COUNTERS`).
    const { getNextShopId } = await import("@/lib/ids");
    const shopId = await getNextShopId();

    // For enterprise locations, use the enterprise name as the shop name
    // and the provided "name" as the location identifier
    const shopDoc: any = {
      shopId,
      name: enterprise.name,
      locationIdentifier: name.trim(),
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
    await dualWritePgIdentity(`shops.insert(${shopId})`, () =>
      insertShop(shopDoc)
    );
    
    await addShopToEnterprise(enterpriseId, shopId);

    // Grant access to the selected users via the canonical Model B path
    // (shopIds array), the same helper the manual grant button uses. The old
    // clone-a-doc-per-shop approach only matched users whose PRIMARY shopId
    // was inside the enterprise, silently skipping users whose enterprise
    // access lives in their shopIds array (primary shop elsewhere).
    let grantEmails: string[] = [];

    if (assignUserIds && assignUserIds.length > 0) {
      const validIds = assignUserIds.filter((id: unknown) => typeof id === "string" && ObjectId.isValid(id));
      const docs = await db.collection("users")
        .find({ _id: { $in: validIds.map((id: string) => new ObjectId(id)) } })
        .project({ email: 1 })
        .toArray();
      grantEmails = docs.map(d => d.email).filter(Boolean);
    } else if (assignUserEmails && assignUserEmails.length > 0) {
      grantEmails = assignUserEmails.filter((e: unknown) => typeof e === "string" && e);
    }
    grantEmails = [...new Set(grantEmails.map(e => e.toLowerCase()))];

    // Include the just-created shop so grantShopAccess can target it.
    const enterpriseShopIds = [
      ...new Set([...enterprise.shopIds.map(Number).filter(Number.isFinite), Number(shopId)]),
    ];

    const grantFailures: Array<{ email: string; error: string }> = [];
    for (const email of grantEmails) {
      const grant = await grantShopAccess(db, {
        enterpriseShopIds,
        email,
        shopId: Number(shopId),
        grantedBy: session.email || String(session.userId || ""),
      });
      if (!grant.ok && grant.error !== "User already has access to this shop") {
        console.error(`Enterprise shop create: failed to grant ${email} access to shop ${shopId}:`, grant.error);
        grantFailures.push({ email, error: grant.error || "Unknown error" });
      }
    }

    return NextResponse.json({
      shop: {
        _id: result.insertedId,
        ...shopDoc
      },
      ...(grantFailures.length > 0 ? { grantFailures } : {})
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
    await dualWritePgIdentity(`shops.update(unset enterpriseId ${shopId})`, () =>
      updateShopFields(shopId, { enterpriseId: null })
    );

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error("Enterprise shops DELETE error:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}
