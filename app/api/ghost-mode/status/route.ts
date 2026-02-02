import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const cookieStore = await cookies();
    const adminToken = cookieStore.get("admin_session_token")?.value;
    const currentToken = cookieStore.get("session_token")?.value;

    if (!adminToken || !currentToken) {
      return NextResponse.json({ isGhostMode: false });
    }

    const db = await getDb();
    
    const currentSession = await db.collection("sessions").findOne({
      token: currentToken,
      isImpersonation: true,
    });

    if (!currentSession) {
      return NextResponse.json({ isGhostMode: false });
    }

    const shop = await db.collection("shops").findOne({ shopId: currentSession.shopId });
    const user = await db.collection("users").findOne({ _id: currentSession.userId });

    return NextResponse.json({
      isGhostMode: true,
      adminEmail: currentSession.impersonatedBy,
      shopName: shop?.name || `Shop ${currentSession.shopId}`,
      shopId: currentSession.shopId,
      impersonatingAs: user?.email || "Unknown User",
    });
  } catch (error) {
    console.error("Error checking ghost mode:", error);
    return NextResponse.json({ isGhostMode: false });
  }
}
