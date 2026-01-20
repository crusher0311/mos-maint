import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import bcrypt from "bcryptjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.isPlatformAdmin) {
    return NextResponse.json({ error: "Forbidden - platform admin access required" }, { status: 403 });
  }

  try {
    const body = await req.json();
    const { email, password, shopId, role, isPlatformAdmin } = body;

    if (!email || !password) {
      return NextResponse.json({ error: "Email and password are required" }, { status: 400 });
    }

    if (!shopId) {
      return NextResponse.json({ error: "Shop ID is required" }, { status: 400 });
    }

    const db = await getDb();

    const existing = await db.collection("users").findOne({ email: email.toLowerCase() });
    if (existing) {
      return NextResponse.json({ error: "User with this email already exists" }, { status: 400 });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await db.collection("users").insertOne({
      email: email.toLowerCase(),
      passwordHash: hashedPassword,
      shopId: parseInt(shopId, 10),
      role: role || "user",
      isPlatformAdmin: isPlatformAdmin || false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return NextResponse.json({
      ok: true,
      userId: result.insertedId,
      message: "User created successfully",
    });
  } catch (err: any) {
    console.error("Create user error:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
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
      .project({ email: 1, role: 1, shopId: 1, createdAt: 1, isPlatformAdmin: 1 })
      .toArray();
    
    const shopIds = [...new Set(users.map(u => u.shopId).filter(Boolean))];
    const shops = await db.collection("shops")
      .find({ shopId: { $in: shopIds } })
      .project({ shopId: 1, name: 1 })
      .toArray();
    
    const shopNameMap = new Map(shops.map(s => [s.shopId, s.name]));
    
    const enrichedUsers = users.map(user => ({
      _id: user._id,
      email: user.email,
      role: user.role || "user",
      shopId: user.shopId,
      shopName: shopNameMap.get(user.shopId) || `Shop ${user.shopId}`,
      createdAt: user.createdAt || user._id.getTimestamp?.() || null,
      isPlatformAdmin: user.isPlatformAdmin || false,
    }));
    
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
