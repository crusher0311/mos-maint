import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  req: NextRequest,
  { params }: { params: { inviteId: string } }
) {
  const sess = await getSession();
  if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (sess.role !== "owner" && sess.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { inviteId } = params;

  const inviteResult = await sql`
    SELECT * FROM setup_tokens WHERE id = ${inviteId} LIMIT 1
  `;
  const invite = inviteResult[0];
  
  if (!invite) {
    return NextResponse.json({ error: "Invite not found" }, { status: 404 });
  }

  if (invite.shop_id !== String(sess.shopId) && sess.role !== "admin") {
    return NextResponse.json({ error: "Cannot cancel invite from another shop" }, { status: 403 });
  }

  await sql`DELETE FROM setup_tokens WHERE id = ${inviteId}`;

  return NextResponse.json({ ok: true });
}
