import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Task #271: VIN-based billing/limits removed. setLimit/resetLimit/addViews
// are 410 Gone. resetViews remains as a maintenance utility for clearing the
// running view total displayed in admin views.
export async function POST(
  req: NextRequest,
  { params }: { params: { shopId: string } }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.isPlatformAdmin) {
    return NextResponse.json({ error: "Forbidden - platform admin access required" }, { status: 403 });
  }

  const shopId = Number(params.shopId);
  if (isNaN(shopId)) {
    return NextResponse.json({ error: "Invalid shop ID" }, { status: 400 });
  }

  try {
    const { action } = await req.json();
    const db = await getDb();

    if (action === "resetViews") {
      const result = await db.collection("viewed_vins").deleteMany({
        $or: [{ shopId: shopId }, { shopId: String(shopId) }],
      });
      return NextResponse.json({
        ok: true,
        message: `Reset ${result.deletedCount} viewed VINs`,
      });
    }

    if (action === "setLimit" || action === "resetLimit" || action === "addViews") {
      return NextResponse.json(
        { error: "VIN limits have been removed. VINs are no longer a billing dimension." },
        { status: 410 }
      );
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (err: any) {
    console.error("Shop VIN management error:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}
