import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";

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
    const userResult = await sql`
      SELECT id, email, role, shop_id, shop_ids, created_at, last_login
      FROM users WHERE id = ${userId} LIMIT 1
    `;
    const user = userResult[0];
    
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const userShopId = String(user.shop_id);
    const sessionShopId = String(sess.shopId);

    if (userShopId !== sessionShopId) {
      if (sess.role === "owner") {
        const sessionShopResult = await sql`
          SELECT enterprise_id FROM shops WHERE shop_id = ${sessionShopId} LIMIT 1
        `;
        const userShopResult = await sql`
          SELECT enterprise_id FROM shops WHERE shop_id = ${userShopId} LIMIT 1
        `;
        
        if (!sessionShopResult[0]?.enterprise_id || sessionShopResult[0].enterprise_id !== userShopResult[0]?.enterprise_id) {
          return NextResponse.json({ error: "Cannot view user from another enterprise" }, { status: 403 });
        }
      } else {
        return NextResponse.json({ error: "Cannot view user from another shop" }, { status: 403 });
      }
    }

    const shopIds = [user.shop_id, ...((user.shop_ids as string[]) || [])].filter(Boolean);
    const uniqueShopIds = [...new Set(shopIds.map(id => String(id)))];

    const shops = uniqueShopIds.length > 0 
      ? await sql`SELECT shop_id, name FROM shops WHERE shop_id = ANY(${uniqueShopIds})`
      : [];

    const shopNameMap = new Map(shops.map(s => [String(s.shop_id), s.name]));

    return NextResponse.json({
      ok: true,
      user: {
        _id: user.id,
        email: user.email,
        role: user.role || "user",
        shopId: user.shop_id,
        shopIds: user.shop_ids || [],
        shopNames: uniqueShopIds.map(id => ({
          shopId: id,
          name: shopNameMap.get(id) || `Shop ${id}`,
        })),
        createdAt: user.created_at,
        lastLogin: user.last_login,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Error fetching user:", err);
    return NextResponse.json({ error: message }, { status: 500 });
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
    const body = await req.json();
    
    const userResult = await sql`SELECT * FROM users WHERE id = ${userId} LIMIT 1`;
    const user = userResult[0];
    
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const userShopId = String(user.shop_id);
    const sessionShopId = String(sess.shopId);

    if (userShopId !== sessionShopId) {
      if (sess.role === "owner") {
        const sessionShopResult = await sql`
          SELECT enterprise_id FROM shops WHERE shop_id = ${sessionShopId} LIMIT 1
        `;
        const userShopResult = await sql`
          SELECT enterprise_id FROM shops WHERE shop_id = ${userShopId} LIMIT 1
        `;
        
        if (!sessionShopResult[0]?.enterprise_id || sessionShopResult[0].enterprise_id !== userShopResult[0]?.enterprise_id) {
          return NextResponse.json({ error: "Cannot update user from another enterprise" }, { status: 403 });
        }
      } else {
        return NextResponse.json({ error: "Cannot update user from another shop" }, { status: 403 });
      }
    }

    if (user.role === "owner" && sess.role !== "owner") {
      return NextResponse.json({ error: "Only owners can update owner accounts" }, { status: 403 });
    }

    const updateFields: Record<string, unknown> = {};

    if (body.role !== undefined && sess.role === "owner") {
      const validRoles = ["admin", "manager", "user", "viewer"];
      if (!validRoles.includes(body.role)) {
        return NextResponse.json({ error: "Invalid role" }, { status: 400 });
      }
      updateFields.role = body.role;
    }

    if (body.shopIds !== undefined) {
      if (!Array.isArray(body.shopIds)) {
        return NextResponse.json({ error: "shopIds must be an array" }, { status: 400 });
      }
      
      const requestedShopIds = body.shopIds.map(String);
      
      const sessionShopResult = await sql`
        SELECT enterprise_id FROM shops WHERE shop_id = ${sessionShopId} LIMIT 1
      `;
      const enterpriseId = sessionShopResult[0]?.enterprise_id;
      let allowedShopIds: string[] = [sessionShopId];
      
      if (enterpriseId && sess.role === "owner") {
        const enterpriseShops = await sql`
          SELECT shop_id FROM shops WHERE enterprise_id = ${enterpriseId}
        `;
        allowedShopIds = enterpriseShops.map(s => String(s.shop_id));
      }
      
      const invalidShopIds = requestedShopIds.filter((id: string) => !allowedShopIds.includes(id));
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

    if (updateFields.role) {
      await sql`UPDATE users SET role = ${updateFields.role as string}, updated_at = ${new Date()} WHERE id = ${userId}`;
    }
    if (updateFields.shopIds) {
      await sql`UPDATE users SET shop_ids = ${updateFields.shopIds as string[]}, updated_at = ${new Date()} WHERE id = ${userId}`;
    }

    console.log(`[Settings] User ${sess.email} updated user ${user.email}:`, updateFields);

    return NextResponse.json({
      ok: true,
      message: "User updated successfully",
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Error updating user:", err);
    return NextResponse.json({ error: message }, { status: 500 });
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

  const userResult = await sql`SELECT * FROM users WHERE id = ${userId} LIMIT 1`;
  const user = userResult[0];
  
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const userShopId = String(user.shop_id);
  const sessionShopId = String(sess.shopId);

  if (userShopId !== sessionShopId) {
    if (sess.role === "owner") {
      const sessionShopResult = await sql`
        SELECT enterprise_id FROM shops WHERE shop_id = ${sessionShopId} LIMIT 1
      `;
      const userShopResult = await sql`
        SELECT enterprise_id FROM shops WHERE shop_id = ${userShopId} LIMIT 1
      `;
      
      if (!sessionShopResult[0]?.enterprise_id || sessionShopResult[0].enterprise_id !== userShopResult[0]?.enterprise_id) {
        return NextResponse.json({ error: "Cannot remove user from another enterprise" }, { status: 403 });
      }
    } else {
      return NextResponse.json({ error: "Cannot remove user from another shop" }, { status: 403 });
    }
  }

  if (user.role === "owner") {
    return NextResponse.json({ error: "Cannot remove shop owner" }, { status: 400 });
  }

  await sql`DELETE FROM users WHERE id = ${userId}`;

  console.log(`[Settings] User ${sess.email} deleted user ${user.email}`);

  return NextResponse.json({ ok: true });
}
