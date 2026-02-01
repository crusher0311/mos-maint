import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import sql from "@/lib/db/postgres";

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await requirePlatformAdmin();
    
    const { id } = params;
    const numId = Number(id);
    
    if (isNaN(numId)) {
      return NextResponse.json({ ok: false, error: "Invalid notification ID" }, { status: 400 });
    }

    const body = await req.json();
    
    if (body.read === true) {
      const userResult = await sql`
        SELECT id FROM users WHERE email = ${session.email} LIMIT 1
      `;
      const userId = userResult[0]?.id;
      
      if (!userId) {
        return NextResponse.json({ ok: false, error: "User not found" }, { status: 404 });
      }
      
      const result = await sql`
        UPDATE notifications SET is_read = TRUE
        WHERE id = ${numId} AND user_id = ${userId}
      `;
      return NextResponse.json({ ok: result.count > 0 });
    }

    return NextResponse.json({ ok: false, error: "Invalid update" }, { status: 400 });
  } catch (error: unknown) {
    console.error("Error updating admin notification:", error);
    const errMsg = error instanceof Error ? error.message : "Unknown error";
    if (errMsg === "Unauthorized" || errMsg === "Not a platform admin") {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ ok: false, error: "Failed to update notification" }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await requirePlatformAdmin();
    
    const { id } = params;
    const numId = Number(id);
    
    if (isNaN(numId)) {
      return NextResponse.json({ ok: false, error: "Invalid notification ID" }, { status: 400 });
    }

    const userResult = await sql`
      SELECT id FROM users WHERE email = ${session.email} LIMIT 1
    `;
    const userId = userResult[0]?.id;
    
    if (!userId) {
      return NextResponse.json({ ok: false, error: "User not found" }, { status: 404 });
    }

    const result = await sql`
      DELETE FROM notifications WHERE id = ${numId} AND user_id = ${userId}
    `;
    
    return NextResponse.json({ ok: result.count > 0 });
  } catch (error: unknown) {
    console.error("Error deleting admin notification:", error);
    const errMsg = error instanceof Error ? error.message : "Unknown error";
    if (errMsg === "Unauthorized" || errMsg === "Not a platform admin") {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ ok: false, error: "Failed to delete notification" }, { status: 500 });
  }
}
