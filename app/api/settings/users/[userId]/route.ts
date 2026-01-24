import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import { ObjectId } from "mongodb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: { userId: string } }
) {
  const sess = await getSession();
  if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (sess.role !== "owner" && sess.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { userId } = params;

  try {
    const db = await getDb();
    
    let objectId;
    try {
      objectId = new ObjectId(userId);
    } catch {
      return NextResponse.json({ error: "Invalid user ID" }, { status: 400 });
    }

    const user = await db.collection("users").findOne(
      { _id: objectId },
      { projection: { passwordHash: 0, password: 0 } }
    );
    
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const userShopId = String(user.shopId);
    const sessionShopId = String(sess.shopId);

    if (userShopId !== sessionShopId) {
      if (sess.role === "owner") {
        const sessionShop = await db.collection("shops").findOne({
          shopId: { $in: [sessionShopId, Number(sessionShopId)] }
        });
        const userShop = await db.collection("shops").findOne({
          shopId: { $in: [userShopId, Number(userShopId)] }
        });
        
        if (!sessionShop?.enterpriseId || sessionShop.enterpriseId !== userShop?.enterpriseId) {
          return NextResponse.json({ error: "Cannot view user from another enterprise" }, { status: 403 });
        }
      } else {
        return NextResponse.json({ error: "Cannot view user from another shop" }, { status: 403 });
      }
    }

    const shopIds = [user.shopId, ...(user.shopIds || [])].filter(Boolean);
    const uniqueShopIds = [...new Set(shopIds.map(id => String(id)))];

    const shops = await db.collection("shops")
      .find({ shopId: { $in: uniqueShopIds.map(id => isNaN(Number(id)) ? id : Number(id)) } })
      .project({ shopId: 1, name: 1 })
      .toArray();

    const shopNameMap = new Map(shops.map(s => [String(s.shopId), s.name]));

    return NextResponse.json({
      ok: true,
      user: {
        _id: user._id,
        email: user.email,
        role: user.role || "user",
        shopId: user.shopId,
        shopIds: user.shopIds || [],
        shopNames: uniqueShopIds.map(id => ({
          shopId: id,
          name: shopNameMap.get(id) || `Shop ${id}`,
        })),
        createdAt: user.createdAt,
        lastLogin: user.lastLogin,
        preferences: user.preferences || {},
      },
    });
  } catch (err: any) {
    console.error("Error fetching user:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { userId: string } }
) {
  const sess = await getSession();
  if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (sess.role !== "owner" && sess.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { userId } = params;

  try {
    const db = await getDb();
    const body = await req.json();
    
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

    const userShopId = String(user.shopId);
    const sessionShopId = String(sess.shopId);

    let enterpriseId: string | undefined;
    if (userShopId !== sessionShopId) {
      if (sess.role === "owner") {
        const sessionShop = await db.collection("shops").findOne({
          shopId: { $in: [sessionShopId, Number(sessionShopId)] }
        });
        const userShop = await db.collection("shops").findOne({
          shopId: { $in: [userShopId, Number(userShopId)] }
        });
        
        if (!sessionShop?.enterpriseId || sessionShop.enterpriseId !== userShop?.enterpriseId) {
          return NextResponse.json({ error: "Cannot update user from another enterprise" }, { status: 403 });
        }
        enterpriseId = sessionShop.enterpriseId;
      } else {
        return NextResponse.json({ error: "Cannot update user from another shop" }, { status: 403 });
      }
    }

    if (user.role === "owner" && sess.role !== "owner") {
      return NextResponse.json({ error: "Only owners can update owner accounts" }, { status: 403 });
    }

    const updateFields: Record<string, any> = {};

    if (body.role !== undefined && sess.role === "owner") {
      const validRoles = ["admin", "manager", "user", "viewer"];
      if (!validRoles.includes(body.role)) {
        return NextResponse.json({ error: "Invalid role" }, { status: 400 });
      }
      updateFields.role = body.role;
    }

    if (body.jobHistoryPreferences !== undefined) {
      const jh = body.jobHistoryPreferences;
      
      if (typeof jh.enabled !== "boolean") {
        return NextResponse.json({ error: "jobHistoryPreferences.enabled must be a boolean" }, { status: 400 });
      }
      
      if (!Array.isArray(jh.priorityShopIds)) {
        return NextResponse.json({ error: "jobHistoryPreferences.priorityShopIds must be an array" }, { status: 400 });
      }
      
      updateFields["preferences.jobHistory"] = {
        enabled: jh.enabled,
        priorityShopIds: jh.priorityShopIds.map((id: any) => Number(id)),
        excludeOthers: Boolean(jh.excludeOthers),
      };
    }

    if (body.shopIds !== undefined) {
      if (!Array.isArray(body.shopIds)) {
        return NextResponse.json({ error: "shopIds must be an array" }, { status: 400 });
      }
      
      const requestedShopIds = body.shopIds.map(String);
      
      const sessionUser = await db.collection("users").findOne({ email: sess.email });
      const sessionShop = await db.collection("shops").findOne({ 
        shopId: { $in: [sessionShopId, Number(sessionShopId)] } 
      });
      
      const enterpriseId = sessionShop?.enterpriseId;
      let allowedShopIds: string[] = [sessionShopId];
      
      if (enterpriseId && sess.role === "owner") {
        const enterpriseShops = await db.collection("shops")
          .find({ enterpriseId })
          .project({ shopId: 1 })
          .toArray();
        allowedShopIds = enterpriseShops.map(s => String(s.shopId));
      }
      
      const invalidShopIds = requestedShopIds.filter(id => !allowedShopIds.includes(id));
      if (invalidShopIds.length > 0) {
        return NextResponse.json({ 
          error: "Cannot assign user to shops outside your enterprise" 
        }, { status: 403 });
      }
      
      updateFields.shopIds = requestedShopIds;
    }

    if (Object.keys(updateFields).length === 0) {
      return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
    }

    updateFields.updatedAt = new Date();
    updateFields.updatedBy = sess.email;

    await db.collection("users").updateOne(
      { _id: objectId },
      { $set: updateFields }
    );

    console.log(`[Settings] User ${sess.email} updated user ${user.email}:`, updateFields);

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
  req: NextRequest,
  { params }: { params: { userId: string } }
) {
  const sess = await getSession();
  if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (sess.role !== "owner" && sess.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { userId } = params;

  const db = await getDb();
  const users = db.collection("users");

  const user = await users.findOne({ _id: new ObjectId(userId) });
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const userShopId = String(user.shopId);
  const sessionShopId = String(sess.shopId);

  if (userShopId !== sessionShopId) {
    if (sess.role === "owner") {
      const sessionShop = await db.collection("shops").findOne({
        shopId: { $in: [sessionShopId, Number(sessionShopId)] }
      });
      const userShop = await db.collection("shops").findOne({
        shopId: { $in: [userShopId, Number(userShopId)] }
      });
      
      if (!sessionShop?.enterpriseId || sessionShop.enterpriseId !== userShop?.enterpriseId) {
        return NextResponse.json({ error: "Cannot remove user from another enterprise" }, { status: 403 });
      }
    } else {
      return NextResponse.json({ error: "Cannot remove user from another shop" }, { status: 403 });
    }
  }

  if (user.role === "owner") {
    return NextResponse.json({ error: "Cannot remove shop owner" }, { status: 400 });
  }

  await users.deleteOne({ _id: new ObjectId(userId) });

  console.log(`[Settings] User ${sess.email} deleted user ${user.email}`);

  return NextResponse.json({ ok: true });
}
