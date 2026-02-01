import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";

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
    const userId = params.userId;
    
    const users = await sql`
      SELECT id, email, role, shop_id as "shopId", shop_ids as "shopIds", 
             is_super_admin as "isPlatformAdmin", created_at as "createdAt", last_login as "lastLogin"
      FROM users
      WHERE id = ${userId}
      LIMIT 1
    `;
    
    if (users.length === 0) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }
    
    const user = users[0];
    const userShopIds = [user.shopId, ...(user.shopIds || [])].filter(Boolean);
    const uniqueUserShopIds = [...new Set(userShopIds.map((id: string | number) => String(id)))];
    
    const [allShops, enterprises] = await Promise.all([
      sql`SELECT shop_id as "shopId", name, location_identifier as "locationIdentifier", enterprise_id as "enterpriseId" FROM shops`,
      sql`SELECT id, name, shop_ids as "shopIds" FROM enterprise_accounts`
    ]);
    
    const enterpriseMap = new Map(enterprises.map((e: Record<string, unknown>) => [String(e.id), e]));
    
    const primaryShop = allShops.find((s: Record<string, unknown>) => String(s.shopId) === String(user.shopId));
    const userEnterpriseId = primaryShop?.enterpriseId ? String(primaryShop.enterpriseId) : null;
    const userEnterprise = userEnterpriseId ? enterpriseMap.get(userEnterpriseId) : null;
    
    const enterpriseShopIds = new Set<string>();
    if (userEnterprise && (userEnterprise as Record<string, unknown>).shopIds) {
      for (const sid of (userEnterprise as Record<string, unknown>).shopIds as string[]) {
        enterpriseShopIds.add(String(sid));
      }
    }
    
    const shopMetadata = allShops.map((shop: Record<string, unknown>) => ({
      shopId: String(shop.shopId),
      name: (shop.name as string) || `Shop ${shop.shopId}`,
      locationIdentifier: shop.locationIdentifier || null,
      isInUserEnterprise: enterpriseShopIds.has(String(shop.shopId)),
      isUserPrimary: String(shop.shopId) === String(user.shopId),
      isSelected: uniqueUserShopIds.includes(String(shop.shopId)),
    }));
    
    shopMetadata.sort((a: Record<string, unknown>, b: Record<string, unknown>) => {
      if (a.isUserPrimary && !b.isUserPrimary) return -1;
      if (!a.isUserPrimary && b.isUserPrimary) return 1;
      if (a.isInUserEnterprise && !b.isInUserEnterprise) return -1;
      if (!a.isInUserEnterprise && b.isInUserEnterprise) return 1;
      return (a.name as string).localeCompare(b.name as string);
    });
    
    return NextResponse.json({
      ok: true,
      user: {
        _id: user.id,
        email: user.email,
        role: user.role || "user",
        shopId: user.shopId,
        shopIds: user.shopIds || [],
        isPlatformAdmin: user.isPlatformAdmin || false,
        createdAt: user.createdAt,
        lastLogin: user.lastLogin,
      },
      enterprise: userEnterprise ? {
        _id: (userEnterprise as Record<string, unknown>).id,
        name: (userEnterprise as Record<string, unknown>).name,
        shopIds: ((userEnterprise as Record<string, unknown>).shopIds as string[] || []).map((id: string) => String(id)),
      } : null,
      shops: shopMetadata,
    });
  } catch (err: unknown) {
    console.error("Error fetching user:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error" }, { status: 500 });
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
    const userId = params.userId;
    const body = await request.json();
    
    const existingUsers = await sql`
      SELECT id, email FROM users WHERE id = ${userId} LIMIT 1
    `;
    if (existingUsers.length === 0) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }
    const existingUser = existingUsers[0];
    
    const updateFields: Record<string, unknown> = {};
    
    if (body.role !== undefined) {
      const validRoles = ["owner", "admin", "manager", "user", "viewer"];
      if (!validRoles.includes(body.role)) {
        return NextResponse.json({ error: "Invalid role" }, { status: 400 });
      }
      updateFields.role = body.role;
    }
    
    if (body.shopId !== undefined) {
      updateFields.shop_id = body.shopId;
    }
    
    if (body.shopIds !== undefined) {
      if (!Array.isArray(body.shopIds)) {
        return NextResponse.json({ error: "shopIds must be an array" }, { status: 400 });
      }
      updateFields.shop_ids = body.shopIds;
    }
    
    if (body.isPlatformAdmin !== undefined) {
      updateFields.is_super_admin = Boolean(body.isPlatformAdmin);
    }
    
    if (Object.keys(updateFields).length === 0) {
      return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
    }
    
    updateFields.updated_at = new Date();
    updateFields.updated_by = session.email;
    
    await sql`
      UPDATE users SET ${sql(updateFields)} WHERE id = ${userId}
    `;
    
    console.log(`[Platform Admin] User ${session.email} updated user ${existingUser.email}:`, updateFields);
    
    return NextResponse.json({
      ok: true,
      message: "User updated successfully",
    });
  } catch (err: unknown) {
    console.error("Error updating user:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error" }, { status: 500 });
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
    const userId = params.userId;
    
    const users = await sql`
      SELECT id, email FROM users WHERE id = ${userId} LIMIT 1
    `;
    if (users.length === 0) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }
    const user = users[0];
    
    if (user.email === session.email) {
      return NextResponse.json({ error: "Cannot delete yourself" }, { status: 400 });
    }
    
    await sql`DELETE FROM users WHERE id = ${userId}`;
    
    console.log(`[Platform Admin] User ${session.email} deleted user ${user.email}`);
    
    return NextResponse.json({
      ok: true,
      message: "User deleted successfully",
    });
  } catch (err: unknown) {
    console.error("Error deleting user:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error" }, { status: 500 });
  }
}
