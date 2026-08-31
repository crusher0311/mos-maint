import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSession } from "@/lib/auth";
import { findShopByShopId } from "@/lib/data/repositories/shops";

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

    // Resolve the current (impersonated) session through the same active-session
    // path used by dashboard APIs. Never infer the viewed shop from the saved
    // platform-admin cookie.
    const currentSession = await getSession();
    if (!currentSession?.isImpersonation) {
      return NextResponse.json({ isGhostMode: false });
    }

    const shop = await findShopByShopId(currentSession.shopId);

    return NextResponse.json({
      isGhostMode: true,
      adminEmail: currentSession.impersonatedBy,
      shopName: shop?.name || `Shop ${currentSession.shopId}`,
      shopId: currentSession.shopId,
      impersonatingAs: currentSession.email || "Unknown User",
    });
  } catch (error) {
    console.error("Error checking ghost mode:", error);
    return NextResponse.json({ isGhostMode: false });
  }
}
