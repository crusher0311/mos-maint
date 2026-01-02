import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { ObjectId } from "mongodb";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const enterpriseId = searchParams.get("enterpriseId");

    if (!enterpriseId) {
      return NextResponse.json({ error: "Enterprise ID required" }, { status: 400 });
    }

    const db = await getDb();

    const enterprise = await db.collection("enterprise_accounts").findOne({
      _id: new ObjectId(enterpriseId),
    });

    if (!enterprise) {
      return NextResponse.json({ error: "Enterprise not found" }, { status: 404 });
    }

    const shopIds = enterprise.shopIds || [];

    const shops = await db
      .collection("shops")
      .find({ shopId: { $in: shopIds } })
      .project({ shopId: 1, name: 1, locationIdentifier: 1 })
      .toArray();

    const shopMap = new Map(shops.map((s) => [s.shopId, { 
      name: s.name || `Shop ${s.shopId}`, 
      locationIdentifier: s.locationIdentifier || null 
    }]));

    const users = await db
      .collection("users")
      .find({ shopId: { $in: shopIds } })
      .project({ _id: 1, email: 1, role: 1, shopId: 1, name: 1, createdAt: 1 })
      .toArray();

    const usersByEmail: Record<string, any> = {};
    for (const u of users) {
      const email = u.email.toLowerCase();
      if (!usersByEmail[email]) {
        usersByEmail[email] = {
          email,
          name: u.name || null,
          role: u.role,
          createdAt: u.createdAt,
          shopAccess: [],
        };
      }
      const shopInfo = shopMap.get(u.shopId);
      usersByEmail[email].shopAccess.push({
        shopId: u.shopId,
        shopName: shopInfo?.name || `Shop ${u.shopId}`,
        locationIdentifier: shopInfo?.locationIdentifier || null,
        userId: u._id.toString(),
      });
    }

    const userList = Object.values(usersByEmail).sort((a: any, b: any) =>
      a.email.localeCompare(b.email)
    );

    return NextResponse.json({
      enterprise: {
        id: enterprise._id.toString(),
        name: enterprise.name,
      },
      shops: shops.map((s) => ({
        shopId: s.shopId,
        name: s.name || `Shop ${s.shopId}`,
        locationIdentifier: s.locationIdentifier || null,
      })),
      users: userList,
    });
  } catch (err) {
    console.error("Error fetching enterprise users:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { enterpriseId, email, shopId, action } = await req.json();

    if (!enterpriseId || !email || !shopId || !action) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const db = await getDb();

    const enterprise = await db.collection("enterprise_accounts").findOne({
      _id: new ObjectId(enterpriseId),
    });

    if (!enterprise || !enterprise.shopIds?.includes(shopId)) {
      return NextResponse.json({ error: "Shop not in enterprise" }, { status: 400 });
    }

    const shop = await db.collection("shops").findOne({ shopId });
    const shopName = shop?.name || `Shop ${shopId}`;

    if (action === "grant") {
      const existingUser = await db.collection("users").findOne({
        email: email.toLowerCase(),
        shopId,
      });

      if (existingUser) {
        return NextResponse.json({ error: "User already has access to this shop" }, { status: 400 });
      }

      const sourceUser = await db.collection("users").findOne({
        email: email.toLowerCase(),
        shopId: { $in: enterprise.shopIds },
      });

      if (!sourceUser) {
        return NextResponse.json({ error: "User not found in enterprise" }, { status: 404 });
      }

      await db.collection("users").insertOne({
        email: email.toLowerCase(),
        name: sourceUser.name,
        role: sourceUser.role,
        shopId,
        passwordHash: sourceUser.passwordHash,
        createdAt: new Date(),
        grantedBy: session.email,
      });

      return NextResponse.json({
        ok: true,
        message: `Access granted to ${shopName}`,
      });
    } else if (action === "revoke") {
      const userAccounts = await db
        .collection("users")
        .find({ email: email.toLowerCase(), shopId: { $in: enterprise.shopIds } })
        .toArray();

      if (userAccounts.length <= 1) {
        return NextResponse.json({
          error: "Cannot revoke - user must have at least one shop access",
        }, { status: 400 });
      }

      await db.collection("users").deleteOne({
        email: email.toLowerCase(),
        shopId,
      });

      await db.collection("sessions").deleteMany({
        shopId,
      });

      return NextResponse.json({
        ok: true,
        message: `Access revoked from ${shopName}`,
      });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (err) {
    console.error("Error managing enterprise user:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
