import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { ObjectId } from "mongodb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: { userId: string } }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.isPlatformAdmin) {
    return NextResponse.json({ error: "Forbidden - platform admin access required" }, { status: 403 });
  }

  try {
    const db = await getDb();
    const userId = params.userId;
    
    let user;
    try {
      user = await db.collection("users").findOne(
        { _id: new ObjectId(userId) },
        { projection: { passwordHash: 0, password: 0 } }
      );
    } catch {
      return NextResponse.json({ error: "Invalid user ID" }, { status: 400 });
    }
    
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }
    
    const userShopIds = [user.shopId, ...(user.shopIds || [])].filter(Boolean);
    const uniqueUserShopIds = [...new Set(userShopIds.map(id => String(id)))];
    
    // Fetch all shops and enterprises in parallel
    const [allShops, enterprises] = await Promise.all([
      db.collection("shops").find().project({ shopId: 1, name: 1, locationIdentifier: 1, enterpriseId: 1 }).toArray(),
      db.collection("enterprise_accounts").find().toArray()
    ]);
    
    // Build enterprise lookup
    const enterpriseMap = new Map(enterprises.map(e => [e._id.toString(), e]));
    
    // Find which enterprise the user's primary shop belongs to
    const primaryShop = allShops.find(s => String(s.shopId) === String(user.shopId));
    const userEnterpriseId = primaryShop?.enterpriseId?.toString();
    const userEnterprise = userEnterpriseId ? enterpriseMap.get(userEnterpriseId) : null;
    
    // Get enterprise shop IDs
    const enterpriseShopIds = new Set<string>();
    if (userEnterprise && userEnterprise.shopIds) {
      for (const sid of userEnterprise.shopIds) {
        enterpriseShopIds.add(String(sid));
      }
    }
    
    // Build shop metadata with enterprise flags
    const shopMetadata = allShops.map(shop => ({
      shopId: String(shop.shopId),
      name: shop.name || `Shop ${shop.shopId}`,
      locationIdentifier: shop.locationIdentifier || null,
      isInUserEnterprise: enterpriseShopIds.has(String(shop.shopId)),
      isUserPrimary: String(shop.shopId) === String(user.shopId),
      isSelected: uniqueUserShopIds.includes(String(shop.shopId)),
    }));
    
    // Sort: user primary first, then enterprise locations, then others
    shopMetadata.sort((a, b) => {
      if (a.isUserPrimary && !b.isUserPrimary) return -1;
      if (!a.isUserPrimary && b.isUserPrimary) return 1;
      if (a.isInUserEnterprise && !b.isInUserEnterprise) return -1;
      if (!a.isInUserEnterprise && b.isInUserEnterprise) return 1;
      return a.name.localeCompare(b.name);
    });
    
    return NextResponse.json({
      ok: true,
      user: {
        _id: user._id,
        email: user.email,
        role: user.role || "user",
        shopId: user.shopId,
        shopIds: user.shopIds || [],
        isPlatformAdmin: user.isPlatformAdmin || false,
        createdAt: user.createdAt,
        lastLogin: user.lastLogin,
      },
      enterprise: userEnterprise ? {
        _id: userEnterprise._id,
        name: userEnterprise.name,
        shopIds: userEnterprise.shopIds?.map((id: any) => String(id)) || [],
      } : null,
      shops: shopMetadata,
    });
  } catch (err: any) {
    console.error("Error fetching user:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { userId: string } }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.isPlatformAdmin) {
    return NextResponse.json({ error: "Forbidden - platform admin access required" }, { status: 403 });
  }

  try {
    const db = await getDb();
    const userId = params.userId;
    const body = await request.json();
    
    let objectId;
    try {
      objectId = new ObjectId(userId);
    } catch {
      return NextResponse.json({ error: "Invalid user ID" }, { status: 400 });
    }
    
    const existingUser = await db.collection("users").findOne({ _id: objectId });
    if (!existingUser) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }
    
    const updateFields: Record<string, any> = {};
    
    if (body.role !== undefined) {
      const validRoles = ["owner", "admin", "manager", "user", "viewer"];
      if (!validRoles.includes(body.role)) {
        return NextResponse.json({ error: "Invalid role" }, { status: 400 });
      }
      updateFields.role = body.role;
    }
    
    if (body.shopId !== undefined) {
      updateFields.shopId = body.shopId;
    }
    
    if (body.shopIds !== undefined) {
      if (!Array.isArray(body.shopIds)) {
        return NextResponse.json({ error: "shopIds must be an array" }, { status: 400 });
      }
      updateFields.shopIds = body.shopIds;
    }
    
    if (body.isPlatformAdmin !== undefined) {
      updateFields.isPlatformAdmin = Boolean(body.isPlatformAdmin);
    }
    
    if (Object.keys(updateFields).length === 0) {
      return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
    }
    
    updateFields.updatedAt = new Date();
    updateFields.updatedBy = session.email;
    
    await db.collection("users").updateOne(
      { _id: objectId },
      { $set: updateFields }
    );
    
    console.log(`[Platform Admin] User ${session.email} updated user ${existingUser.email}:`, updateFields);
    
    return NextResponse.json({
      ok: true,
      message: "User updated successfully",
    });
  } catch (err: any) {
    console.error("Error updating user:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { userId: string } }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.isPlatformAdmin) {
    return NextResponse.json({ error: "Forbidden - platform admin access required" }, { status: 403 });
  }

  try {
    const db = await getDb();
    const userId = params.userId;
    
    let objectId;
    try {
      objectId = new ObjectId(userId);
    } catch {
      return NextResponse.json({ error: "Invalid user ID" }, { status: 400 });
    }
    
    const user = await db.collection("users").findOne({ _id: objectId });
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }
    
    if (user.email === session.email) {
      return NextResponse.json({ error: "Cannot delete yourself" }, { status: 400 });
    }
    
    await db.collection("users").deleteOne({ _id: objectId });
    
    console.log(`[Platform Admin] User ${session.email} deleted user ${user.email}`);
    
    return NextResponse.json({
      ok: true,
      message: "User deleted successfully",
    });
  } catch (err: any) {
    console.error("Error deleting user:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}
