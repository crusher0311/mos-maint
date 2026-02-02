import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/mongo";
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

    const db = await getDb();

    const adminSession = await db.collection("sessions").findOne({
      token: adminToken,
      expiresAt: { $gt: new Date() },
    });

    if (!adminSession) {
      cookieStore.delete("admin_session_token");
      return NextResponse.json({ error: "Admin session expired" }, { status: 401 });
    }

    if (currentToken) {
      await db.collection("sessions").deleteOne({
        token: currentToken,
        isImpersonation: true,
      });
    }

    cookieStore.set("session_token", adminToken, sessionCookieOptions(60 * 60 * 8));
    cookieStore.delete("admin_session_token");

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Error exiting ghost mode:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
