import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const sess = await getSession();
  if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const shopId = String(sess.shopId);

  const users = await sql`
    SELECT id, email, role, shop_id, shop_ids, created_at, is_platform_admin 
    FROM users 
    WHERE shop_id = ${shopId}
    ORDER BY created_at DESC NULLS LAST
  `;

  const pendingInvites = await sql`
    SELECT * FROM setup_tokens 
    WHERE shop_id = ${shopId} AND expires_at > ${new Date()}
    ORDER BY created_at DESC NULLS LAST
  `;

  return NextResponse.json({
    users: users.map(u => ({
      _id: u.id,
      email: u.email,
      role: u.role,
      shopId: u.shop_id,
      shopIds: u.shop_ids,
      createdAt: u.created_at,
      isPlatformAdmin: u.is_platform_admin,
    })),
    pendingInvites: pendingInvites.map(i => ({
      _id: i.id,
      email: i.email,
      role: i.role,
      shopId: i.shop_id,
      createdAt: i.created_at,
      expiresAt: i.expires_at,
    })),
    currentUserRole: sess.role,
  });
}
