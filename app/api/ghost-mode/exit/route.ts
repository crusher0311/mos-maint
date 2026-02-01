import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import sql from "@/lib/db/postgres";
import { sessionCookieOptions } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const cookieStore = await cookies();
    const adminToken = cookieStore.get("admin_session_token")?.value;
    const currentToken = cookieStore.get("session_token")?.value;

    if (!adminToken) {
      return NextResponse.json({ error: "No admin session found" }, { status: 400 });
    }

    const adminSessionRows = await sql`
      SELECT * FROM sessions 
      WHERE token = ${adminToken} AND expires_at > NOW()
      LIMIT 1
    `;
    const adminSession = adminSessionRows[0];

    if (!adminSession) {
      cookieStore.delete("admin_session_token");
      return NextResponse.json({ error: "Admin session expired" }, { status: 401 });
    }

    if (currentToken) {
      await sql`
        DELETE FROM sessions 
        WHERE token = ${currentToken} AND is_impersonation = true
      `;
    }

    cookieStore.set("session_token", adminToken, sessionCookieOptions(60 * 60 * 8));
    cookieStore.delete("admin_session_token");

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Error exiting ghost mode:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
