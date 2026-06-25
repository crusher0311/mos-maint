import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { computeDataStatus } from "@/lib/data-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Read-only "Data Status" endpoint backing the client Integrations panel and
// the platform-admin per-shop view (task #629).
//
// Scoping: a normal session is locked to its own shop. A platform admin may
// pass `?shopId=` to inspect any shop; for everyone else the param is
// ignored and we fall back to the caller's own shop, so a client can never
// read another shop's data status.
export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const requestedShopId = req.nextUrl.searchParams.get("shopId");
    let shopId = Number(session.shopId);

    if (requestedShopId) {
      if (!session.isPlatformAdmin) {
        return NextResponse.json(
          { error: "Forbidden" },
          { status: 403 },
        );
      }
      const parsed = Number(requestedShopId);
      if (!Number.isFinite(parsed)) {
        return NextResponse.json(
          { error: "Invalid shopId" },
          { status: 400 },
        );
      }
      shopId = parsed;
    }

    if (!Number.isFinite(shopId)) {
      return NextResponse.json(
        { error: "No shop associated with this session" },
        { status: 400 },
      );
    }

    const status = await computeDataStatus(shopId);
    return NextResponse.json(status);
  } catch (err: any) {
    console.error("[DataStatus] Error:", err);
    return NextResponse.json(
      { error: err?.message || "Failed to load data status" },
      { status: 500 },
    );
  }
}
