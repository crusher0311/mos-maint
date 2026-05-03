import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { sessionCookieOptions } from "@/lib/auth";
import {
  deleteSessionByToken,
  findActiveSessionByToken,
} from "@/lib/data/repositories/sessions";

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

    const adminSession = await findActiveSessionByToken(adminToken);

    if (!adminSession) {
      cookieStore.delete("admin_session_token");
      return NextResponse.json({ error: "Admin session expired" }, { status: 401 });
    }

    if (currentToken) {
      await deleteSessionByToken(currentToken, { isImpersonation: true });
    }

    cookieStore.set("session_token", adminToken, sessionCookieOptions(60 * 60 * 8));
    cookieStore.delete("admin_session_token");

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Error exiting ghost mode:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
